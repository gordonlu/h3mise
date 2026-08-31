import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupTempRoot, makeProject, makeStore } from './helpers.js';
import { createShot } from '../src/modules/shots.js';
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
