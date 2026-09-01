import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDirectorPlan } from '@h3mise/shared';
import type { AiAppProfile, ReferenceBinding, Shot } from '@h3mise/shared';
import { ProviderError } from '../src/providers/types.js';
import type { RenderRequestInput } from '../src/providers/types.js';
import { importableKindForMime } from '../src/modules/media.js';
import { compileDeterministic } from '../src/modules/prompt-templates.js';
import { defaultAiAppProfile, inferSupportedModes, mapDiscoveredNodes, mapStoryboardProviderNodes } from '../src/providers/registry.js';
import { RunningHubAiAppProvider } from '../src/providers/runninghub.js';

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

test('node discovery maps aspect ratio and megapixels to different workflow fields', () => {
  const nodes = [
    node('shape', 'aspect_ratio', '视频比例'),
    node('shape', 'megapixels', 'megapixels'),
  ];
  const inputs = mapDiscoveredNodes(nodes);

  assert.deepEqual(inputs.resolution, { nodeId: 'shape', fieldName: 'aspect_ratio' });
  assert.deepEqual(inputs.megapixels, { nodeId: 'shape', fieldName: 'megapixels' });
});

test('storyboard discovery maps LoadImage instead of an image model size field', () => {
  const inputs = mapStoryboardProviderNodes([
    { nodeId: '1', nodeName: 'CR Text', fieldName: 'text', fieldType: 'STRING', fieldData: '["STRING"]', description: 'Prompt' },
    { nodeId: '12', nodeName: 'RH_Jimeng4_Image2Image', fieldName: 'size', fieldType: 'LIST', fieldData: '[["2K","4K"]]', description: '分辨率' },
    { nodeId: '16', nodeName: 'LoadImage', fieldName: 'image', fieldType: 'IMAGE', fieldData: '[["example.png"],{"image_upload":true}]', description: '参考图' },
  ]);

  assert.deepEqual(inputs, {
    prompt: { nodeId: '1', fieldName: 'text' },
    size: { nodeId: '12', fieldName: 'size' },
    layoutImage: { nodeId: '16', fieldName: 'image' },
  });
});

test('RunningHub submission payload sends the selected megapixels value to its workflow node', () => {
  const profile = defaultAiAppProfile();
  profile.nodes = [
    node('shape', 'aspect_ratio', '视频比例'),
    node('shape', 'megapixels', 'megapixels'),
  ];
  profile.inputs.resolution = { nodeId: 'shape', fieldName: 'aspect_ratio' };
  profile.inputs.megapixels = { nodeId: 'shape', fieldName: 'megapixels' };
  const provider = new RunningHubAiAppProvider({ apiKey: 'test-key', profile });
  const request: RenderRequestInput = {
    mode: 't2va',
    prompt: 'test',
    durationSeconds: 5,
    aspectRatio: '16:9',
    megapixels: 1.2,
    references: [],
    providerParams: {},
  };

  const nodeInfoList = (provider as unknown as {
    buildNodeInfoList(input: RenderRequestInput): Array<{ nodeId: string; fieldName: string; fieldValue: string }>;
  }).buildNodeInfoList(request);

  assert.ok(nodeInfoList.some((item) => item.nodeId === 'shape' && item.fieldName === 'megapixels' && item.fieldValue === '1.2'));
});

test('RunningHub refuses an empty prompt before any network request', () => {
  const provider = new RunningHubAiAppProvider({ apiKey: 'test-key', profile: defaultAiAppProfile() });
  assert.throws(() => provider.submit({
    mode: 't2va', prompt: '   ', durationSeconds: 5, aspectRatio: '16:9', references: [], providerParams: {},
  }), /prompt is empty/);
});

test('RunningHub marks error 421 as provider-capacity backoff before a task id exists', async () => {
  const provider = new RunningHubAiAppProvider({ apiKey: 'test-key', profile: defaultAiAppProfile() });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ errorCode: '421', errorMessage: 'api queue limit reached' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  try {
    await assert.rejects(
      provider.submit({ mode: 't2va', prompt: '有效镜头提示词', durationSeconds: 5, aspectRatio: '16:9', references: [], providerParams: {} }),
      (error: unknown) => error instanceof ProviderError
        && error.stage === 'submit'
        && error.retry?.reason === 'provider_capacity'
        && error.retry.afterMs === 30_000,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reference media import accepts images and audio but routes video through Shot Takes', () => {
  assert.equal(importableKindForMime('image/png'), 'image');
  assert.equal(importableKindForMime('audio/mpeg'), 'audio');
  assert.throws(() => importableKindForMime('video/mp4'), /Shot 的 Takes 区导入/);
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
  // Ref2VA keeps the first_frame-designated picture among the numbered
  // references AND pins it as the literal start frame in the prompt text.
  assert.match(ref2va, /generic-ref/);
  assert.match(ref2va, /first-frame/);
  assert.match(ref2va, /First frame:.*<Picture 2>[\s\S]*?literal first frame/);
});
