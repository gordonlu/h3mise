import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { recommendedStoryboardPanelCount } from '@h3mise/shared';
import { cleanupTempRoot, makeProject, makeStore, makeTempRoot } from './helpers.js';
import { createEntity, insertMedia, listBindings } from '../src/modules/assets.js';
import { createBeat, updateStory } from '../src/modules/story.js';
import { createShot, listShots } from '../src/modules/shots.js';
import { approveStoryboard, buildStoryboardPrompt, prepareStoryboard } from '../src/modules/storyboard.js';
import { Ffmpeg } from '../src/ffmpeg.js';

const roots: string[] = [];
after(() => roots.forEach((root) => cleanupTempRoot(root)));

test('narrative segment count deterministically recommends 3, 6, or 9 panels', () => {
  assert.equal(recommendedStoryboardPanelCount(1), 3);
  assert.equal(recommendedStoryboardPanelCount(3), 3);
  assert.equal(recommendedStoryboardPanelCount(4), 6);
  assert.equal(recommendedStoryboardPanelCount(6), 6);
  assert.equal(recommendedStoryboardPanelCount(7), 9);
  assert.equal(recommendedStoryboardPanelCount(12), 9);
});

test('text storyboard is free, persistent, and protects creature descriptions', async () => {
  const { root, store } = await makeStore('storyboard-plan');
  roots.push(root);
  const project = await makeProject(store, 'Good Boy');
  updateStory(project, {
    plannedDurationSeconds: 30,
    synopsis: 'Olivia arrives. Ben challenges her. Newton performs the commands. Newton outsmarts the humans at the end.',
  });
  createEntity(project, { kind: 'creature', name: 'Newton', description: 'black-and-white border collie' });

  const board = prepareStoryboard(project);
  assert.equal(board.panelCount, 6);
  assert.equal(board.panels.length, 6);
  assert.equal(board.status, 'draft');
  assert.equal(board.activeJob, null);
  assert.equal(project.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM storyboard_jobs')?.n, 0);
  assert.match(buildStoryboardPrompt(project, board), /do not invent clothing or a hairstyle/i);
  assert.match(buildStoryboardPrompt(project, board), /fixed 3-column by 2-row grid/i);
});

test('more than nine narrative segments become ordered free storyboard pages', async () => {
  const { root, store } = await makeStore('storyboard-pages');
  roots.push(root);
  const project = await makeProject(store, 'Long Story');
  updateStory(project, {
    plannedDurationSeconds: 80,
    body: Array.from({ length: 11 }, (_, index) => `Segment ${index + 1}.`).join(' '),
  });

  const first = prepareStoryboard(project);
  const rows = project.db.all<{ id: string; page_number: number; panel_count: number; source_start_index: number; source_end_index: number }>(
    'SELECT id, page_number, panel_count, source_start_index, source_end_index FROM storyboards WHERE series_id = ? ORDER BY page_number',
    [first.seriesId],
  );
  assert.equal(first.pageNumber, 1);
  assert.equal(first.totalPages, 2);
  assert.deepEqual(rows.map((row) => [row.page_number, row.panel_count, row.source_start_index, row.source_end_index]), [
    [1, 9, 0, 9],
    [2, 3, 9, 11],
  ]);
  assert.equal(project.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM storyboard_jobs')?.n, 0);
});

test('a new storyboard series cannot hide an active paid generation job', async () => {
  const { root, store } = await makeStore('storyboard-active-job');
  roots.push(root);
  const project = await makeProject(store, 'Active Storyboard');
  const board = prepareStoryboard(project, 3);
  const now = new Date().toISOString();
  project.db.run(
    "INSERT INTO storyboard_jobs (id, storyboard_id, kind, status, created_at, updated_at) VALUES (?, ?, 'sheet', 'RUNNING', ?, ?)",
    ['job-running', board.id, now, now],
  );
  assert.throws(() => prepareStoryboard(project, 3), /正在进行/);
  assert.equal(project.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM storyboards')?.n, 1);
});

test('approving a storyboard atomically connects panels to shots and visual references', async () => {
  const { root, store } = await makeStore('storyboard-sync');
  roots.push(root);
  const project = await makeProject(store, 'Storyboard Sync');
  const beat = createBeat(project, { title: 'Opening', summary: 'A person enters', durationSeconds: 4 });
  const existingShot = createShot(project, { title: 'Opening', storyBeatId: beat.id, purpose: 'A person enters', h3Mode: 't2va' });
  const board = prepareStoryboard(project, 3);
  for (const panel of board.panels) {
    const asset = insertMedia(project, {
      kind: 'image', fileName: `assets/panel-${panel.order}.png`, mimeType: 'image/png', sizeBytes: 1, label: `Panel ${panel.order}`,
    });
    project.db.run('UPDATE storyboard_panels SET asset_id = ? WHERE id = ?', [asset.id, panel.id]);
  }
  const approved = approveStoryboard(project, board.id);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.sync?.shotsCreated, 2);
  assert.equal(approved.sync?.shotsUpdated, 1);
  assert.equal(approved.sync?.bindingsCreated, 3);
  const shots = listShots(project);
  assert.equal(shots.length, 3);
  assert.ok(shots.every((shot) => shot.h3Mode === 'ref2va'));
  assert.ok(shots.some((shot) => shot.id === existingShot.id), 'a pristine Beat-linked Shot is reused');
  assert.ok(shots.every((shot) => listBindings(project, shot.id).some((binding) => binding.roles.includes('style'))));
  const repeated = approveStoryboard(project, board.id);
  assert.equal(repeated.sync?.shotsCreated, 0);
  assert.equal(listShots(project).length, 3, 'reapproval is idempotent');
});

test('FFmpeg creates and splits a fixed black-border 6-panel grid locally', async () => {
  const root = makeTempRoot('storyboard-grid');
  roots.push(root);
  await mkdir(root, { recursive: true });
  const ffmpeg = new Ffmpeg();
  const sheet = join(root, 'sheet.png');
  const outputs = Array.from({ length: 6 }, (_, index) => join(root, `panel-${index + 1}.png`));
  await ffmpeg.storyboardGridTemplate(sheet, 6);
  await ffmpeg.splitStoryboardGrid(sheet, outputs, 6);
  const sheetInfo = await ffmpeg.probe(sheet);
  const panelInfo = await ffmpeg.probe(outputs[0]!);
  assert.equal(sheetInfo.width, 1536);
  assert.equal(sheetInfo.height, 1024);
  assert.ok((panelInfo.width ?? 0) > 490 && (panelInfo.width ?? 0) < 512);
  assert.ok((panelInfo.height ?? 0) > 490 && (panelInfo.height ?? 0) < 512);
});
