// Studio Canvas connection dispatcher (spec §8 R1–R13, §16.2 WP-04).

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CanvasPortId } from '@h3mise/shared';
import { cleanupTempRoot, makeStore } from './helpers.js';
import { activeEpisodeId } from '../src/modules/story.js';
import { createShot, getShot, updateShot } from '../src/modules/shots.js';
import * as assetsMod from '../src/modules/assets.js';
import * as canvasMod from '../src/modules/canvas.js';

const roots: string[] = [];
after(() => roots.forEach((root) => cleanupTempRoot(root)));

const demoDir = fileURLToPath(new URL('../../demo/good-boy.h3studio', import.meta.url));

async function openDemo() {
  const { root, store } = await makeStore('canvas-connect');
  roots.push(root);
  const meta = await store.installDemo(demoDir);
  const ctx = await store.open(meta.id);
  return { store, ctx, storyId: activeEpisodeId(ctx) };
}

function request(
  storyId: string,
  sourceId: string,
  sourcePort: CanvasPortId,
  targetId: string,
  targetPort: CanvasPortId,
  options?: Record<string, unknown>,
) {
  return {
    storyId,
    source: { nodeId: sourceId, port: sourcePort },
    target: { nodeId: targetId, port: targetPort },
    ...(options ? { options } : {}),
  } as import('@h3mise/shared').CanvasConnectRequest;
}

async function isCode(fn: () => unknown | Promise<unknown>, code: canvasMod.CanvasErrorCode): Promise<void> {
  await assert.rejects(
    async () => {
      await fn();
    },
    (error: unknown) => error instanceof canvasMod.CanvasError && error.code === code,
  );
}

function addMediaImage(ctx: Awaited<ReturnType<typeof openDemo>>['ctx'], tag: string) {
  return assetsMod.insertMedia(ctx, { kind: 'image', fileName: `assets/${tag}.png`, mimeType: 'image/png', sizeBytes: 10, label: tag });
}

test('R1 beat→shot sets the beat, is idempotent, and requires replace', async () => {
  const { ctx, storyId } = await openDemo();
  // shot-003 is already on beat-003.
  const same = await canvasMod.connectCanvas(ctx, request(storyId, 'beat:beat-003', 'beat', 'shot:shot-003', 'beat'));
  assert.equal(same.ok, true);

  await isCode(() => canvasMod.connectCanvas(ctx, request(storyId, 'beat:beat-002', 'beat', 'shot:shot-003', 'beat')), 'needs_replace');

  const replaced = await canvasMod.connectCanvas(ctx, request(storyId, 'beat:beat-002', 'beat', 'shot:shot-003', 'beat', { replace: true }));
  assert.equal(replaced.edgeId, 'beat_shot:shot-003');
  assert.equal(getShot(ctx, 'shot-003').storyBeatId, 'beat-002');
});

test('R2 entity→shot.cast replaces the primary character and syncs bindings', async () => {
  const { ctx, storyId } = await openDemo();
  await isCode(() => canvasMod.connectCanvas(ctx, request(storyId, 'entity:ent-002', 'entity', 'shot:shot-001', 'cast')), 'needs_replace');
  await canvasMod.connectCanvas(ctx, request(storyId, 'entity:ent-002', 'entity', 'shot:shot-001', 'cast', { replace: true }));
  assert.equal(getShot(ctx, 'shot-001').primaryCharacterId, 'ent-002');
  const bindings = assetsMod.listBindings(ctx, 'shot-001');
  assert.ok(bindings.some((binding) => binding.sourceEntityId === 'ent-002'));
});

test('R4 prop entity with a main image binds as a reference', async () => {
  const { ctx, storyId } = await openDemo();
  const media = addMediaImage(ctx, 'prop');
  const prop = assetsMod.createEntity(ctx, { kind: 'prop', name: 'Hammer', imageAssetId: media.id });
  await canvasMod.connectCanvas(ctx, request(storyId, `entity:${prop.id}`, 'entity', 'shot:shot-001', 'refs', { roles: ['style'] }));
  const roles = assetsMod.listBindings(ctx, 'shot-001').some((binding) => binding.assetId === media.id);
  assert.equal(roles, true);

  const bare = assetsMod.createEntity(ctx, { kind: 'prop', name: 'No Image' });
  await isCode(() => canvasMod.connectCanvas(ctx, request(storyId, `entity:${bare.id}`, 'entity', 'shot:shot-001', 'refs')), 'invalid_connection');
});

test('R7 media image → refs triggers a mode switch on a t2va shot', async () => {
  const { ctx, storyId } = await openDemo();
  const shot = createShot(ctx, { title: 'T2VA Shot', h3Mode: 't2va' });
  const media = addMediaImage(ctx, 'ref');
  canvasMod.saveLayout(ctx, { storyId, nodes: [{ nodeId: `media:${media.id}`, x: 0, y: 0, collapsed: false, pinned: false, userPlaced: true }] });

  await isCode(
    () => canvasMod.connectCanvas(ctx, request(storyId, `media:${media.id}`, 'image', `shot:${shot.id}`, 'refs', { roles: ['style'] })),
    'needs_mode_switch',
  );
  await canvasMod.connectCanvas(ctx, request(storyId, `media:${media.id}`, 'image', `shot:${shot.id}`, 'refs', { roles: ['style'], switchMode: 'ref2va' }));
  assert.equal(getShot(ctx, shot.id).h3Mode, 'ref2va');
  assert.ok(assetsMod.listBindings(ctx, shot.id).some((binding) => binding.assetId === media.id));
});

test('R12 frame chain connects, rejects cycles, and disconnect resets to auto', async () => {
  const { ctx, storyId } = await openDemo();
  const chained = await canvasMod.connectCanvas(ctx, request(storyId, 'shot:shot-001', 'tail_frame', 'shot:shot-002', 'first_frame'));
  assert.equal(chained.edgeId, 'frame_chain:shot-002', 'frame chain edge id');
  assert.equal(getShot(ctx, 'shot-002').renderDependencyMode, 'previous_take');
  assert.equal(getShot(ctx, 'shot-002').dependsOnShotId, 'shot-001');

  await isCode(() => canvasMod.connectCanvas(ctx, request(storyId, 'shot:shot-002', 'tail_frame', 'shot:shot-001', 'first_frame')), 'cycle');

  canvasMod.disconnectCanvas(ctx, 'frame_chain:shot-002', storyId);
  assert.equal(getShot(ctx, 'shot-002').renderDependencyMode, 'auto');
  assert.equal(getShot(ctx, 'shot-002').dependsOnShotId, null);
});

test('reference limits are enforced from provider capabilities', async () => {
  const { ctx, storyId } = await openDemo();
  const media = addMediaImage(ctx, 'limit');
  const prop = assetsMod.createEntity(ctx, { kind: 'prop', name: 'Limit Prop', imageAssetId: media.id });
  const caps = { supportedModes: ['ref2va'], maxImageRefs: 0, maxVideoRefs: 0, maxAudioRefs: 0, maxTotalRefs: 0 } as never;
  await isCode(
    () => canvasMod.connectCanvas(ctx, request(storyId, `entity:${prop.id}`, 'entity', 'shot:shot-001', 'refs', { roles: ['style'] }), { capabilities: async () => caps, providerId: 'runninghub' }),
    'reference_limit',
  );
  assert.equal(assetsMod.listBindings(ctx, 'shot-001').some((binding) => binding.assetId === media.id), false);
});

test('locked shots and stale episodes are rejected', async () => {
  const { ctx, storyId } = await openDemo();
  ctx.db.run("UPDATE shots SET status = 'LOCKED' WHERE id = 'shot-001'");
  await isCode(() => canvasMod.connectCanvas(ctx, request(storyId, 'beat:beat-002', 'beat', 'shot:shot-001', 'beat', { replace: true })), 'locked');

  ctx.db.run("UPDATE shots SET status = 'DRAFT' WHERE id = 'shot-001'");
  await isCode(() => canvasMod.connectCanvas(ctx, request('story-other', 'beat:beat-002', 'beat', 'shot:shot-001', 'beat', { replace: true })), 'stale_episode');
});

test('unknown connections and derived disconnects are rejected', async () => {
  const { ctx, storyId } = await openDemo();
  await isCode(() => canvasMod.connectCanvas(ctx, request(storyId, 'beat:beat-002', 'beat', 'timeline:timeline-001', 'clips')), 'invalid_connection');
  await isCode(() => Promise.resolve(canvasMod.disconnectCanvas(ctx, 'shot_takes:shot-001', storyId)), 'invalid_connection');
});

test('binding disconnect removes the reference binding', async () => {
  const { ctx, storyId } = await openDemo();
  const media = addMediaImage(ctx, 'unbind');
  canvasMod.saveLayout(ctx, { storyId, nodes: [{ nodeId: `media:${media.id}`, x: 0, y: 0, collapsed: false, pinned: false, userPlaced: true }] });
  const result = await canvasMod.connectCanvas(ctx, request(storyId, `media:${media.id}`, 'image', 'shot:shot-001', 'refs', { roles: ['style'] }));
  assert.ok(result.edgeId.startsWith('binding:'));
  canvasMod.disconnectCanvas(ctx, result.edgeId, storyId);
  assert.equal(assetsMod.listBindings(ctx, 'shot-001').some((binding) => binding.assetId === media.id), false);
});

test('connection commands never create render or storyboard jobs', async () => {
  const { ctx, storyId } = await openDemo();
  const before = {
    render: ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM render_jobs')!.n,
    storyboard: ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM storyboard_jobs')!.n,
  };
  await canvasMod.connectCanvas(ctx, request(storyId, 'beat:beat-002', 'beat', 'shot:shot-003', 'beat', { replace: true }));
  await canvasMod.connectCanvas(ctx, request(storyId, 'shot:shot-001', 'tail_frame', 'shot:shot-002', 'first_frame'));
  canvasMod.disconnectCanvas(ctx, 'frame_chain:shot-002', storyId);
  const after = {
    render: ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM render_jobs')!.n,
    storyboard: ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM storyboard_jobs')!.n,
  };
  assert.deepEqual(after, before);
});

function addMedia(
  ctx: Awaited<ReturnType<typeof openDemo>>['ctx'],
  kind: 'image' | 'video' | 'audio',
  tag: string,
) {
  return assetsMod.insertMedia(ctx, {
    kind,
    fileName: `assets/${tag}.${kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'wav'}`,
    mimeType: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/wav',
    sizeBytes: 10,
    label: tag,
  });
}

function placeMedia(
  ctx: Awaited<ReturnType<typeof openDemo>>['ctx'],
  storyId: string,
  mediaId: string,
): void {
  canvasMod.saveLayout(ctx, {
    storyId,
    nodes: [{ nodeId: `media:${mediaId}`, x: 0, y: 0, collapsed: false, pinned: false, userPlaced: true }],
  });
}

test('R3 entity(scene)→shot.cast sets the scene', async () => {
  const { ctx, storyId } = await openDemo();
  const yard = assetsMod.createEntity(ctx, { kind: 'scene', name: 'Yard' });
  await canvasMod.connectCanvas(ctx, request(storyId, `entity:${yard.id}`, 'entity', 'shot:shot-001', 'cast', { replace: true }));
  assert.equal(getShot(ctx, 'shot-001').sceneId, yard.id);
});

test('R5/R6 character_state→refs / first_frame create bindings', async () => {
  const { ctx, storyId } = await openDemo();
  await canvasMod.connectCanvas(ctx, request(storyId, 'character_state:cstate-002', 'image', 'shot:shot-001', 'refs', { roles: ['identity'] }));
  const refs = assetsMod.listBindings(ctx, 'shot-001');
  assert.ok(refs.some((binding) => binding.sourceEntityId === null && binding.roles.includes('identity')));

  await canvasMod.connectCanvas(ctx, request(storyId, 'character_state:cstate-002', 'image', 'shot:shot-002', 'first_frame'));
  assert.ok(assetsMod.listBindings(ctx, 'shot-002').some((binding) => binding.roles.includes('first_frame')));
});

test('R8 media(image)→first_frame', async () => {
  const { ctx, storyId } = await openDemo();
  const media = addMedia(ctx, 'image', 'r8');
  placeMedia(ctx, storyId, media.id);
  await canvasMod.connectCanvas(ctx, request(storyId, `media:${media.id}`, 'image', 'shot:shot-001', 'first_frame'));
  assert.ok(assetsMod.listBindings(ctx, 'shot-001').some((binding) => binding.assetId === media.id && binding.roles.includes('first_frame')));
});

test('R9 media(image)→last_frame on an l2va shot', async () => {
  const { ctx, storyId } = await openDemo();
  const shot = createShot(ctx, { title: 'L2VA', h3Mode: 'l2va' });
  const media = addMedia(ctx, 'image', 'r9');
  placeMedia(ctx, storyId, media.id);
  await canvasMod.connectCanvas(ctx, request(storyId, `media:${media.id}`, 'image', `shot:${shot.id}`, 'last_frame'));
  assert.ok(assetsMod.listBindings(ctx, shot.id).some((binding) => binding.roles.includes('last_frame')));
});

test('R10 media(video)→video_ref on a vref2va shot', async () => {
  const { ctx, storyId } = await openDemo();
  const shot = createShot(ctx, { title: 'VRef', h3Mode: 'vref2va' });
  const media = addMedia(ctx, 'video', 'r10');
  placeMedia(ctx, storyId, media.id);
  await canvasMod.connectCanvas(ctx, request(storyId, `media:${media.id}`, 'video', `shot:${shot.id}`, 'video_ref'));
  assert.ok(assetsMod.listBindings(ctx, shot.id).some((binding) => binding.assetId === media.id && binding.type === 'video'));
});

test('R11 media(audio)→audio_ref', async () => {
  const { ctx, storyId } = await openDemo();
  const media = addMedia(ctx, 'audio', 'r11');
  placeMedia(ctx, storyId, media.id);
  await canvasMod.connectCanvas(ctx, request(storyId, `media:${media.id}`, 'audio', 'shot:shot-001', 'audio_ref'));
  assert.ok(assetsMod.listBindings(ctx, 'shot-001').some((binding) => binding.assetId === media.id && binding.type === 'audio'));
});

test('replace rolls back the old binding when the second step fails', async () => {
  const { ctx, storyId } = await openDemo();
  const media = addMedia(ctx, 'image', 'rollback');
  const existing = assetsMod.createBinding(ctx, { assetId: media.id, roles: ['first_frame'], shotId: 'shot-003' });
  // shot-002 already depends on shot-003 → connecting shot-002 -> shot-003 cycles.
  updateShot(ctx, 'shot-002', { renderDependencyMode: 'previous_take', dependsOnShotId: 'shot-003' });

  await assert.rejects(
    () => canvasMod.connectCanvas(ctx, request(storyId, 'shot:shot-002', 'tail_frame', 'shot:shot-003', 'first_frame', { replace: true })),
    (error: unknown) => error instanceof canvasMod.CanvasError && error.code === 'cycle',
  );
  assert.ok(
    assetsMod.listBindings(ctx, 'shot-003').some((binding) => binding.id === existing.id),
    'the deleted binding must be restored when the command rolls back',
  );
});
