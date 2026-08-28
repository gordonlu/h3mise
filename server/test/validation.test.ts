import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, makeProject, makeShotWithPrompt, fakeTake, cleanupTempRoot } from './helpers.js';
import { createEntity, createCharacterState, updateCharacterState, updateEntity, createBinding, insertMedia } from '../src/modules/assets.js';
import { createSequence, updateSequence, updateStory, getStory } from '../src/modules/story.js';
import { createShot, deleteShotAndFiles } from '../src/modules/shots.js';
import { addClip, getTimeline, updateClip } from '../src/modules/timeline.js';
import { selectTake, updateTake } from '../src/modules/takes.js';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';

after(() => cleanupTempRoot());

test('update modules ignore unknown keys and accept empty patches safely', async () => {
  const { store } = await makeStore('validation-patch');
  const p = await makeProject(store, 'patches');
  const sequence = createSequence(p, { title: 'A' });
  assert.equal(updateSequence(p, sequence.id, {}).title, 'A');
  assert.equal(updateSequence(p, sequence.id, { injected: 'x' } as never).title, 'A');

  updateStory(p, { injected: 'x' } as never);
  assert.equal(getStory(p).title, 'patches');

  // Projects created by older versions may still have a blank story title.
  p.db.run("UPDATE story SET title = ''");
  assert.equal(getStory(p).title, 'patches');

  const entity = createEntity(p, { kind: 'character', name: 'Hero' });
  assert.equal(updateEntity(p, entity.id, { injected: 'x' } as never).name, 'Hero');
  const state = createCharacterState(p, { characterId: entity.id, name: 'Default' });
  assert.equal(updateCharacterState(p, state.id, {}).name, 'Default');
  assert.equal(updateCharacterState(p, state.id, { injected: 'x' } as never).name, 'Default');
});

test('domain validation rejects invalid entities, shots, and timeline trims', async () => {
  const { store } = await makeStore('validation-domain');
  const p = await makeProject(store, 'domain');
  assert.throws(() => createEntity(p, { kind: 'alien' as never, name: 'X' }), /kind/);
  const prop = createEntity(p, { kind: 'prop', name: 'Key' });
  assert.throws(() => createCharacterState(p, { characterId: prop.id, name: 'Wrong' }), /character or creature entity/);
  assert.throws(() => createShot(p, { durationSeconds: -1 }), /duration/);
  assert.throws(() => createShot(p, { aspectRatio: 'wide' }), /aspectRatio/);

  const { shotId, promptVersionId } = makeShotWithPrompt(p);
  const take = await fakeTake(p, shotId, promptVersionId, 'trim');
  assert.throws(() => updateTake(p, take.id, { rating: 6 }), /rating/);
  assert.throws(() => updateTake(p, take.id, { failureTags: ['unknown'] as never }), /failure tag/);
  const media = insertMedia(p, { kind: 'image', fileName: 'assets/ref.png', mimeType: 'image/png', sizeBytes: 1 });
  assert.throws(() => createBinding(p, { assetId: media.id, roles: ['unknown'] as never }), /reference role/);
  selectTake(p, take.id);
  assert.throws(() => addClip(p, { shotId, takeId: take.id, trimIn: -1 }), /trimIn/);
  const clip = addClip(p, { shotId, takeId: take.id });
  assert.throws(() => updateClip(p, clip.id, { trimOut: take.duration + 1 }), /trimOut/);
  assert.throws(() => updateClip(p, clip.id, { trimIn: 2.95, trimOut: 3 }), /trimOut/);
  assert.deepEqual(clip.audio, { volume: 1, mute: false, normalize: true });
  assert.throws(() => updateClip(p, clip.id, { audio: { volume: 3, mute: false, normalize: true } }), /audio volume/);
  p.db.run("UPDATE timeline_clips SET audio_json = '{\"volume\":0.8,\"mute\":false}' WHERE id = ?", [clip.id]);
  assert.equal(getTimeline(p).clips[0]?.audio.normalize, true);
  const audioUpdated = updateClip(p, clip.id, { audio: { volume: 0.8, mute: false, normalize: false } });
  assert.deepEqual(audioUpdated.audio, { volume: 0.8, mute: false, normalize: false });
});

test('deleting a shot removes its generated take file', async () => {
  const { store } = await makeStore('validation-delete');
  const p = await makeProject(store, 'delete-files');
  const { shotId, promptVersionId } = makeShotWithPrompt(p);
  const take = await fakeTake(p, shotId, promptVersionId, 'files');
  const video = p.resolveProjectPath(take.localVideoPath);
  await mkdir(join(video, '..'), { recursive: true });
  await writeFile(video, 'video');
  await deleteShotAndFiles(p, shotId);
  await assert.rejects(access(video));
  assert.equal(getTimeline(p).clips.length, 0);
});

test('a retained project context stays usable until its in-flight lease releases', async () => {
  const { store } = await makeStore('validation-lease');
  const first = await makeProject(store, 'first');
  first.retain();
  const firstId = first.meta.id;
  await store.create({ title: 'second', format: 'single_shot' });
  const second = (await store.list()).find((project) => project.title === 'second')!;
  await store.open(second.id);
  assert.equal(first.db.get<{ id: string }>('SELECT id FROM story LIMIT 1')?.id, 'story-001');
  first.release();
  assert.throws(() => first.db.get('SELECT 1'), /not open|invalid state/i);
  assert.notEqual(store.current?.meta.id, firstId);
});
