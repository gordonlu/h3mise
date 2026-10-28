import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ProviderRegistry, defaultAiAppProfile, mapDiscoveredNodes, inferSupportedModes } from '../src/providers/registry.js';
import { Ffmpeg } from '../src/ffmpeg.js';
import { makeStore, makeProject, cleanupTempRoot } from './helpers.js';
import type { RenderRequestInput } from '../src/providers/types.js';

const roots: string[] = [];
after(() => roots.forEach(cleanupTempRoot));
const nodes = [
  { nodeId: 'prompt-frame', nodeName: 'Text', fieldName: 'prompt', fieldType: 'STRING', fieldData: null, description: 'Prompt' },
  { nodeId: 'start-frame', nodeName: 'LoadImage', fieldName: 'image', fieldType: 'IMAGE', fieldData: null, description: '首帧' },
  { nodeId: 'end-frame', nodeName: 'LoadImage', fieldName: 'image', fieldType: 'IMAGE', fieldData: null, description: '尾帧' },
];

test('frame discovery, submission and verification stay separate from the primary App', async () => {
  const { root, store } = await makeStore('frame-profile'); roots.push(root);
  await makeProject(store, 'Frame modes');
  const registry = new ProviderRegistry(() => store.current, () => store.registry, new Ffmpeg(), 'test-key', 'runninghub');
  const primary = { ...defaultAiAppProfile(), appId: 'primary-app', concurrency: 2,
    nodes: [], inputs: mapDiscoveredNodes([]), verification: { status: 'verified' as const, checkedAt: '2026-01-01', note: 'Existing evidence' } };
  store.registry.run("INSERT INTO provider_profiles (id, profile_json, updated_at) VALUES ('runninghub', ?, ?)", [JSON.stringify(primary), '2026-01-01']);
  registry.refresh();
  assert.equal(registry.getFrameProfile(), null);
  assert.equal(registry.getProfileForMode('fl2va')?.appId, 'primary-app', 'legacy fallback');
  const saved = registry.saveFrameProfile({ appId: 'frame-app', verification: { status: 'verified' } });
  assert.equal(saved.verification.status, 'unconfigured', 'cannot forge discovery');
  assert.deepEqual((await registry.capabilities('runninghub', 'fl2va'))?.supportedModes, []);
  const originalFetch = globalThis.fetch;
  const submissions: Array<{ url: string; body: { nodeInfoList: Array<{ nodeId: string; fieldValue: string }> } }> = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('apiCallDemo')) return new Response(JSON.stringify({ code: 0, data: { nodeInfoList: nodes } }));
    submissions.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response('{"taskId":"frame-task","status":"RUNNING"}');
  };
  try {
    const detected = await registry.detectFrameProfile();
    assert.equal(detected.verification.status, 'nodes_detected');
    assert.deepEqual(detected.capabilities.supportedModes, ['i2va', 'l2va', 'fl2va']);
    assert.equal(registry.getProfileForMode('ref2va')?.appId, 'primary-app');
    assert.equal(registry.getProfileForMode('fl2va')?.appId, 'frame-app');
    assert.equal(registry.concurrencyLimit('runninghub'), 2, 'both Apps share account concurrency');
    const request = { mode: 'fl2va', prompt: 'A still natural scene', durationSeconds: 6, aspectRatio: '16:9', providerParams: {},
      references: [
        { asset: { kind: 'image' }, roles: ['first_frame'], providerRef: 'first.png' },
        { asset: { kind: 'image' }, roles: ['last_frame'], providerRef: 'last.png' },
      ],
    } as unknown as RenderRequestInput;
    await registry.get('runninghub', 'fl2va')!.submit(request);
    assert.ok(submissions[0]!.url.endsWith('/frame-app'));
    assert.ok(submissions[0]!.body.nodeInfoList.some(n => n.nodeId === 'start-frame' && n.fieldValue === 'first.png'));
    assert.ok(submissions[0]!.body.nodeInfoList.some(n => n.nodeId === 'end-frame' && n.fieldValue === 'last.png'));
    registry.confirmFrameVerified('wrong-app');
    assert.equal(registry.getFrameProfile()?.verification.status, 'nodes_detected');
    registry.confirmFrameVerified('frame-app');
    assert.equal(registry.getFrameProfile()?.verification.status, 'verified');
    assert.equal(registry.getProfile()?.verification.checkedAt, '2026-01-01', 'primary receipt unchanged');
    registry.saveFrameProfile({ appId: 'new-frame-app' });
    assert.equal(registry.getFrameProfile()?.verification.status, 'unconfigured');
    assert.deepEqual((await registry.capabilities('runninghub', 'i2va'))?.supportedModes, []);
    assert.equal(registry.getProfile()?.appId, 'primary-app');
    registry.saveProfile({ ...registry.getProfile()!, region: 'global' });
    assert.equal(registry.getFrameProfile()?.verification.status, 'unconfigured', 'region change invalidates frame evidence');
    assert.deepEqual((await registry.capabilities('runninghub', 'fl2va'))?.supportedModes, []);
  } finally { globalThis.fetch = originalFetch; }
});

test('generic image ports never masquerade as first/last-frame ports', () => {
  const generic = nodes.map(node => ({ ...node, description: node.fieldType === 'IMAGE' ? 'image' : 'Prompt' }));
  const inputs = mapDiscoveredNodes(generic);
  assert.deepEqual(inferSupportedModes(inputs, generic), ['t2va', 'ref2va']);
});
