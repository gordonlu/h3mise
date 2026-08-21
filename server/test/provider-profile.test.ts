import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDirectorPlan } from '@h3mise/shared';
import type { AiAppProfile, ReferenceBinding, Shot } from '@h3mise/shared';
import { importableKindForMime } from '../src/modules/media.js';
import { compileDeterministic } from '../src/modules/prompt-templates.js';
import { inferSupportedModes, mapDiscoveredNodes } from '../src/providers/registry.js';

function node(nodeId: string, fieldName: string, description: string): AiAppProfile['nodes'][number] {
  return { nodeId, nodeName: fieldName, fieldName, fieldType: 'file', fieldData: null, description };
}

test('node discovery keeps RefImages and RefAudios in separate slot arrays', () => {
  const nodes = [
    node('prompt', 'prompt', '提示词'),
    node('first', 'image', '首帧'),
    node('last', 'image', '尾帧'),
    node('ref-image-1', 'ref_image_0', '参考图 1'),
    node('ref-audio-1', 'ref_audio_0', 'reference audio 1'),
  ];
  const inputs = mapDiscoveredNodes(nodes);

  assert.deepEqual(inputs.refImages.map((slot) => slot.nodeId), ['ref-image-1']);
  assert.deepEqual(inputs.refAudios.map((slot) => slot.nodeId), ['ref-audio-1']);
});

test('mode inference does not treat RefImages as FirstFrame or LastFrame', () => {
  const nodes = [node('prompt', 'prompt', '提示词'), node('ref-image-1', 'ref_image_0', '参考图 1')];
  const inputs = mapDiscoveredNodes(nodes);

  assert.deepEqual(inferSupportedModes(inputs, nodes), ['t2va', 'ref2va']);
});

test('frame slots exclusively enable their matching frame modes', () => {
  const nodes = [
    node('prompt', 'prompt', '提示词'),
    node('first', 'image', '首帧'),
    node('last', 'image', '尾帧'),
  ];
  const inputs = mapDiscoveredNodes(nodes);

  assert.deepEqual(inferSupportedModes(inputs, nodes), ['t2va', 'i2va', 'l2va', 'fl2va']);
});

test('project media import accepts images and audio but rejects video', () => {
  assert.equal(importableKindForMime('image/png'), 'image');
  assert.equal(importableKindForMime('audio/mpeg'), 'audio');
  assert.throws(() => importableKindForMime('video/mp4'), /视频上传已关闭/);
});

function binding(id: string, roles: ReferenceBinding['roles']): ReferenceBinding {
  return {
    id, assetId: id, type: 'image', roles, preserve: [], ignore: [], label: id,
    shotId: 'shot-test', createdAt: '2026-08-21T00:00:00.000Z',
  };
}

test('prompt compiler never substitutes generic RefImages for frame inputs', () => {
  const context = {
    shot: {} as Shot,
    plan: emptyDirectorPlan(),
    references: [binding('generic-ref', []), binding('first-frame', ['first_frame'])],
  };

  const i2va = compileDeterministic(context, 'i2va');
  assert.match(i2va, /first-frame/);
  assert.doesNotMatch(i2va, /generic-ref/);

  const l2va = compileDeterministic(context, 'l2va');
  assert.doesNotMatch(l2va, /generic-ref|first-frame/);

  const ref2va = compileDeterministic(context, 'ref2va');
  assert.match(ref2va, /generic-ref/);
  assert.doesNotMatch(ref2va, /first-frame/);
});
