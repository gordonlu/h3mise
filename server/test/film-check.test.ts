import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupTempRoot, fakeTake, makeProject, makeStore } from './helpers.js';
import { createShot } from '../src/modules/shots.js';
import { importRawPrompt } from '../src/modules/prompt.js';
import { selectTake } from '../src/modules/takes.js';
import { addClip } from '../src/modules/timeline.js';
import { EventBus } from '../src/events.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runFilmCheck } from '../src/modules/film-check.js';

const roots: string[] = [];
after(() => roots.forEach((root) => cleanupTempRoot(root)));

test('film check blocks a missing take instead of exporting a partial film', async () => {
  const { root, store } = await makeStore('film-check'); roots.push(root);
  const project = await makeProject(store, 'film-check');
  const shot = createShot(project, { title: '未完成镜头' });
  const report = await runFilmCheck(project);
  assert.equal(report.canExport, false);
  assert.ok(report.errors.some((issue) => issue.code === 'shot.no-takes' && issue.target.kind === 'shot' && issue.target.shotId === shot.id));
  assert.ok(report.errors.some((issue) => issue.code === 'timeline.empty'));
});

test('film check allows a partial Timeline while warning about drafts and omitted selected shots', async () => {
  const { root, store } = await makeStore('film-check-partial'); roots.push(root);
  const project = await makeProject(store, 'film-check-partial');
  createShot(project, { title: '留作草稿的镜头' });
  const included = createShot(project, { title: '当前导出镜头' });
  const omitted = createShot(project, { title: '已完成但本次不导出' });
  for (const shot of [included, omitted]) {
    const prompt = importRawPrompt(project, shot.id, `Prompt for ${shot.title}`, 't2va');
    const take = await fakeTake(project, shot.id, prompt.id, shot.id);
    const absolute = project.resolveProjectPath(take.localVideoPath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, 'video');
    selectTake(project, take.id, new EventBus());
    if (shot.id === included.id) addClip(project, { shotId: shot.id, takeId: take.id });
  }
  const report = await runFilmCheck(project);
  assert.equal(report.canExport, true, JSON.stringify(report));
  assert.ok(report.warnings.some((issue) => issue.code === 'shot.no-takes'));
  assert.ok(report.warnings.some((issue) => issue.code === 'shot.not-on-timeline'));
  assert.equal(report.errors.length, 0);
});
