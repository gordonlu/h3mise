import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { cleanupTempRoot, makeProject, makeStore } from './helpers.js';
import { Ffmpeg } from '../src/ffmpeg.js';
import { createShot } from '../src/modules/shots.js';
import { importRawPrompt } from '../src/modules/prompt.js';
import { createTake, selectTake } from '../src/modules/takes.js';
import { addClip, exportTimeline } from '../src/modules/timeline.js';
import { importUpload } from '../src/modules/media.js';
import { getProjectAudio, updateProjectAudio } from '../src/modules/shot-production.js';
import { EventBus } from '../src/events.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const roots: string[] = [];
after(() => roots.forEach((root) => cleanupTempRoot(root)));
const exec = promisify(execFile);

async function bandMeanDb(file: string, frequency: number): Promise<number> {
  const { stderr } = await exec('ffmpeg', ['-hide_banner', '-i', file, '-af', `bandpass=f=${frequency}:width_type=h:w=12,volumedetect`, '-f', 'null', '-']);
  return Number(stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/)?.[1] ?? NaN);
}

test('project BGM and ducking are applied once during Timeline export', async () => {
  const { root, store } = await makeStore('project-audio');
  roots.push(root);
  const project = await makeProject(store, 'Project audio');
  const ffmpeg = new Ffmpeg();
  const shot = createShot(project, { title: 'One', durationSeconds: 1 });
  const prompt = importRawPrompt(project, shot.id, 'A single test take.', 't2va');
  const jobId = 'job-audio';
  project.db.run("INSERT INTO render_jobs (id, project_id, shot_id, prompt_version_id, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'mock', 'LOCAL_READY', datetime('now'), datetime('now'))", [jobId, project.meta.id, shot.id, prompt.id]);
  const relVideo = `shots/${shot.id}/takes/audio.mp4`;
  await mkdir(project.paths.shotTakes(shot.id), { recursive: true });
  await ffmpeg.syntheticVideo(project.resolveProjectPath(relVideo), 1, 'Audio', '640x360');
  const take = await createTake(project, { shotId: shot.id, renderJobId: jobId, promptVersionId: prompt.id, directorPlanVersionId: null, localVideoPath: relVideo, duration: 1 }, ffmpeg);
  selectTake(project, take.id, new EventBus());
  addClip(project, { shotId: shot.id, takeId: take.id });
  const bgmPath = join(project.paths.assets, 'bgm.wav');
  await mkdir(project.paths.assets, { recursive: true });
  await ffmpeg.runRaw(['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1', bgmPath]);
  const bgm = await importUpload(project, ffmpeg, { fileName: 'bgm.wav', mimeType: 'audio/wav', data: await readFile(bgmPath) });
  updateProjectAudio(project, { bgmAssetId: bgm.id, bgmGainDb: -18, duckingEnabled: true, duckingGainDb: -9 });
  assert.equal(getProjectAudio(project).bgmAssetId, bgm.id);
  const result = await exportTimeline(project, ffmpeg, 'bgm-test');
  const probe = await ffmpeg.probe(result.path);
  assert.equal(probe.hasAudio, true);
  assert.ok(Math.abs((probe.durationSeconds ?? 0) - 1) < 0.2);
  assert.equal(project.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM takes')?.n, 1, 'export never creates a Take or a silent variant');
  const offPath = join(root, 'duck-off.mp4');
  const onPath = join(root, 'duck-on.mp4');
  await ffmpeg.mixProjectBgm(project.resolveProjectPath(relVideo), bgmPath, offPath, 1, { bgmGainDb: -18, duckingEnabled: false, duckingGainDb: -9 });
  await ffmpeg.mixProjectBgm(project.resolveProjectPath(relVideo), bgmPath, onPath, 1, { bgmGainDb: -18, duckingEnabled: true, duckingGainDb: -9 });
  const offBgm = await bandMeanDb(offPath, 220);
  const onBgm = await bandMeanDb(onPath, 220);
  assert.ok(Number.isFinite(offBgm) && Number.isFinite(onBgm));
  assert.ok(onBgm < offBgm - 2, `ducking should reduce BGM: off=${offBgm}dB on=${onBgm}dB`);
  assert.ok(Number.isFinite(await bandMeanDb(onPath, 440)), 'dialogue frequency remains present');
});
