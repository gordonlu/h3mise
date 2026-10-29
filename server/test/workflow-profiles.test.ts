import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AiAppProfile, H3Mode } from '@h3mise/shared';
import { ProviderRegistry, defaultAiAppProfile, inferSupportedModes, mapDiscoveredNodes } from '../src/providers/registry.js';
import { RunningHubAiAppProvider } from '../src/providers/runninghub.js';
import { Ffmpeg } from '../src/ffmpeg.js';
import { cleanupTempRoot, makeStore } from './helpers.js';
import type { RenderRequestInput } from '../src/providers/types.js';

const roots: string[] = [];
after(() => roots.forEach((root) => cleanupTempRoot(root)));

function node(nodeId: string, fieldName: string, description: string, fieldType = 'file'): AiAppProfile['nodes'][number] {
  return { nodeId, nodeName: fieldName, fieldName, fieldType, fieldData: null, description };
}

function registryWithProfile(store: Awaited<ReturnType<typeof makeStore>>['store'], profile: AiAppProfile): ProviderRegistry {
  store.registry.run("INSERT INTO provider_profiles (id, profile_json, updated_at) VALUES ('runninghub', ?, ?)", [JSON.stringify(profile), new Date().toISOString()]);
  return new ProviderRegistry(() => null, () => store.registry, new Ffmpeg(), 'test-key', 'runninghub');
}

function mappedNodes() {
  return [
    node('250', 'prompt', 'Prompt'),
    node('231', 'image', '参考图1'),
    node('232', 'image', '参考图2'),
    node('247', 'audio', '参考音频1', 'AUDIO'),
  ];
}

const faceswapNodes = [
  node('310', 'prompt', 'Prompt'),
  node('308', 'aspect_ratio', '视频比例', 'LIST'),
  node('322', 'image', '人脸图片'),
  node('359', 'file', '源视频', 'VIDEO'),
];

function mainProfile(): AiAppProfile {
  const inputs = mapDiscoveredNodes(mappedNodes());
  const capabilities = { supportedModes: ['t2va', 'ref2va'] as H3Mode[], maxImageRefs: 2, maxAudioRefs: 1, maxVideoRefs: 0, maxTotalRefs: 3 };
  return {
    ...defaultAiAppProfile(),
    appId: 'main-app',
    apps: [{
      id: 'main', name: '主工作流', appId: 'main-app', inputs, nodes: mappedNodes(),
      capabilities,
      verification: { status: 'verified', checkedAt: '2026-01-01', note: 'verified' },
    }],
    activeWorkflowId: 'main',
    inputs,
    nodes: mappedNodes(),
    capabilities,
    verification: { status: 'verified', checkedAt: '2026-01-01', note: 'verified' },
  };
}

test('saved apps are self-contained workflows; activation requires their own mapping', async () => {
  const { root, store } = await makeStore('workflow-owns-mapping');
  roots.push(root);
  const inputs = mapDiscoveredNodes(mappedNodes());
  const profile: AiAppProfile = {
    ...defaultAiAppProfile(),
    appId: 'main-app',
    apps: [{
      id: 'main', name: '主工作流', appId: 'main-app', inputs, nodes: mappedNodes(),
      capabilities: { supportedModes: ['t2va', 'ref2va'], maxImageRefs: 2, maxAudioRefs: 1, maxVideoRefs: 0, maxTotalRefs: 3 },
      verification: { status: 'verified', checkedAt: '2026-01-01', note: 'verified' },
    }],
    activeWorkflowId: 'main',
    inputs,
    nodes: mappedNodes(),
    capabilities: { supportedModes: ['t2va', 'ref2va'], maxImageRefs: 2, maxAudioRefs: 1, maxVideoRefs: 0, maxTotalRefs: 3 },
    verification: { status: 'verified', checkedAt: '2026-01-01', note: 'verified' },
  };
  const registry = registryWithProfile(store, profile);

  const unmapped = registry.upsertWorkflow({ id: 'face', name: '换脸', appId: 'face-app' });
  assert.equal(unmapped.runnable, false);
  assert.equal(unmapped.inputs, undefined);
  assert.throws(() => registry.activateWorkflow('face'), /没有节点映射/);
  assert.equal(registry.getProfile()?.appId, 'main-app');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.match(String(input), /apiCallDemo/);
    return new Response(JSON.stringify({ code: 0, data: { nodeInfoList: faceswapNodes } }));
  };
  try {
    const verified = await registry.verifyWorkflow('face');
    assert.equal(verified.verification?.status, 'nodes_detected');
    assert.deepEqual(verified.modes, ['faceswap', 'vref2va']);
    assert.ok(verified.readiness?.find((item) => item.mode === 'faceswap')?.ready);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const activated = registry.activateWorkflow('face');
  assert.equal(activated.appId, 'face-app');
  assert.equal(activated.activeWorkflowId, 'face');
  assert.equal(activated.apps[0]?.id, 'face', 'active workflow is mirrored and listed first');
  assert.deepEqual(activated.inputs.refImages.map((slot) => slot.nodeId), ['322']);
  assert.deepEqual(activated.inputs.refVideos?.map((slot) => slot.nodeId), ['359']);

  const preview = registry.previewWorkflow('face', 'faceswap');
  assert.ok(preview.nodeInfoList.some((item) => item.nodeId === '322' && item.fieldValue.includes('image')));
  assert.ok(preview.nodeInfoList.some((item) => item.nodeId === '359' && item.fieldValue.includes('video')));
  assert.ok(!preview.nodeInfoList.some((item) => item.nodeId === '250'), 'never borrows the primary workflow nodes');
});

test('faceswap mode inference and payload require exactly one face image and one source video', () => {
  const nodes = faceswapNodes;
  const inputs = mapDiscoveredNodes(nodes);
  assert.deepEqual(inferSupportedModes(inputs, nodes), ['faceswap', 'vref2va']);

  const profile: AiAppProfile = {
    ...defaultAiAppProfile(),
    appId: 'face-app',
    inputs,
    nodes,
    capabilities: { supportedModes: ['faceswap'], maxImageRefs: 1, maxVideoRefs: 1, maxAudioRefs: 0, maxTotalRefs: 2, preservesSourceAudio: true },
    verification: { status: 'nodes_detected', checkedAt: null, note: 'test' },
  };
  const provider = new RunningHubAiAppProvider({ apiKey: 'test-key', profile });
  const base = {
    mode: 'faceswap' as H3Mode,
    prompt: '换脸并保留源音频',
    durationSeconds: 5,
    aspectRatio: '16:9',
    providerParams: {},
  };
  const image = { asset: { kind: 'image' }, roles: [], label: 'face', providerRef: 'face.png' };
  const video = { asset: { kind: 'video' }, roles: [], label: 'source', providerRef: 'source.mp4' };
  const built = provider.previewNodeInfoList({ ...base, references: [image, video] } as unknown as RenderRequestInput);
  assert.deepEqual(built.filter((item) => ['322', '359'].includes(item.nodeId)).map((item) => [item.nodeId, item.fieldValue]), [
    ['322', 'face.png'],
    ['359', 'source.mp4'],
  ]);
  assert.throws(() => provider.previewNodeInfoList({ ...base, references: [image, image] } as unknown as RenderRequestInput), /恰好一个源视频/);
  assert.throws(() => provider.previewNodeInfoList({ ...base, references: [video] } as unknown as RenderRequestInput), /恰好一张人脸图片/);
});

test('PUT-style profile input ignores read-only fields and keeps appId/apps invariant', async () => {
  const { root, store } = await makeStore('workflow-readonly');
  roots.push(root);
  const inputs = mapDiscoveredNodes(mappedNodes());
  const registry = registryWithProfile(store, {
    ...defaultAiAppProfile(),
    appId: 'main-app',
    inputs,
    apps: [{ id: 'main', name: 'Main', appId: 'main-app', inputs, capabilities: { supportedModes: ['t2va'] }, verification: { status: 'nodes_detected', checkedAt: null, note: 'test' } }],
    activeWorkflowId: 'main',
    verification: { status: 'nodes_detected', checkedAt: null, note: 'test' },
  });
  const current = registry.getProfile()!;
  const saved = registry.saveProfile({
    ...current,
    bindingSlots: { firstFrame: true },
    slotsByMode: { faceswap: { images: 99 } },
    activeModes: ['faceswap'],
    apps: current.apps.map((entry) => ({ ...entry, readiness: [{ mode: 'faceswap', supported: true, ready: true, missing: [] }] })),
  });
  assert.equal(saved.appId, saved.apps[0]?.appId);
  assert.equal(saved.activeWorkflowId, 'main');
  assert.equal((saved as unknown as Record<string, unknown>).bindingSlots, undefined);
  assert.equal((saved as unknown as Record<string, unknown>).slotsByMode, undefined);
  assert.equal((saved as unknown as Record<string, unknown>).activeModes, undefined);
  assert.ok(Array.isArray(saved.apps[0]?.readiness), 'server recomputes readiness; client-provided readiness is ignored');
  assert.throws(() => registry.saveProfile({ ...current, activeWorkflowId: 'missing' }), /does not match/);
});

test('explicit faceswap kind overrides an optional-looking video field', async () => {
  const { root, store } = await makeStore('workflow-faceswap-kind');
  roots.push(root);
  const nodes = faceswapNodes.map((entry) => entry.nodeId === '359'
    ? { ...entry, fieldData: '["COMBO", {"options": ["None"], "video_upload": true}]' }
    : entry);
  const inferred = mapDiscoveredNodes(nodes);
  assert.ok(!inferSupportedModes(inferred, nodes).includes('faceswap'), 'optional-looking video is not guessed as faceswap');
  assert.ok(inferSupportedModes(inferred, nodes, 'faceswap').includes('faceswap'), 'explicit kind wins');
  const registry = registryWithProfile(store, mainProfile());
  registry.upsertWorkflow({ id: 'face', name: '换脸', appId: 'face-app', kind: 'faceswap' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { nodeInfoList: nodes } }));
  try {
    const verified = await registry.verifyWorkflow('face');
    assert.ok(verified.modes?.includes('faceswap'));
    assert.equal(verified.readiness?.find((item) => item.mode === 'faceswap')?.ready, true);
    const preview = registry.previewWorkflow('face', 'faceswap');
    assert.ok(preview.nodeInfoList.some((item) => item.nodeId === '359'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('stored faceswap workflows repair legacy mode lists when read', async () => {
  const { root, store } = await makeStore('workflow-faceswap-repair');
  roots.push(root);
  const inputs = mapDiscoveredNodes(faceswapNodes);
  const profile = mainProfile();
  profile.apps.push({
    id: 'face', name: '换脸', appId: 'face-app', kind: 'faceswap',
    inputs, nodes: faceswapNodes,
    capabilities: { supportedModes: ['t2va', 'ref2va', 'vref2va'], maxImageRefs: 1, maxVideoRefs: 1, maxAudioRefs: 0, maxTotalRefs: 2 },
    verification: { status: 'nodes_detected', checkedAt: '2026-01-01', note: 'legacy evidence' },
  });
  const registry = registryWithProfile(store, profile);
  const face = registry.getProfile()?.apps.find((entry) => entry.id === 'face');
  assert.ok(face?.modes?.includes('faceswap'));
  assert.equal(face?.readiness?.find((item) => item.mode === 'faceswap')?.ready, true);
});
