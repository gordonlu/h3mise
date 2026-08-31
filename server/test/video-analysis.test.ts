import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempRoot, makeProject, makeShotWithPrompt, makeStore } from './helpers.js';
import { Ffmpeg } from '../src/ffmpeg.js';
import { createTake } from '../src/modules/takes.js';
import { analyzeTakeVideo } from '../src/modules/video-analysis.js';

const roots: string[] = [];
after(() => { for (const root of roots) cleanupTempRoot(root); });

test('Take video analysis caches filmstrip and scene results by source file', async () => {
  const { root, store } = await makeStore('video-analysis');
  roots.push(root);
  const project = await makeProject(store, 'Video analysis');
  const shot = makeShotWithPrompt(project);
  const ffmpeg = new Ffmpeg();
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
});
