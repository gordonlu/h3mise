import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { cleanupTempRoot, makeProject, makeStore } from './helpers.js';
import { createShot, getShot } from '../src/modules/shots.js';
import { createBinding, createEntity, insertMedia, updateBinding } from '../src/modules/assets.js';
import { compilePrompt } from '../src/modules/prompt.js';
import { runBasicPreflight } from '../src/modules/preflight.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { Ffmpeg } from '../src/ffmpeg.js';
import { updateShotProduction } from '../src/modules/shot-production.js';
import { cctvSegmentOffsetSeconds } from '../src/modules/timeline.js';

const roots: string[] = [];
after(() => roots.forEach((root) => cleanupTempRoot(root)));

async function image(project: Awaited<ReturnType<typeof makeProject>>, name: string, width = 640, height = 360) {
  const fileName = `assets/${name}.png`;
  const absolute = project.resolveProjectPath(fileName);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, 'image');
  return insertMedia(project, { kind: 'image', fileName, mimeType: 'image/png', sizeBytes: 5, width, height, label: name });
}

function registryFor(store: Awaited<ReturnType<typeof makeStore>>['store'], root: string) {
  const registry = new ProviderRegistry(() => store.current, () => store.registry, new Ffmpeg(), null, 'mock', undefined, join(root, 'mock'));
  registry.refresh();
  return registry;
}

test('empty Ref2VA Shot keeps canonical narrative and passes Mock preflight', async () => {
  const { root, store } = await makeStore('review-empty-shot');
  roots.push(root);
  const project = await makeProject(store, 'Empty Shot');
  project.config.default_provider = 'mock';
  const shot = createShot(project, { title: '空镜头但有明确镜头名', aspectRatio: '16:9', durationSeconds: 6, h3Mode: 'ref2va' });
  const asset = await image(project, 'room');
  createBinding(project, { assetId: asset.id, shotId: shot.id, roles: ['environment'], referenceUse: 'scene_plate', framePolicy: 'reference_only' });
  const prompt = compilePrompt(project, shot.id, 'ref2va');
  assert.ok(prompt.text.includes('Shot: 空镜头但有明确镜头名'));
  const report = await runBasicPreflight(project, registryFor(store, root), { shotId: shot.id, promptVersionId: prompt.id, providerId: 'mock' });
  assert.equal(report.blocked, false, JSON.stringify(report.basic));
});

test('multiple identity references for one target entity compile as one Subject without changing multi-character behavior', async () => {
  const { root, store } = await makeStore('review-subject-group');
  roots.push(root);
  const project = await makeProject(store, 'Subject group');
  const maud = createEntity(project, { kind: 'character', name: 'Maud' });
  const ethan = createEntity(project, { kind: 'character', name: 'Ethan' });
  const shot = createShot(project, { title: 'Identity group', primaryCharacterId: maud.id, h3Mode: 'ref2va' });
  const face = await image(project, 'maud-face');
  const body = await image(project, 'maud-body');
  const other = await image(project, 'ethan-face');
  createBinding(project, { assetId: face.id, shotId: shot.id, roles: ['identity'], targetEntityId: maud.id, referenceUse: 'face', label: 'Maud face' });
  createBinding(project, { assetId: body.id, shotId: shot.id, roles: ['identity'], targetEntityId: maud.id, referenceUse: 'full_body', label: 'Maud body' });
  createBinding(project, { assetId: other.id, shotId: shot.id, roles: ['identity'], targetEntityId: ethan.id, referenceUse: 'face', label: 'Ethan face' });
  const prompt = compilePrompt(project, shot.id, 'ref2va');
  const definitions = prompt.text.split('retention_analysis:')[0]!;
  assert.ok(definitions.includes('<Subject 1> 是 Maud face；这是同一人物，只出现一次'));
  assert.ok(definitions.includes('<Picture 1>、<Picture 2>'));
  assert.ok(definitions.includes('<Subject 2> 是 Ethan face，其外观以 <Picture 3> 为准'));
  assert.ok(prompt.text.includes('画面中的人物集合严格等于以下 2 位'));
});

test('audio retention follows fully_copy and audio policy changes invalidate the final Prompt', async () => {
  const { root, store } = await makeStore('review-audio-policy');
  roots.push(root);
  const project = await makeProject(store, 'Audio policy');
  project.config.default_provider = 'mock';
  const shot = createShot(project, { title: 'Audio', durationSeconds: 6, h3Mode: 'ref2va' });
  const visual = await image(project, 'visual');
  const binding = createBinding(project, { assetId: visual.id, shotId: shot.id, roles: ['identity'], referenceUse: 'full_body', framePolicy: 'reference_only' });
  const fileName = 'assets/voice.wav';
  await writeFile(project.resolveProjectPath(fileName), 'voice');
  const audio = insertMedia(project, { kind: 'audio', fileName, mimeType: 'audio/wav', sizeBytes: 5, durationSeconds: 6, label: 'voice' });
  const audioBinding = createBinding(project, { assetId: audio.id, shotId: shot.id, roles: ['audio'], audioPolicy: { mode: 'fully_copy', startSeconds: 0, endSeconds: 6 } });
  updateShotProduction(project, shot.id, { audio: { mode: 'reference_audio', dialogue: [] } });
  const prompt = compilePrompt(project, shot.id, 'ref2va');
  assert.ok(prompt.text.includes('<Audio 1>（voice）: fully_copy'));
  assert.ok(!prompt.text.includes('<Audio 1>（voice）: reference -'));
  updateBinding(project, audioBinding.id, { audioPolicy: { mode: 'reference', startSeconds: 0, endSeconds: 6 } });
  const report = await runBasicPreflight(project, registryFor(store, root), { shotId: shot.id, promptVersionId: prompt.id, providerId: 'mock' });
  assert.ok(report.basic.flatMap((section) => section.checks).some((check) => check.key === 'prompt.reference_order' && check.severity === 'error'));
  assert.ok(binding.id);
});

test('project creation honors an explicit Mock default provider', async () => {
  const { root, store } = await makeStore('review-project-provider');
  roots.push(root);
  const meta = await store.create({ title: 'Mock default', format: 'single_shot', defaultProvider: 'mock' });
  const project = await store.open(meta.id);
  assert.equal(project.config.default_provider, 'mock');
});

test('continuous CCTV timecode accumulates durations and only time_jump adds the form jump', async () => {
  const { root, store } = await makeStore('review-cctv-offset');
  roots.push(root);
  const project = await makeProject(store, 'CCTV offsets');
  const first = createShot(project, { title: 'A', durationSeconds: 6 });
  const second = createShot(project, { title: 'B', durationSeconds: 6 });
  updateShotProduction(project, first.id, { segment: { groupId: 'cam-a', kind: 'continuous', index: 1, count: 2, timeJumpSeconds: 0, frameSkip: 1 } });
  updateShotProduction(project, second.id, { segment: { groupId: 'cam-a', kind: 'continuous', index: 2, count: 2, timeJumpSeconds: 10, frameSkip: 3 } });
  assert.equal(cctvSegmentOffsetSeconds(project, getShot(project, second.id)), 6, JSON.stringify({ first: getShot(project, first.id).production.segment, second: getShot(project, second.id).production.segment }));
  updateShotProduction(project, second.id, { segment: { groupId: 'cam-a', kind: 'time_jump', index: 2, count: 2, timeJumpSeconds: 10, frameSkip: 3 } });
  assert.equal(cctvSegmentOffsetSeconds(project, getShot(project, second.id)), 16);
});

test('built-in Mock reports a verified offline provider instead of unconfigured', async () => {
  const { root, store } = await makeStore('review-mock-status');
  roots.push(root);
  await makeProject(store, 'Mock status');
  const statuses = await registryFor(store, root).statuses();
  const mock = statuses.find((provider) => provider.id === 'mock');
  assert.equal(mock?.configured, true);
  assert.equal(mock?.verification.status, 'verified');
});
