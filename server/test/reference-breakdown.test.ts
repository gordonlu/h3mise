import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { stat, readFile } from 'node:fs/promises';
import { cleanupTempRoot, makeProject, makeStore } from './helpers.js';
import { Ffmpeg } from '../src/ffmpeg.js';
import { importUpload } from '../src/modules/media.js';
import { insertMedia, listBindings } from '../src/modules/assets.js';
import { createShot, getShot, listShots } from '../src/modules/shots.js';
import { createPlanVersion, latestPlan } from '../src/modules/director.js';
import { emptyDirectorPlan, describeCameraPlan, emptyCameraPlan } from '@h3mise/shared';
import { AIService } from '../src/modules/ai.js';
import { analyzeReference, applyReferenceDirection, detectBreakdown, getBreakdown, normalizeDirection, prepareReference, saveSegments, validateRange } from '../src/modules/reference-breakdown.js';

after(() => cleanupTempRoot());
test('range validation rejects non-finite, reversed and out-of-source intervals', () => {
  for (const [a, b] of [[-1, 1], [1, 1], [2, 1], [0, Infinity], [NaN, 1], [0, 4]]) assert.throws(() => validateRange(a!, b!, 3));
  validateRange(0, 3, 3);
});

test('local breakdown persists edits, cuts and outputs; AI applies only direction, never identities', async () => {
  const { store } = await makeStore('reference-breakdown');
  const p = await makeProject(store, 'Reference regression');
  const ffmpeg = new Ffmpeg();
  const path = p.resolveProjectPath('assets/source.mp4');
  await ffmpeg.runRaw(['-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=25:d=1', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=25:d=1', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path]);
  const asset = await importUpload(p, ffmpeg, { fileName: 'reference.mp4', mimeType: 'video/mp4', data: await readFile(path) });
  assert.equal(asset.kind, 'video');
  assert.ok(asset.posterPath);
  const doc = await detectBreakdown(p, ffmpeg, asset.id);
  assert.equal(doc.fps, 25);
  assert.ok(doc.cuts.some(t => Math.abs(t - 1) < .1));
  assert.equal(doc.segments.length, 2);
  assert.ok(doc.frames.length >= 6);
  const saved = saveSegments(p, asset.id, [{ id: 'merged', start: .2, end: 1.8, label: 'Merged' }], doc.revision);
  assert.equal((await detectBreakdown(p, ffmpeg, asset.id)).segments[0]!.label, 'Merged');
  assert.throws(() => saveSegments(p, asset.id, doc.segments, doc.revision), /其他窗口/);
  assert.throws(() => saveSegments(p, asset.id, [{ id: 'a', label: 'A', start: 0, end: 1 }, { id: 'b', label: 'B', start: .5, end: 2 }], saved.revision), /重叠/);
  const result = await prepareReference(p, ffmpeg, asset.id, { start: .2, end: .8, output: 'shot', use: 'motion' });
  assert.equal(result.assets.length, 3);
  assert.equal(result.shot!.durationSeconds, 1);
  assert.equal(listShots(p).length, 1);
  assert.equal(listBindings(p, result.shot!.id)[0]!.type, 'video');
  assert.deepEqual(listBindings(p, result.shot!.id)[0]!.preserve, ['body motion', 'timing']);
  const probe = await ffmpeg.probe(p.resolveProjectPath(result.assets[0]!.fileName));
  assert.ok(Math.abs(probe.durationSeconds! - .6) < .1);
  for (const a of result.assets) assert.ok((await stat(p.resolveProjectPath(a.fileName))).size > 0);
  assert.ok((await stat(path)).size > 0);

  const shot = createShot(p, { title: 'Own scene', durationSeconds: 5 });
  const plan = emptyDirectorPlan();
  plan.subject.primarySubject = 'My character'; plan.environment.location = 'My location'; plan.intent.dramaticGoal = 'My goal';
  createPlanVersion(p, { shotId: shot.id, plan, source: 'manual' });
  const ai = new AIService({ baseUrl: null, apiKey: null, model: null }, null);
  await assert.rejects(analyzeReference(p, ffmpeg, ai, asset.id, 0, .8), /未配置/);
  let imageCount = 0;
  ai.model = {
    complete: async () => '',
    structured: async <T>(input: import('../src/modules/ai.js').DirectorInput) => {
      imageCount = Array.isArray(input.messages[0]!.content) ? input.messages[0]!.content.length - 1 : 0;
      return { action: 'turn', camera: 'static', blocking: 'left to center', shotSize: 'full shot', composition: 'centered', screenDirection: 'left_to_right', cameraSuggestion: 'push_in', beats: [{ id: 'b', label: 'turn', start: 0, end: 1 }], assessment: ['Motion is inferred from sampled frames'] } as T;
    },
  };
  await analyzeReference(p, ffmpeg, ai, asset.id, 0, .8);
  assert.equal(imageCount, 6);
  assert.throws(() => applyReferenceDirection(p, asset.id, shot.id, { start: .1, end: .8 }), /范围已改变/);
  applyReferenceDirection(p, asset.id, shot.id, { start: 0, end: .8 });
  const updated = latestPlan(p, shot.id)!;
  assert.equal(updated.version, 2);
  assert.equal(updated.plan.subject.primarySubject, 'My character');
  assert.equal(updated.plan.environment.location, 'My location');
  assert.equal(updated.plan.intent.dramaticGoal, 'My goal');
  assert.equal(updated.plan.camera.dominantBehavior, 'static');
  assert.equal(updated.plan.temporalBeats.length, 1);
  assert.equal(getShot(p, shot.id).screenDirection, 'left_to_right');
  const current = getBreakdown(p, asset.id)!;
  saveSegments(p, asset.id, current.segments, current.revision);
  assert.throws(() => applyReferenceDirection(p, asset.id, shot.id, { start: 0, end: .8 }), /请先分析/);
  ai.model.structured = async <T>(input: import('../src/modules/ai.js').DirectorInput) => { input.onVisionStatus?.({ mode: 'text_fallback', imageCount: 6 }); return {} as T; };
  await assert.rejects(analyzeReference(p, ffmpeg, ai, asset.id, 0, .8), /无法读取/);
});

test('direction normalization and camera compiler expose bounded, meaningful intent', () => {
  assert.equal(normalizeDirection({ screenDirection: 'unsupported', assessment: [4, 'possible cut'] }).screenDirection, 'neutral');
  const plan = emptyCameraPlan();
  plan.startFraming = { x: 0, y: .15, w: .7, h: .7 };
  plan.endFraming = { x: .3, y: .15, w: .7, h: .7 };
  assert.match(describeCameraPlan(plan), /right/);
  assert.match(describeCameraPlan(plan), /not a 3D/);
});
