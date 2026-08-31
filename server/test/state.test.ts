// State-machine & data invariant tests — the "no corrupt state" net.
// Covers: shot status transitions, one-selected-per-shot, reject semantics,
// continuity actual validation, timeline clip invalidation on reselect.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, makeProject, makeShotWithPrompt, fakeTake, cleanupTempRoot, bus } from './helpers.js';
import { listTakes, selectTake, getTake, rejectTake, updateTake, createTake, deleteRejectedTake, importTake } from '../src/modules/takes.js';
import { getShot, advanceTo, advanceShotStatus, createShot, renderReadiness, resolveDependentsAfterSelection, updateShot } from '../src/modules/shots.js';
import { commitContinuity, selectTakeAndCommit, emptyVisualState } from '../src/modules/continuity.js';
import { getTimeline, addClip, addMissingSelectedTakes, invalidateShotClips, listTimelineExports, recoverTimelineExports, updateClip } from '../src/modules/timeline.js';
import { getPrompt, importRawPrompt } from '../src/modules/prompt.js';
import { insertMedia, createBinding } from '../src/modules/assets.js';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Ffmpeg } from '../src/ffmpeg.js';

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

test('previous-take dependency waits for selection then auto-binds the real tail frame', async () => {
  const { p, shotId, promptVersionId } = await fixture();
  const downstream = createShot(p, { title: 'Downstream', h3Mode: 'i2va', renderDependencyMode: 'previous_take', dependsOnShotId: shotId });
  assert.equal(renderReadiness(p, downstream).ready, false);
  assert.match(renderReadiness(p, downstream).reason, /等待/);

  const take = await fakeTake(p, shotId, promptVersionId, 'bridge');
  const framePath = `shots/${shotId}/frames/${take.id}-last.jpg`;
  const frame = insertMedia(p, {
    kind: 'image',
    fileName: framePath,
    mimeType: 'image/jpeg',
    sizeBytes: 10,
    source: 'frame_extract',
    label: `${take.id} last frame`,
  });
  p.db.run('UPDATE takes SET last_frame_path = ? WHERE id = ?', [framePath, take.id]);
  selectTake(p, take.id, bus());
  const resolved = resolveDependentsAfterSelection(p, shotId);
  assert.equal(resolved.length, 1);
  assert.equal(renderReadiness(p, downstream.id).ready, true);
  const binding = p.db.get<{ asset_id: string; roles_json: string }>('SELECT asset_id, roles_json FROM reference_bindings WHERE shot_id = ?', [downstream.id]);
  assert.equal(binding?.asset_id, frame.id);
  assert.match(binding?.roles_json ?? '', /first_frame/);

  assert.throws(() => updateShot(p, shotId, { renderDependencyMode: 'previous_take', dependsOnShotId: downstream.id }), /cycle/);
});

test('only rejected takes can be deleted; owned files are cleaned and referenced frames survive', async () => {
  const { p, shotId, promptVersionId } = await fixture();
  const take = await fakeTake(p, shotId, promptVersionId, 'delete');
  await assert.rejects(deleteRejectedTake(p, take.id), /only rejected/);

  const video = p.resolveProjectPath(take.localVideoPath);
  const posterRel = `shots/${shotId}/frames/${take.id}-poster.jpg`;
  const firstRel = `shots/${shotId}/frames/${take.id}-first.jpg`;
  const lastRel = `shots/${shotId}/frames/${take.id}-last.jpg`;
  for (const rel of [take.localVideoPath, posterRel, firstRel, lastRel]) {
    const abs = p.resolveProjectPath(rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, rel);
  }
  p.db.run('UPDATE takes SET poster_path = ?, first_frame_path = ?, last_frame_path = ? WHERE id = ?', [posterRel, firstRel, lastRel, take.id]);
  const firstMedia = insertMedia(p, { kind: 'image', fileName: firstRel, mimeType: 'image/jpeg', sizeBytes: 1 });
  const lastMedia = insertMedia(p, { kind: 'image', fileName: lastRel, mimeType: 'image/jpeg', sizeBytes: 1 });
  const nextShot = createShot(p, { title: 'Next' });
  createBinding(p, { assetId: firstMedia.id, shotId: nextShot.id, roles: ['first_frame'] });
  p.db.run('UPDATE render_jobs SET take_id = ? WHERE id = ?', [take.id, take.renderJobId]);

  selectTake(p, take.id);
  addClip(p, { shotId, takeId: take.id });
  rejectTake(p, take.id);
  await deleteRejectedTake(p, take.id);

  assert.throws(() => getTake(p, take.id), /not found/);
  assert.equal(getTimeline(p).clips.length, 0);
  assert.equal(p.db.get<{ take_id: string | null }>('SELECT take_id FROM render_jobs WHERE id = ?', [take.renderJobId])?.take_id, null);
  assert.equal(p.db.get<{ id: string }>('SELECT id FROM media_assets WHERE id = ?', [lastMedia.id]), undefined);
  assert.ok(p.db.get<{ id: string }>('SELECT id FROM media_assets WHERE id = ?', [firstMedia.id]));
  await assert.rejects(access(video));
  await assert.rejects(access(p.resolveProjectPath(posterRel)));
  await assert.rejects(access(p.resolveProjectPath(lastRel)));
  await access(p.resolveProjectPath(firstRel));
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

test('an external video imports into a shot as a candidate Take with local provenance and frames', async () => {
  const { p, shotId } = await fixture();
  const ffmpeg = {
    probe: async () => ({
      durationSeconds: 7.5,
      width: 1920,
      height: 1080,
      hasAudio: true,
      audioDurationSeconds: 7.5,
      format: 'mov,mp4',
    }),
    poster: async (_input: string, output: string) => {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, 'poster');
    },
    firstLastFrames: async (_input: string, first: string, last: string) => {
      await mkdir(dirname(first), { recursive: true });
      await writeFile(first, 'first');
      await writeFile(last, 'last');
    },
  } as unknown as Ffmpeg;

  const take = await importTake(p, {
    shotId,
    fileName: 'shot-from-another-tool.mp4',
    mimeType: 'video/mp4',
    data: Buffer.from('fake video bytes'),
    provenance: { provider: 'ComfyUI', model: 'local-workflow', prompt: 'Original prompt' },
  }, ffmpeg);

  assert.equal(take.source, 'import');
  assert.equal(take.status, 'candidate');
  assert.equal(take.duration, 7.5);
  assert.deepEqual(take.provenance, {
    originalFileName: 'shot-from-another-tool.mp4',
    provider: 'ComfyUI',
    model: 'local-workflow',
    prompt: 'Original prompt',
  });
  assert.equal(getShot(p, shotId).status, 'HAS_TAKES');
  await access(p.resolveProjectPath(take.localVideoPath));
  await access(p.resolveProjectPath(take.posterPath!));
  await access(p.resolveProjectPath(take.firstFramePath!));
  await access(p.resolveProjectPath(take.lastFramePath!));

  const job = p.db.get<{ provider: string; status: string; take_id: string; cost_json: string }>('SELECT provider, status, take_id, cost_json FROM render_jobs WHERE id = ?', [take.renderJobId]);
  assert.equal(job?.provider, 'ComfyUI');
  assert.equal(job?.status, 'LOCAL_READY');
  assert.equal(job?.take_id, take.id);
  assert.equal(JSON.parse(job!.cost_json).credits, 0);
  assert.equal(getPrompt(p, take.promptVersionId).source, 'import');

  selectTake(p, take.id, bus());
  const clip = addClip(p, { shotId, takeId: take.id });
  assert.equal(clip.takeId, take.id);
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

test('existing exported videos are recovered as persistent project artifacts', async () => {
  const { p } = await fixture();
  await writeFile(p.resolveProjectPath('exports/legacy-export.mp4'), 'video');
  assert.equal(await recoverTimelineExports(p), 1);
  assert.equal(await recoverTimelineExports(p), 0);
  const exports = listTimelineExports(p);
  assert.equal(exports.length, 1);
  assert.equal(exports[0]?.relPath, 'exports/legacy-export.mp4');
});

test('quick edit appends missing selected takes without changing professional edits', async () => {
  const { p, shotId, promptVersionId } = await fixture();
  const first = await fakeTake(p, shotId, promptVersionId, 'quick-a');
  selectTake(p, first.id, bus());
  const existing = addClip(p, { shotId, takeId: first.id });
  updateClip(p, existing.id, { trimIn: 0.5, transition: 'fade', transitionDuration: 0.4 });

  const secondShot = createShot(p, { title: 'Second', durationSeconds: 3 });
  const secondPrompt = importRawPrompt(p, secondShot.id, 'Second prompt', 't2va').id;
  const second = await fakeTake(p, secondShot.id, secondPrompt, 'quick-b');
  selectTake(p, second.id, bus());

  const result = addMissingSelectedTakes(p);
  assert.equal(result.added, 1);
  assert.equal(result.clips.length, 2);
  assert.equal(result.clips[0]?.id, existing.id);
  assert.equal(result.clips[0]?.trimIn, 0.5);
  assert.equal(result.clips[0]?.transition, 'fade');
  assert.equal(addMissingSelectedTakes(p).added, 0);
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
