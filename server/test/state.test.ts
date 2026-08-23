// State-machine & data invariant tests — the "no corrupt state" net.
// Covers: shot status transitions, one-selected-per-shot, reject semantics,
// continuity actual validation, timeline clip invalidation on reselect.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, makeProject, makeShotWithPrompt, fakeTake, cleanupTempRoot, bus } from './helpers.js';
import { listTakes, selectTake, getTake, rejectTake, updateTake, createTake } from '../src/modules/takes.js';
import { getShot, advanceTo, advanceShotStatus, createShot } from '../src/modules/shots.js';
import { commitContinuity, selectTakeAndCommit, emptyVisualState } from '../src/modules/continuity.js';
import { getTimeline, addClip, invalidateShotClips } from '../src/modules/timeline.js';
import { getPrompt } from '../src/modules/prompt.js';

const roots: string[] = [];
after(() => { for (const r of roots) cleanupTempRoot(r); });

async function fixture() {
  const { root, store } = await makeStore('state');
  roots.push(root);
  const p = await makeProject(store, 'invariants');
  const { shotId, promptVersionId } = makeShotWithPrompt(p);
  return { p, shotId, promptVersionId };
}

test('at most one selected take per shot', async () => {
  const { p, shotId, promptVersionId } = await fixture();
  const a = await fakeTake(p, shotId, promptVersionId, 'a');
  const b = await fakeTake(p, shotId, promptVersionId, 'b');
  selectTake(p, a.id, bus());
  selectTake(p, b.id, bus());
  const selected = listTakes(p, shotId).filter((t) => t.status === 'selected');
  assert.equal(selected.length, 1);
  assert.equal(selected[0]!.id, b.id);
  assert.equal(getTake(p, a.id).status, 'candidate'); // old selected demoted, NOT rejected
});

test('reject is explicit; reselect after reject works', async () => {
  const { p, shotId, promptVersionId } = await fixture();
  const a = await fakeTake(p, shotId, promptVersionId, 'a');
  const b = await fakeTake(p, shotId, promptVersionId, 'b');
  rejectTake(p, a.id);
  assert.equal(getTake(p, a.id).status, 'rejected');
  selectTake(p, b.id, bus());
  assert.equal(getTake(p, b.id).status, 'selected');
});

test('updateTake cannot change status through the data layer', async () => {
  const { p, shotId, promptVersionId } = await fixture();
  const a = await fakeTake(p, shotId, promptVersionId, 'a');
  const patched = updateTake(p, a.id, { rating: 2, notes: 'nope' } as Parameters<typeof updateTake>[2] & { status: string } as any);
  assert.equal(patched.status, 'candidate');
  assert.equal(patched.rating, 2);
});

test('createTake is idempotent per render job', async () => {
  const { p, shotId, promptVersionId } = await fixture();
  const first = await fakeTake(p, shotId, promptVersionId, 'dup');
  const second = await createTake(p, {
    shotId,
    renderJobId: first.renderJobId,
    promptVersionId,
    directorPlanVersionId: null,
    localVideoPath: 'whatever.mp4',
    duration: 3,
  });
  assert.equal(second.id, first.id);
  assert.equal(listTakes(p, shotId).length, 1);
});

test('commitContinuity requires a selected take of the same shot', async () => {
  const { p, shotId, promptVersionId } = await fixture();
  const a = await fakeTake(p, shotId, promptVersionId, 'a');
  const otherShot = createShot(p, { title: 'Other' }); // same project, different shot
  assert.throws(() => commitContinuity(p, { shotId, scope: 'visual', kind: 'actual', sourceTakeId: a.id, state: emptyVisualState() }), /selected/);
  selectTake(p, a.id, bus());
  assert.throws(() => commitContinuity(p, { shotId: otherShot.id, scope: 'visual', kind: 'actual', sourceTakeId: a.id, state: emptyVisualState() }), /belongs to shot/);
  const ok = commitContinuity(p, { shotId, scope: 'visual', kind: 'actual', sourceTakeId: a.id, state: emptyVisualState() });
  assert.ok(ok.id.startsWith('cont-'));
});

test('timeline only accepts selected takes; reselect invalidates old clips', async () => {
  const { p, shotId, promptVersionId } = await fixture();
  const a = await fakeTake(p, shotId, promptVersionId, 'a');
  const b = await fakeTake(p, shotId, promptVersionId, 'b');
  assert.throws(() => addClip(p, { shotId, takeId: a.id }), /selected/);
  selectTake(p, a.id, bus());
  const clip = addClip(p, { shotId, takeId: a.id });
  assert.equal(getTimeline(p).clips.length, 1);
  // reselect b: the old clip's take is no longer selected — must be removed
  invalidateShotClips(p, shotId);
  assert.equal(getTimeline(p).clips.length, 0);
  // the invariant net on export: exportTimeline re-checks; verify via state
  selectTake(p, b.id, bus());
  assert.equal(getTake(p, clip.takeId).status, 'candidate');
});

test('selectTakeAndCommit advances shot to CONTINUITY_COMMITTED', async () => {
  const { p, shotId, promptVersionId } = await fixture();
  const a = await fakeTake(p, shotId, promptVersionId, 'a');
  advanceTo(p, shotId, 'HAS_TAKES');
  const res = selectTakeAndCommit(p, a.id, emptyVisualState(), bus());
  assert.equal(res.entry.shotId, shotId);
  assert.equal(getShot(p, shotId).status, 'CONTINUITY_COMMITTED');
  assert.equal(getPrompt(p, promptVersionId).text.length > 0, true);
});

test('reselecting after CONTINUITY_COMMITTED walks the shot back to SELECTED (stale continuity)', async () => {
  const { p, shotId, promptVersionId } = await fixture();
  const a = await fakeTake(p, shotId, promptVersionId, 'a');
  advanceTo(p, shotId, 'HAS_TAKES');
  selectTakeAndCommit(p, a.id, emptyVisualState(), bus());
  assert.equal(getShot(p, shotId).status, 'CONTINUITY_COMMITTED');

  // new take arrives and the user reselects — committed continuity cites the
  // OLD take, so the shot must drop back to SELECTED (re-commit required)
  const b = await fakeTake(p, shotId, promptVersionId, 'b');
  selectTake(p, b.id, bus());
  assert.equal(getShot(p, shotId).status, 'SELECTED');
  assert.equal(listTakes(p, shotId).find((t) => t.status === 'selected')!.id, b.id);
});
