// Preflight gate tests — P0-2: the gate runs on the EXACT render intent
// (client overrides included), never on shot defaults, and the intent hash
// is deterministic and stable.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, makeProject, makeShotWithPrompt, cleanupTempRoot } from './helpers.js';
import { attachSemanticReview, renderIntentHash, intentFromInput, runBasicPreflightIntent } from '../src/modules/preflight.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { createBinding, insertMedia } from '../src/modules/assets.js';
import { importRawPrompt } from '../src/modules/prompt.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Ffmpeg } from '../src/ffmpeg.js';
import type { Db } from '../src/db/sqlite.js';

const roots: string[] = [];
after(() => { for (const r of roots) cleanupTempRoot(r); });

function makeRegistry(registryDb: Db) {
  const r = new ProviderRegistry(() => null, () => registryDb, new Ffmpeg(), null, 'mock');
  r.refresh();
  return r;
}

test('renderIntentHash is deterministic and input-sensitive', () => {
  const base = {
    shotId: 'shot-001',
    promptVersionId: 'prompt-001',
    providerId: 'mock',
    mode: 't2va' as const,
    durationSeconds: 5,
    aspectRatio: '16:9',
    references: [
      { bindingId: 'b-2', assetId: 'a-2', kind: 'image' as const },
      { bindingId: 'b-1', assetId: 'a-1', kind: 'image' as const },
    ],
    providerParams: { b: 1, a: 2 },
  };
  const ref = { appId: 'app', checkedAt: '2026-01-01T00:00:00.000Z' };
  const h1 = renderIntentHash(base, ref);
  const h2 = renderIntentHash({ ...base, references: [...base.references].reverse() }, ref); // order-insensitive
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{16}$/);
  // duration override MUST change the hash (that is the paid-gate invariant)
  assert.notEqual(h1, renderIntentHash({ ...base, durationSeconds: 6 }, ref));
  assert.notEqual(h1, renderIntentHash({ ...base, megapixels: 1 }, ref));
  // provider profile ref must participate
  assert.notEqual(h1, renderIntentHash(base, { appId: 'app2', checkedAt: ref.checkedAt }));
});

test('gate accepts only the workflow-safe megapixel presets', async () => {
  const { root, store } = await makeStore('preflight-megapixels');
  roots.push(root);
  const p = await makeProject(store, 'megapixels');
  const { shotId, promptVersionId } = makeShotWithPrompt(p, 't2va');
  const registry = makeRegistry(store.registry);

  const accepted = await intentFromInput(p, registry, { shotId, promptVersionId, providerId: 'mock', megapixels: 1.2 });
  assert.equal((await runBasicPreflightIntent(p, registry, accepted)).blocked, false);

  const rejected = await intentFromInput(p, registry, { shotId, promptVersionId, providerId: 'mock', megapixels: 1.24 });
  const report = await runBasicPreflightIntent(p, registry, rejected);
  assert.equal(report.blocked, true);
  assert.ok(report.basic.find((section) => section.key === 'provider')?.checks.some((check) => check.key === 'provider.megapixels' && check.severity === 'error'));
});

test('gate blocks duration overrides that bypass shot defaults', async () => {
  const { root, store } = await makeStore('preflight');
  roots.push(root);
  const p = await makeProject(store, 'gate');
  const { shotId, promptVersionId } = makeShotWithPrompt(p, 't2va');
  p.config.default_duration_seconds = 3; // shot default says 3s
  const registry = makeRegistry(store.registry);

  // Client overrides duration to 100s via the request body — the gate must
  // evaluate the INTENT (100s), not the shot default (3s).
  const intent = await intentFromInput(p, registry, { shotId, promptVersionId, providerId: 'mock', durationSeconds: 100 });
  assert.equal(intent.durationSeconds, 100);
  const report = await runBasicPreflightIntent(p, registry, intent);
  const dur = report.basic.find((s) => s.key === 'duration');
  assert.ok(dur!.checks.some((c) => c.severity === 'error' && c.key.startsWith('duration.')));
  assert.equal(report.blocked, true);

  const requested = await intentFromInput(p, registry, { shotId, promptVersionId, providerId: 'mock', durationSeconds: 5 });
  const requestedReport = await runBasicPreflightIntent(p, registry, requested);
  assert.ok(requestedReport.basic.find((s) => s.key === 'duration')?.checks.some((c) => c.key === 'duration.override'));
});

test('an active job is a queue warning, not a prompt-blocking error', async () => {
  const { root, store } = await makeStore('preflight-queue-revision');
  roots.push(root);
  const p = await makeProject(store, 'queue-revision');
  const { shotId, promptVersionId } = makeShotWithPrompt(p, 't2va');
  p.db.run(
    `INSERT INTO render_jobs (id, project_id, shot_id, prompt_version_id, director_plan_version_id, provider, status, request_snapshot_json, render_intent_hash, created_at, updated_at)
     VALUES ('job-active', ?, ?, ?, NULL, 'mock', 'RUNNING', '{}', 'h', datetime('now'), datetime('now'))`,
    [p.meta.id, shotId, promptVersionId],
  );
  const registry = makeRegistry(store.registry);
  const intent = await intentFromInput(p, registry, { shotId, promptVersionId, providerId: 'mock' });
  const report = await runBasicPreflightIntent(p, registry, intent);
  const duplicate = report.basic.find((section) => section.key === 'duplicate');
  assert.ok(duplicate?.checks.some((check) => check.key === 'duplicate.active' && check.severity === 'warning'));
  assert.equal(report.blocked, false);
});

test('gate blocks unknown provider capabilities (P0-6)', async () => {
  const { root, store } = await makeStore('preflight');
  roots.push(root);
  const p = await makeProject(store, 'cap');
  const { shotId, promptVersionId } = makeShotWithPrompt(p, 't2va');
  // registry holds mock provider with full caps; simulate an UNVERIFIED
  // runninghub by requesting the runninghub id — registry has none → blocked
  const registry = makeRegistry(store.registry);
  const intent = await intentFromInput(p, registry, { shotId, promptVersionId, providerId: 'runninghub' });
  const report = await runBasicPreflightIntent(p, registry, intent);
  assert.equal(report.blocked, true);
  const prov = report.basic.find((s) => s.key === 'provider');
  assert.ok(prov!.checks.some((c) => c.severity === 'error'));
});

test('gate passes for a valid mock render (full caps, in-range duration)', async () => {
  const { root, store } = await makeStore('preflight');
  roots.push(root);
  const p = await makeProject(store, 'ok');
  const { shotId, promptVersionId } = makeShotWithPrompt(p, 't2va');
  const registry = makeRegistry(store.registry);
  const intent = await intentFromInput(p, registry, { shotId, promptVersionId, providerId: 'mock', durationSeconds: 3 });
  const report = await runBasicPreflightIntent(p, registry, intent);
  assert.equal(report.blocked, false);
});

test('gate blocks a compiler prompt that dropped the shot narrative', async () => {
  const { root, store } = await makeStore('preflight-narrative');
  roots.push(root);
  const p = await makeProject(store, 'narrative');
  const { shotId, promptVersionId } = makeShotWithPrompt(p, 't2va');
  p.db.run(
    "UPDATE prompt_versions SET source = 'deterministic_compiler', text = ? WHERE id = ?",
    ['integrated_multimodal_description:\nReality: strict realism', promptVersionId],
  );
  const registry = makeRegistry(store.registry);
  const intent = await intentFromInput(p, registry, { shotId, promptVersionId, providerId: 'mock' });
  const report = await runBasicPreflightIntent(p, registry, intent);

  assert.equal(report.blocked, true);
  assert.ok(report.basic.find((section) => section.key === 'prompt')?.checks.some((check) => check.key === 'prompt.missing_narrative'));
});

test('AI continuity result is attached to the existing preflight report', async () => {
  const { root, store } = await makeStore('preflight-semantic');
  roots.push(root);
  const p = await makeProject(store, 'semantic');
  const { shotId, promptVersionId } = makeShotWithPrompt(p, 't2va');
  const registry = makeRegistry(store.registry);
  const intent = await intentFromInput(p, registry, { shotId, promptVersionId, providerId: 'mock' });
  const basic = await runBasicPreflightIntent(p, registry, intent);

  const combined = attachSemanticReview(p, basic.id, '无上一镜头，本项不适用。\n结论：通过');

  assert.equal(combined.id, basic.id);
  assert.equal(combined.aiSemanticRun, true);
  assert.equal(combined.semantic?.[0]?.label, 'AI 连续性');
  assert.equal(combined.semantic?.[0]?.status, 'ok');
});

test('faceswap preflight requires exactly one face image and one source video', async () => {
  const { root, store } = await makeStore('preflight-faceswap');
  roots.push(root);
  const p = await makeProject(store, 'faceswap');
  const { shotId, promptVersionId } = makeShotWithPrompt(p, 'faceswap');
  const registry = makeRegistry(store.registry);

  const intent = await intentFromInput(p, registry, { shotId, promptVersionId, providerId: 'mock', mode: 'faceswap' });
  const report = await runBasicPreflightIntent(p, registry, intent);
  const keys = report.basic.flatMap((section) => section.checks).map((check) => check.key);
  assert.equal(report.blocked, true);
  assert.ok(keys.includes('ref.video.required'));
  assert.ok(keys.includes('ref.image.required'));
  assert.ok(keys.includes('provider.mode.ok'), 'mock declares faceswap for offline testing');
});

test('audio reuse / fully_copy wording never determines the preflight outcome', async () => {
  const { root, store } = await makeStore('preflight-audio-reuse');
  roots.push(root);
  const p = await makeProject(store, 'audio-reuse');
  const { shotId } = makeShotWithPrompt(p, 'ref2va');
  const fileName = 'assets/voice.mp3';
  const absolute = p.resolveProjectPath(fileName);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, 'audio');
  const asset = insertMedia(p, { kind: 'audio', fileName, mimeType: 'audio/mpeg', sizeBytes: 5, durationSeconds: 5, source: 'import', label: 'voice' });
  createBinding(p, { assetId: asset.id, roles: ['audio'], shotId, label: 'voice' });
  const imageName = 'assets/face.png';
  const imageAbsolute = p.resolveProjectPath(imageName);
  await mkdir(dirname(imageAbsolute), { recursive: true });
  await writeFile(imageAbsolute, 'image');
  const image = insertMedia(p, { kind: 'image', fileName: imageName, mimeType: 'image/png', sizeBytes: 5, source: 'import', label: 'face' });
  createBinding(p, { assetId: image.id, roles: ['identity'], shotId, label: 'face' });
  const prompt = importRawPrompt(p, shotId, 'audio reuse, fully_copy, aspect ratio 1:1. Keep the exact vocal.', 'ref2va');
  const registry = makeRegistry(store.registry);
  const intent = await intentFromInput(p, registry, { shotId, promptVersionId: prompt.id, providerId: 'mock', aspectRatio: '1:1' });
  const report = await runBasicPreflightIntent(p, registry, intent);
  const audioChecks = report.basic.flatMap((section) => section.checks).filter((check) => check.key.startsWith('ref.audio.reuse'));
  assert.ok(audioChecks.some((check) => check.key === 'ref.audio.reuse.unknown' && check.severity === 'info'));
  assert.ok(!audioChecks.some((check) => check.key === 'ref.audio.reuse.exact'));
  assert.equal(report.blocked, false);
});
