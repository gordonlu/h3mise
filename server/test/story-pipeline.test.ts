import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupTempRoot, makeProject, makeStore } from './helpers.js';
import { createBeat, listBeats } from '../src/modules/story.js';
import { createShot, listShots } from '../src/modules/shots.js';
import { applyBeatProposal } from '../src/modules/story-pipeline.js';
import { importRawPrompt } from '../src/modules/prompt.js';

const roots: string[] = [];
after(() => roots.forEach((root) => cleanupTempRoot(root)));

test('Beat proposal refines canonical rows in place and preserves linked Shot ids', async () => {
  const { root, store } = await makeStore('beat-proposal-refine');
  roots.push(root);
  const project = await makeProject(store, 'Beat Proposal');
  const beat = createBeat(project, { title: 'Old', summary: 'Old action', durationSeconds: 5 });
  const shot = createShot(project, { title: 'Old', storyBeatId: beat.id, purpose: 'Old action', durationSeconds: 5 });
  const result = applyBeatProposal(project, [
    { title: 'Refined', summary: 'Refined action', durationSeconds: 8 },
    { title: 'New ending', summary: 'Visible ending', durationSeconds: 4 },
  ], { mode: 'replace', createMissingShots: true });
  assert.equal(result.updated, 1);
  assert.equal(result.created, 1);
  assert.equal(result.shotsCreated, 1);
  assert.equal(listBeats(project)[0]?.id, beat.id);
  const linked = listShots(project).find((item) => item.id === shot.id)!;
  assert.equal(linked.title, 'Refined');
  assert.equal(linked.purpose, 'Refined action');
  assert.equal(linked.durationSeconds, 8);
});

test('invalid Beat proposal rolls back without leaving a partial replacement', async () => {
  const { root, store } = await makeStore('beat-proposal-rollback');
  roots.push(root);
  const project = await makeProject(store, 'Beat Rollback');
  const beat = createBeat(project, { title: 'Original' });
  assert.throws(() => applyBeatProposal(project, [
    { title: 'Would update' },
    { title: 'Invalid', category: 'not-a-category' as never },
  ]), /category/);
  assert.deepEqual(listBeats(project).map((item) => [item.id, item.title]), [[beat.id, 'Original']]);
});

test('Beat refinement never rewrites a Shot that already has authored downstream work', async () => {
  const { root, store } = await makeStore('beat-proposal-preserve-shot');
  roots.push(root);
  const project = await makeProject(store, 'Preserve Shot');
  const beat = createBeat(project, { title: 'Original Beat', summary: 'Original action', durationSeconds: 5 });
  const shot = createShot(project, { title: 'Original Shot', storyBeatId: beat.id, purpose: 'Original action', durationSeconds: 5 });
  importRawPrompt(project, shot.id, 'A carefully authored prompt', 't2va');

  applyBeatProposal(project, [{ title: 'Refined Beat', summary: 'New action', durationSeconds: 9 }]);

  assert.equal(listBeats(project)[0]?.title, 'Refined Beat');
  const preserved = listShots(project).find((item) => item.id === shot.id)!;
  assert.equal(preserved.title, 'Original Shot');
  assert.equal(preserved.purpose, 'Original action');
  assert.equal(preserved.durationSeconds, 5);
});
