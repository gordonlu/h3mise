import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanupTempRoot, makeProject, makeStore } from './helpers.js';
import {
  createBinding,
  createCharacterState,
  createEntity,
  deleteMedia,
  getEntity,
  ensureShotEntityImageBindings,
  insertMedia,
  listBindings,
  listCharacterStates,
  mediaUsage,
  updateCharacterState,
  updateEntity,
} from '../src/modules/assets.js';
import { createShot } from '../src/modules/shots.js';
import { compilePrompt } from '../src/modules/prompt.js';
import { removeStoredMediaFiles } from '../src/modules/media.js';

const roots: string[] = [];
after(() => { for (const root of roots) cleanupTempRoot(root); });

test('entity images are inherited by state unless the state has an override', async () => {
  const { root, store } = await makeStore('asset-images');
  roots.push(root);
  const project = await makeProject(store, 'entity image inheritance');
  const entityImage = insertMedia(project, {
    kind: 'image', fileName: 'assets/entity.png', mimeType: 'image/png', sizeBytes: 1, label: 'Entity image',
  });
  const stateImage = insertMedia(project, {
    kind: 'image', fileName: 'assets/state.png', mimeType: 'image/png', sizeBytes: 1, label: 'State image',
  });
  const entity = createEntity(project, { kind: 'character', name: 'MISE', imageAssetId: entityImage.id });
  const state = createCharacterState(project, { characterId: entity.id, name: 'Rain', costume: 'wet' });

  assert.equal(entity.imageAssetId, entityImage.id);
  assert.equal(state.imageAssetId, null);
  assert.equal(state.effectiveImageAssetId, entityImage.id);
  const overridden = updateCharacterState(project, state.id, { imageAssetId: stateImage.id });
  assert.equal(overridden.imageAssetId, stateImage.id);
  assert.equal(overridden.effectiveImageAssetId, stateImage.id);
});

test('deleting media clears entity/state images and reference bindings', async () => {
  const { root, store } = await makeStore('asset-delete');
  roots.push(root);
  const project = await makeProject(store, 'asset delete');
  const image = insertMedia(project, {
    kind: 'image', fileName: 'assets/shared.png', mimeType: 'image/png', sizeBytes: 1, label: 'Shared image',
  });
  const entity = createEntity(project, { kind: 'character', name: 'MISE', imageAssetId: image.id });
  const state = createCharacterState(project, { characterId: entity.id, name: 'Wet', imageAssetId: image.id });
  createBinding(project, { assetId: image.id, roles: [], label: 'RefImage' });

  assert.deepEqual(mediaUsage(project, image.id), { bindings: 1, entities: 1, states: 1 });
  deleteMedia(project, image.id);

  assert.equal(getEntity(project, entity.id).imageAssetId, null);
  const clearedState = listCharacterStates(project).find((item) => item.id === state.id);
  assert.equal(clearedState?.imageAssetId, null);
  assert.equal(clearedState?.effectiveImageAssetId, null);
  assert.equal(listBindings(project).length, 0);
});

test('media file cleanup removes the project-owned file', async () => {
  const { root, store } = await makeStore('asset-file-delete');
  roots.push(root);
  const project = await makeProject(store, 'asset file delete');
  const relPath = 'assets/delete-me.png';
  await mkdir(join(project.root, 'assets'), { recursive: true });
  await writeFile(project.resolveProjectPath(relPath), Buffer.from([1, 2, 3]));
  const image = insertMedia(project, {
    kind: 'image', fileName: relPath, mimeType: 'image/png', sizeBytes: 3, label: 'Delete me',
  });

  await removeStoredMediaFiles(project, image);
  await assert.rejects(access(project.resolveProjectPath(relPath)));
});

test('Ref2VA automatically binds selected character and scene images without duplicates', async () => {
  const { root, store } = await makeStore('asset-shot-refs');
  roots.push(root);
  const project = await makeProject(store, 'shot entity references');
  const characterImage = insertMedia(project, {
    kind: 'image', fileName: 'assets/character.png', mimeType: 'image/png', sizeBytes: 1, label: 'MISE · 主图',
  });
  const sceneImage = insertMedia(project, {
    kind: 'image', fileName: 'assets/scene.png', mimeType: 'image/png', sizeBytes: 1, label: '放映室 · 主图',
  });
  const character = createEntity(project, { kind: 'character', name: 'MISE', imageAssetId: characterImage.id });
  const scene = createEntity(project, { kind: 'scene', name: '放映室', imageAssetId: sceneImage.id });
  const shot = createShot(project, {
    title: '测试镜头', h3Mode: 'ref2va', primaryCharacterId: character.id, sceneId: scene.id,
  });

  const first = ensureShotEntityImageBindings(project, shot);
  const second = ensureShotEntityImageBindings(project, shot);

  assert.deepEqual(first.bindings.map((binding) => binding.assetId), [characterImage.id, sceneImage.id]);
  assert.deepEqual(first.bindings.map((binding) => binding.roles), [['identity'], ['environment']]);
  assert.deepEqual(first.bindings.map((binding) => binding.sourceEntityId), [character.id, scene.id]);
  assert.equal(first.added.length, 2);
  assert.equal(second.added.length, 0);
  assert.equal(second.bindings.length, 2);
  const prompt = compilePrompt(project, shot.id, 'ref2va');
  assert.match(prompt.text, /<Picture 1> MISE · 主图/);
  assert.match(prompt.text, /<Picture 2> 放映室 · 主图/);

  const replacementSceneImage = insertMedia(project, {
    kind: 'image', fileName: 'assets/scene-new.png', mimeType: 'image/png', sizeBytes: 1, label: '放映室 · 新主图',
  });
  updateEntity(project, scene.id, { imageAssetId: replacementSceneImage.id });
  const replaced = ensureShotEntityImageBindings(project, shot);
  assert.deepEqual(replaced.bindings.map((binding) => binding.assetId), [characterImage.id, replacementSceneImage.id]);
  assert.equal(replaced.bindings.some((binding) => binding.assetId === sceneImage.id), false);
});
