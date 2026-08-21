import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDirectorPlan } from '@h3mise/shared';
import { createPlanVersion, normalizeDirectorPlan, parseDirectorPlanText, planIsGuideReady } from '../src/modules/director.js';
import { createShot } from '../src/modules/shots.js';
import { cleanupTempRoot, makeProject, makeStore } from './helpers.js';

const roots: string[] = [];
after(() => { for (const root of roots) cleanupTempRoot(root); });

test('guided shot design requires only the four essential director answers', () => {
  const plan = emptyDirectorPlan();
  assert.equal(planIsGuideReady(plan), false);

  plan.intent.visualThesis = 'MISE appears small in the empty projection room';
  plan.subject.action = 'MISE slowly raises its head';
  plan.camera.dominantBehavior = 'medium shot, slow push in';
  plan.intent.endState = 'hold on MISE looking at the stopped clock';

  assert.equal(planIsGuideReady(plan), true);
});

test('advanced director settings are optional for the guided flow', () => {
  const plan = emptyDirectorPlan();
  plan.intent.visualThesis = 'A quiet, lonely room';
  plan.subject.action = 'MISE looks up';
  plan.camera.dominantBehavior = 'locked medium shot';
  plan.intent.endState = 'MISE holds still';
  plan.blocking.travelPath = '';
  plan.performance.objective = '';
  plan.environment.lighting = '';

  assert.equal(planIsGuideReady(plan), true);
});

test('external DirectorPlan parser accepts minimal YAML inside a markdown fence', () => {
  const parsed = parseDirectorPlanText(`\`\`\`yaml
intent:
  visual_thesis: quiet projection room
  end_state: MISE looks at the clock
subject:
  action: MISE raises its head
camera:
  dominant_behavior: slow push in
\`\`\``);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.plan?.intent.visualThesis, 'quiet projection room');
  assert.equal(parsed.plan?.camera.dominantBehavior, 'slow push in');
  assert.equal(parsed.plan ? planIsGuideReady(parsed.plan) : false, true);
});

test('AI DirectorPlan normalization accepts wrappers and snake_case but drops invalid values', () => {
  const normalized = normalizeDirectorPlan({
    director_plan: {
      intent: { visual_thesis: '孤独的放映室', end_state: '角色望向时钟', unknown: 'discard me' },
      subject: { action: '角色缓慢抬头' },
      camera: { dominant_behavior: '中景缓慢推近' },
      reality: { mode: 'not_a_mode', constraints: ['保持重力', 123] },
      generation: { duration_seconds: 'five' },
    },
  });

  assert.equal(normalized.ok, true);
  assert.equal(normalized.plan?.intent.visualThesis, '孤独的放映室');
  assert.equal(normalized.plan?.camera.dominantBehavior, '中景缓慢推近');
  assert.equal(normalized.plan?.reality.mode, 'strict_realism');
  assert.deepEqual(normalized.plan?.reality.constraints, ['保持重力']);
  assert.equal(normalized.plan?.generation.durationSeconds, 5);
  assert.equal('unknown' in (normalized.plan?.intent ?? {}), false);
});

test('saved DirectorPlan inherits shot-owned function, mode, duration, and aspect ratio', async () => {
  const { root, store } = await makeStore('director-shot-settings');
  roots.push(root);
  const project = await makeProject(store, 'director shot settings');
  const shot = createShot(project, {
    title: 'Reference shot',
    shotFunction: 'reaction',
    h3Mode: 'ref2va',
    durationSeconds: 8,
    aspectRatio: '9:16',
  });
  const plan = emptyDirectorPlan();
  plan.intent.shotFunction = 'wide';
  plan.generation.requestedMode = 't2va';
  plan.generation.durationSeconds = 3;
  plan.generation.aspectRatio = '16:9';

  const saved = createPlanVersion(project, { shotId: shot.id, plan, source: 'manual' });

  assert.equal(saved.plan.intent.shotFunction, 'reaction');
  assert.equal(saved.plan.generation.requestedMode, 'ref2va');
  assert.equal(saved.plan.generation.durationSeconds, 8);
  assert.equal(saved.plan.generation.aspectRatio, '9:16');
});
