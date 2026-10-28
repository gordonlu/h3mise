// Inference delegation: prepare/apply protocol for external-agent inference.
// The delegated path must work with NO configured project AI — the agent
// brings its own model — while keeping the same validation and atomic apply.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { emptyDirectorPlan } from '@h3mise/shared';
import { AIService } from '../src/modules/ai.js';
import { applyResult, agentStatus, cancelRequest, countPending, detachAgent, getRequest, listRequests, prepareRequest, touchAgent } from '../src/modules/ai-delegation.js';
import { createPlanVersion, latestPlan, listPlanVersions } from '../src/modules/director.js';
import { createPrompt, importRawPrompt, listPrompts } from '../src/modules/prompt.js';
import { createShot } from '../src/modules/shots.js';
import { listBeats, updateStory } from '../src/modules/story.js';
import { cleanupTempRoot, makeProject, makeStore, type ProjectContext } from './helpers.js';

const roots: string[] = [];
after(() => roots.forEach((root) => cleanupTempRoot(root)));

/** No baseUrl/apiKey/model: delegation must never need the project's AI. */
function offlineAi(): AIService {
  return new AIService({ baseUrl: null, apiKey: null, model: null }, null);
}

async function project(tag: string): Promise<ProjectContext> {
  const { root, store } = await makeStore(tag);
  roots.push(root);
  const p = await makeProject(store, tag);
  updateStory(p, { title: '测试故事', synopsis: '一句话梗概', body: '第一幕：主角在雨夜走进小巷。第二幕：他推开木门。' });
  return p;
}

test('prepare builds the inference payload without any configured AI', async () => {
  const p = await project('ai-deleg-prepare');
  const ai = offlineAi();
  const prepared = await prepareRequest(ai, p, 'story_to_beats', {}, null);
  assert.match(prepared.requestId, /^aireq-\d+$/);
  assert.equal(prepared.step.json, true);
  assert.equal(prepared.step.temperature, 0.7);
  assert.ok(prepared.step.system.includes('StoryBeats'));
  assert.ok(JSON.stringify(prepared.step.messages).includes('测试故事'));
  assert.equal(prepared.contextHash.length, 64);
  assert.equal(countPending(p), 1);
  const listed = listRequests(p, 'pending');
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.action, 'story_to_beats');
  assert.equal(listed[0]!.source, 'agent');
});

test('apply validates and atomically creates beats from the agent answer', async () => {
  const p = await project('ai-deleg-apply');
  const ai = offlineAi();
  const prepared = await prepareRequest(ai, p, 'story_to_beats', {}, null);
  const beats = [
    { title: '雨夜入巷', summary: '主角走进雨夜小巷', durationSeconds: 12 },
    { title: '推门', summary: '他推开木门', durationSeconds: 8 },
  ];
  const outcome = await applyResult(ai, p, prepared.requestId, JSON.stringify(beats), null);
  assert.equal(outcome.status, 'applied');
  if (outcome.status === 'applied') {
    const result = outcome.result as { kind: string; beats: unknown[] };
    assert.equal(result.kind, 'beats');
    assert.equal(result.beats.length, 2);
  }
  assert.equal(listBeats(p).length, 2);
  assert.equal(countPending(p), 0);
  assert.equal(getRequest(p, prepared.requestId)?.status, 'applied');

  // Idempotent: re-applying a completed request never touches project data again.
  const replay = await applyResult(ai, p, prepared.requestId, JSON.stringify([{ title: '别的', summary: '不应生效' }]), null);
  assert.equal(replay.status, 'applied');
  assert.equal(listBeats(p).length, 2);
  assert.ok(!listBeats(p).some((beat) => beat.title === '别的'));
});

test('apply rejects a stale request when the project changed after prepare', async () => {
  const p = await project('ai-deleg-stale');
  const ai = offlineAi();
  const prepared = await prepareRequest(ai, p, 'story_to_beats', {}, null);
  updateStory(p, { body: '正文在 prepare 之后被修改了。' });
  await assert.rejects(
    () => applyResult(ai, p, prepared.requestId, '[]', null),
    (error: unknown) => (error as { code?: string }).code === 'stale',
  );
  assert.equal(getRequest(p, prepared.requestId)?.status, 'stale');
});

test('malformed plan output requests a repair round before applying', async () => {
  const p = await project('ai-deleg-repair');
  const ai = offlineAi();
  const shot = createShot(p, { title: '修复测试', durationSeconds: 5 });
  const prepared = await prepareRequest(ai, p, 'plan_shot', { shotId: shot.id }, 'test-model');

  const invalid = await applyResult(ai, p, prepared.requestId, JSON.stringify({ camera: { dominantBehavior: 42 } }), null);
  assert.equal(invalid.status, 'continue');
  if (invalid.status === 'continue') assert.ok(invalid.step.system.includes('修复器'));

  const base = emptyDirectorPlan();
  const valid = {
    intent: { ...base.intent, visualThesis: '雨夜压迫感', endState: '门被推开' },
    subject: { ...base.subject, action: '主角推门' },
    camera: { ...base.camera, dominantBehavior: '缓慢推近' },
  };
  const done = await applyResult(ai, p, prepared.requestId, JSON.stringify(valid), null);
  assert.equal(done.status, 'applied');
  if (done.status === 'applied') {
    const result = done.result as { kind: string; plan: { intent: { visualThesis: string } } };
    assert.equal(result.kind, 'director_plan');
    assert.equal(result.plan.intent.visualThesis, '雨夜压迫感');
  }
});

test('brief_to_plan parses a brief into a plan draft (delegated)', async () => {
  const p = await project('ai-deleg-brief');
  const ai = offlineAi();
  const shot = createShot(p, { title: '简报测试', durationSeconds: 6 });
  const prepared = await prepareRequest(ai, p, 'brief_to_plan', { shotId: shot.id, brief: '中景固定机位，缓慢推近，主角抬头。' }, null);
  assert.equal(prepared.step.json, true);
  assert.ok(JSON.stringify(prepared.step.messages).includes('简报'));

  // An empty brief is rejected before any inference is requested.
  await assert.rejects(
    () => prepareRequest(ai, p, 'brief_to_plan', { shotId: shot.id, brief: '   ' }, null),
    /brief is empty/,
  );

  // Malformed answer → repair round, exactly like plan_shot.
  const invalid = await applyResult(ai, p, prepared.requestId, JSON.stringify({}), null);
  assert.equal(invalid.status, 'continue');
  if (invalid.status === 'continue') assert.ok(invalid.step.system.includes('修复器'));

  const base = emptyDirectorPlan();
  const valid = {
    intent: { ...base.intent, visualThesis: '孤独感', endState: '抬头望钟' },
    subject: { ...base.subject, action: '缓慢抬头' },
    camera: { ...base.camera, dominantBehavior: '缓慢推近' },
  };
  const done = await applyResult(ai, p, prepared.requestId, JSON.stringify(valid), null);
  assert.equal(done.status, 'applied');
  if (done.status === 'applied') {
    const result = done.result as { kind: string; plan: { camera: { dominantBehavior: string } } };
    assert.equal(result.kind, 'director_plan');
    assert.equal(result.plan.camera.dominantBehavior, '缓慢推近');
  }
});

test('auto_director runs its multi-round pipeline through delegation', async () => {
  const p = await project('ai-deleg-auto');
  const ai = offlineAi();
  const prepared = await prepareRequest(ai, p, 'auto_director', {}, null);
  assert.equal(prepared.step.json, true);

  const beats = JSON.stringify([
    { title: '入巷', summary: '主角走进雨夜小巷', durationSeconds: 10 },
    { title: '推门', summary: '他推开木门', durationSeconds: 8 },
  ]);
  const round1 = await applyResult(ai, p, prepared.requestId, beats, null);
  assert.equal(round1.status, 'continue');

  const base = emptyDirectorPlan();
  const plan = (thesis: string) => ({
    intent: { ...base.intent, visualThesis: thesis, endState: '结束画面' },
    subject: { ...base.subject, action: '连续动作' },
    camera: { ...base.camera, dominantBehavior: '缓慢推近' },
  });

  let outcome = await applyResult(ai, p, prepared.requestId, JSON.stringify(plan('第一镜')), null);
  assert.equal(outcome.status, 'continue');
  outcome = await applyResult(ai, p, prepared.requestId, JSON.stringify(plan('第二镜')), null);
  assert.equal(outcome.status, 'applied');
  if (outcome.status === 'applied') {
    const result = outcome.result as { kind: string; created: unknown[]; shotsCreated: number };
    assert.equal(result.kind, 'auto_director_result');
    assert.equal(result.shotsCreated, 2);
    assert.equal(result.created.length, 2);
  }
  assert.equal(listBeats(p).length, 2);
});

test('propose_project normalizes a malformed proposal defensively', async () => {
  const p = await project('ai-deleg-propose');
  const ai = offlineAi();
  const prepared = await prepareRequest(ai, p, 'propose_project', {}, null);
  assert.equal(prepared.step.json, true);
  const done = await applyResult(ai, p, prepared.requestId, JSON.stringify({
    title: '雨夜旧居',
    format: 'film',
    aspectRatio: 'wide',
    plannedDurationSeconds: 999999,
    synopsis: '一个男人雨夜回到旧居。',
    body: '第一幕：主角走进雨夜小巷。',
  }), null);
  assert.equal(done.status, 'applied');
  if (done.status === 'applied') {
    const result = done.result as { kind: string; proposal: { title: string; format: string; aspectRatio: string; plannedDurationSeconds: number } };
    assert.equal(result.kind, 'project_proposal');
    assert.equal(result.proposal.title, '雨夜旧居');
    assert.equal(result.proposal.format, p.config.format);
    assert.equal(result.proposal.aspectRatio, p.config.default_aspect_ratio);
    assert.equal(result.proposal.plannedDurationSeconds, 3600);
  }
});

test('unknown requests and actions fail with explicit codes', async () => {
  const p = await project('ai-deleg-errors');
  const ai = offlineAi();
  await assert.rejects(
    () => applyResult(ai, p, 'aireq-999', 'x', null),
    (error: unknown) => (error as { code?: string }).code === 'not_found',
  );
  await assert.rejects(() => prepareRequest(ai, p, 'not_an_action', {}, null), /unknown action/);
});

test('agent presence tracks attach, activity, and detach', async () => {
  detachAgent();
  assert.equal(agentStatus(null).attached, false);
  touchAgent('deepseek-v4');
  const attached = agentStatus(null);
  assert.equal(attached.attached, true);
  assert.equal(attached.modelLabel, 'deepseek-v4');
  assert.ok(attached.lastSeenAt);
  detachAgent();
  assert.equal(agentStatus(null).attached, false);
  assert.equal(agentStatus(null).modelLabel, null);

  // A delegated prepare refreshes presence with the declared model label.
  const p = await project('ai-deleg-presence');
  detachAgent();
  await prepareRequest(offlineAi(), p, 'story_to_beats', {}, 'test-model');
  assert.equal(agentStatus(p).attached, true);
  assert.equal(agentStatus(p).modelLabel, 'test-model');
  assert.equal(agentStatus(p).pending, 1);
  detachAgent();
});

test('pending requests can be cancelled; completed ones cannot', async () => {
  const p = await project('ai-deleg-cancel');
  const ai = offlineAi();
  const prepared = await prepareRequest(ai, p, 'story_to_beats', {}, null);
  const cancelled = cancelRequest(p, prepared.requestId);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(countPending(p), 0);
  // A cancelled request must not accept a late agent answer.
  await assert.rejects(
    () => applyResult(ai, p, prepared.requestId, '[]', null),
    (error: unknown) => (error as { code?: string }).code === 'cancelled',
  );

  const completed = await prepareRequest(ai, p, 'story_to_beats', {}, null);
  const outcome = await applyResult(ai, p, completed.requestId, JSON.stringify([{ title: 'A', summary: 'B' }]), null);
  assert.equal(outcome.status, 'applied');
  assert.throws(() => cancelRequest(p, completed.requestId), (error: unknown) => (error as { code?: string }).code === 'not_pending');
  detachAgent();
});

test('persist saves a validated plan once with a replayable version receipt', async () => {
  const p = await project('ai-deleg-persist-plan');
  const ai = offlineAi();
  const shot = createShot(p, { title: '中景', durationSeconds: 8 });
  const prepared = await prepareRequest(ai, p, 'plan_shot', { shotId: shot.id }, 'external-agent');
  const base = emptyDirectorPlan();
  const plan = {
    intent: { ...base.intent, visualThesis: '晨光', endState: '望向湖面' },
    subject: { ...base.subject, action: '缓缓行走' },
    camera: { ...base.camera, dominantBehavior: '固定机位' },
  };
  const outcome = await applyResult(ai, p, prepared.requestId, plan, null, true);
  assert.equal(outcome.status, 'applied');
  if (outcome.status !== 'applied') return;
  const saved = outcome.result as { saved: { directorPlanVersionId: string } };
  assert.equal(saved.saved.directorPlanVersionId, latestPlan(p, shot.id)?.id);
  assert.equal(listPlanVersions(p, shot.id).length, 1);
  const replay = await applyResult(ai, p, prepared.requestId, {}, null, true);
  assert.deepEqual(replay, outcome);
  assert.equal(listPlanVersions(p, shot.id).length, 1);
});

test('persisted prompt retains mode, plan linkage and idempotent receipt', async () => {
  const p = await project('ai-deleg-persist-prompt');
  const ai = offlineAi();
  const shot = createShot(p, { title: '中景', durationSeconds: 8 });
  importRawPrompt(p, shot.id, 'A singer walks by the lake.', 'ref2va');
  const prepared = await prepareRequest(ai, p, 'compile_prompt', { shotId: shot.id }, null);
  const outcome = await applyResult(ai, p, prepared.requestId, 'A singer walks slowly by the lake, medium shot.', null, true);
  assert.equal(outcome.status, 'applied');
  if (outcome.status !== 'applied') return;
  const saved = outcome.result as { saved: { promptVersionId: string } };
  assert.equal(saved.saved.promptVersionId, listPrompts(p, shot.id).at(-1)?.id);
  assert.equal(listPrompts(p, shot.id).at(-1)?.h3Mode, 'ref2va');
  assert.equal(listPrompts(p, shot.id).length, 2);
  assert.deepEqual(await applyResult(ai, p, prepared.requestId, 'ignored', null, true), outcome);
  assert.equal(listPrompts(p, shot.id).length, 2);
});

test('preview-only apply remains compatible and creates no plan version', async () => {
  const p = await project('ai-deleg-preview');
  const ai = offlineAi();
  const shot = createShot(p, { title: '预览', durationSeconds: 5 });
  const prepared = await prepareRequest(ai, p, 'plan_shot', { shotId: shot.id }, null);
  const base = emptyDirectorPlan();
  const outcome = await applyResult(ai, p, prepared.requestId, {
    intent: { ...base.intent, visualThesis: '晨光', endState: '停步' },
    subject: { ...base.subject, action: '行走' },
    camera: { ...base.camera, dominantBehavior: '固定' },
  }, null);
  assert.equal(outcome.status, 'applied');
  assert.equal(listPlanVersions(p, shot.id).length, 0);
});

test('plan version rolls back if its applied receipt cannot be written', async () => {
  const p = await project('ai-deleg-rollback');
  const ai = offlineAi();
  const shot = createShot(p, { title: '原子保存', durationSeconds: 5 });
  const prepared = await prepareRequest(ai, p, 'plan_shot', { shotId: shot.id }, null);
  const base = emptyDirectorPlan();
  const plan = { intent: { ...base.intent, visualThesis: '湖畔', endState: '停步' },
    subject: { ...base.subject, action: '行走' }, camera: { ...base.camera, dominantBehavior: '固定' } };
  p.db.run("CREATE TRIGGER reject_receipt BEFORE UPDATE ON ai_requests WHEN NEW.status = 'applied' BEGIN SELECT RAISE(ABORT, 'test receipt failure'); END");
  await assert.rejects(applyResult(ai, p, prepared.requestId, plan, null, true), /test receipt failure/);
  assert.equal(listPlanVersions(p, shot.id).length, 0);
  assert.equal(getRequest(p, prepared.requestId)?.status, 'pending');
  p.db.run('DROP TRIGGER reject_receipt');
  assert.equal((await applyResult(ai, p, prepared.requestId, plan, null, true)).status, 'applied');
  assert.equal(listPlanVersions(p, shot.id).length, 1);
});

test('prompt repair preserves the source plan and take revision provenance', async () => {
  const p = await project('ai-deleg-repair-link');
  const ai = offlineAi();
  const shot = createShot(p, { title: '修复', durationSeconds: 5 });
  const original = createPlanVersion(p, { shotId: shot.id, plan: emptyDirectorPlan(), source: 'external_ai' });
  const source = createPrompt(p, { shotId: shot.id, text: 'Original prompt', h3Mode: 'i2va', source: 'manual',
    directorPlanVersionId: original.id, revisionReason: 'Keep the medium framing', preservedAspects: ['wardrobe'] });
  createPlanVersion(p, { shotId: shot.id, plan: emptyDirectorPlan(), source: 'external_ai' });
  const prepared = await prepareRequest(ai, p, 'repair_prompt', { promptId: source.id, problems: 'Clarify motion' }, null);
  assert.equal((await applyResult(ai, p, prepared.requestId, 'Repaired prompt', null, true)).status, 'applied');
  const repaired = listPrompts(p, shot.id).at(-1)!;
  assert.equal(repaired.directorPlanVersionId, original.id);
  assert.equal(repaired.h3Mode, 'i2va');
  assert.equal(repaired.revisionReason, source.revisionReason);
  assert.deepEqual(repaired.preservedAspects, ['wardrobe']);
});
