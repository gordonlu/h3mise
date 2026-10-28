import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempRoot, makeProject, makeShotWithPrompt, makeStore } from './helpers.js';
import { Ffmpeg } from '../src/ffmpeg.js';
import { createTake, getTake } from '../src/modules/takes.js';
import { analyzeTakeVideo, prepareTakeReview } from '../src/modules/video-analysis.js';

const roots: string[] = [];
after(() => { for (const root of roots) cleanupTempRoot(root); });

test('Take video analysis caches filmstrip and scene results by source file', async () => {
  const { root, store } = await makeStore('video-analysis');
  roots.push(root);
  const project = await makeProject(store, 'Video analysis');
  const shot = makeShotWithPrompt(project);
  const ffmpeg = new class extends Ffmpeg {
    decodeCalls = 0;
    override async verifyDecode(input: string): Promise<void> {
      this.decodeCalls++;
      await super.verifyDecode(input);
    }
  }();
  const takeDir = project.paths.shotTakes(shot.shotId);
  await mkdir(takeDir, { recursive: true });
  const source = join(takeDir, 'analysis-source.mp4');
  await ffmpeg.syntheticVideo(source, 1, 'Analysis', '640x360');
  const jobId = 'job-analysis-test';
  const now = new Date().toISOString();
  project.db.run(
    `INSERT INTO render_jobs (id, project_id, shot_id, prompt_version_id, provider, status, request_snapshot_json, render_intent_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'mock', 'LOCAL_READY', '{}', 'analysis', ?, ?)`,
    [jobId, project.meta.id, shot.shotId, shot.promptVersionId, now, now],
  );
  const take = await createTake(project, {
    shotId: shot.shotId,
    renderJobId: jobId,
    promptVersionId: shot.promptVersionId,
    directorPlanVersionId: null,
    localVideoPath: `shots/${shot.shotId}/takes/analysis-source.mp4`,
    duration: 1,
  });

  const first = await analyzeTakeVideo(project, ffmpeg, take.id);
  const cached = await analyzeTakeVideo(project, ffmpeg, take.id);
  assert.ok(first.frames.length >= 4);
  assert.equal(first.frames.length, cached.frames.length);
  assert.equal(first.generatedAt, cached.generatedAt);
  assert.equal(first.sceneCuts[0], 0);
  assert.equal(first.suitability.level, 'good');

  const before = getTake(project, take.id);
  const evidence = await prepareTakeReview(project, ffmpeg, take.id);
  assert.equal(evidence.technical.decode, 'passed');
  assert.equal(evidence.visualInspectionRequired, true);
  assert.equal(evidence.cached, false);
  const sheetInfo = await ffmpeg.probe(evidence.contactSheet.absolutePath);
  assert.equal(sheetInfo.width, 1920);
  assert.equal(sheetInfo.height, 540);
  const replay = await prepareTakeReview(project, ffmpeg, take.id);
  assert.equal(replay.cached, true);
  assert.equal(replay.generatedAt, evidence.generatedAt);
  const concurrent = await Promise.all([prepareTakeReview(project, ffmpeg, take.id), prepareTakeReview(project, ffmpeg, take.id)]);
  assert.ok(concurrent.every(result => result.cached));
  assert.equal(ffmpeg.decodeCalls, 1, 'cached concurrent calls do not repeatedly decode the source');
  assert.deepEqual(getTake(project, take.id), before, 'evidence never changes selection or review');
  await assert.rejects(ffmpeg.verifyDecode(join(takeDir, 'missing.mp4')));
  await assert.rejects(prepareTakeReview(project, ffmpeg, '../../escape'), /take not found/);
});
