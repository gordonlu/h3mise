import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { cleanupTempRoot, makeProject, makeStore } from './helpers.js';
import { Ffmpeg } from '../src/ffmpeg.js';
import { createShot, getShot } from '../src/modules/shots.js';
import type { Shot } from '@h3mise/shared';
import { importRawPrompt } from '../src/modules/prompt.js';
import { createTake, selectTake } from '../src/modules/takes.js';
import { addClip, exportTimeline, renderLookPreview } from '../src/modules/timeline.js';
import { updateShotProduction } from '../src/modules/shot-production.js';
import { cctvFontFile, cctvVideoFilters } from '../src/modules/cctv.js';
import { EventBus } from '../src/events.js';
import type { ProjectContext } from '../src/project-store.js';

const roots: string[] = [];
const exec = promisify(execFile);
after(() => roots.forEach((root) => cleanupTempRoot(root)));

async function makeSelectedClip(project: ProjectContext, ffmpeg: Ffmpeg, shot: Shot) {
  const prompt = importRawPrompt(project, shot.id, `Prompt for ${shot.title}`, 't2va');
  const jobId = `job-${shot.id}`;
  project.db.run("INSERT INTO render_jobs (id, project_id, shot_id, prompt_version_id, provider, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'mock', 'LOCAL_READY', datetime('now'), datetime('now'))", [jobId, project.meta.id, shot.id, prompt.id]);
  const relVideo = `shots/${shot.id}/takes/source.mp4`;
  await ffmpeg.syntheticVideo(project.resolveProjectPath(relVideo), shot.durationSeconds, '', '640x360');
  const take = await createTake(project, { shotId: shot.id, renderJobId: jobId, promptVersionId: prompt.id, directorPlanVersionId: null, localVideoPath: relVideo, duration: shot.durationSeconds }, ffmpeg);
  selectTake(project, take.id, new EventBus());
  return { take, clip: addClip(project, { shotId: shot.id, takeId: take.id, trimIn: 0.5 }) };
}

test('CCTV Timeline export burns overlay, frame-accurate trim timecode and shared preview filters', async () => {
  const { root, store } = await makeStore('cctv-export');
  roots.push(root);
  const project = await makeProject(store, 'CCTV export');
  const ffmpeg = new Ffmpeg();
  const shot = createShot(project, { title: 'CCTV', durationSeconds: 2, aspectRatio: '16:9' });
  updateShotProduction(project, shot.id, {
    cctv: { enabled: true, cameraLabel: 'CAM 04', location: 'Ancient hall', startTime: '2026-01-01T08:00:00', showRec: true, lowResolution: true, dotMatrix: true, blurUpscale: false },
  });
  const { clip } = await makeSelectedClip(project, ffmpeg, shot);
  const current = getShot(project, shot.id);
  const filters = cctvVideoFilters(current.production.cctv, current.production.segment, { trimInSeconds: 0.5, width: 640, height: 360, fps: 24 });
  assert.ok(filters.some((filter) => filter.includes('08\\:00\\:00\\:12')));
  const fontFile = cctvFontFile();
  if (fontFile) {
    const localized = cctvVideoFilters({ ...current.production.cctv, location: '宫殿回廊' }, current.production.segment, { trimInSeconds: 0.5, width: 640, height: 360, fps: 24, fontFile });
    assert.ok(localized.some((filter) => filter.includes('fontfile=') && filter.includes('宫殿回廊')));
  }
  const preview = await renderLookPreview(project, ffmpeg, clip.id, 'none', 1);
  assert.ok((await readFile(project.resolveProjectPath(preview.relPath))).length > 1000);
  const result = await exportTimeline(project, ffmpeg, 'cctv');
  const info = await ffmpeg.probe(result.path);
  assert.ok(Math.abs((info.durationSeconds ?? 0) - 1.5) < 0.2);
  const framePath = `${result.path}.jpg`;
  await ffmpeg.previewFrame(result.path, framePath, 0.5);
  assert.ok((await readFile(framePath)).length > 1000);
  assert.equal(project.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM takes')?.n, 1, 'CCTV export must not create or overwrite a Take');
});

test('surveillance frame skip preserves editorial duration while reducing decoded frames', async () => {
  const { root, store } = await makeStore('cctv-skip');
  roots.push(root);
  const project = await makeProject(store, 'CCTV skip');
  const ffmpeg = new Ffmpeg();
  const shot = createShot(project, { title: 'Skip', durationSeconds: 2, aspectRatio: '16:9' });
  updateShotProduction(project, shot.id, {
    cctv: { enabled: true, cameraLabel: 'CAM 04', location: 'Gate', startTime: '2026-01-01T08:00:00', showRec: true, lowResolution: false, dotMatrix: false, blurUpscale: true },
    segment: { groupId: 'camera-a', kind: 'surveillance_skip', index: 2, count: 2, timeJumpSeconds: 0, frameSkip: 3 },
  });
  await makeSelectedClip(project, ffmpeg, shot);
  const result = await exportTimeline(project, ffmpeg, 'cctv-skip');
  const info = await ffmpeg.probe(result.path);
  assert.ok(Math.abs((info.durationSeconds ?? 0) - 1.5) < 0.25, JSON.stringify(info));
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'default=nokey=1:noprint_wrappers=1', result.path]);
  const frames = Number(stdout.trim());
  assert.ok(frames > 0 && frames <= 20, `expected sampled frames, got ${frames}`);
});
