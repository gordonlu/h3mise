import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { MediaAsset } from '@h3mise/shared';
import { cleanupTempRoot, makeProject, makeStore, makeTempRoot } from './helpers.js';
import { Ffmpeg } from '../src/ffmpeg.js';
import { ProviderRegistry, defaultAiAppProfile } from '../src/providers/registry.js';
import { RunningHubAiAppProvider } from '../src/providers/runninghub.js';

const roots: string[] = [];
after(() => roots.forEach((root) => cleanupTempRoot(root)));

test('Global RunningHub profile sends discovery and paid submission to runninghub.ai', async () => {
  const profile = defaultAiAppProfile('global');
  const provider = new RunningHubAiAppProvider({ apiKey: 'test-key', profile });
  const urls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('apiCallDemo')) {
      return new Response(JSON.stringify({ code: 200, data: { nodeInfoList: [] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ taskId: 'global-task', status: 'QUEUED' }), { status: 200 });
  };
  try {
    await provider.discoverNodes();
    await provider.submit({ mode: 't2va', prompt: 'Global test', durationSeconds: 5, aspectRatio: '16:9', references: [], providerParams: {} });
    assert.equal(urls.length, 2);
    assert.ok(urls.every((url) => url.startsWith('https://www.runninghub.ai/')));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Global upload accepts the documented code 200 and lowercase filename response', async () => {
  const root = makeTempRoot('runninghub-global-upload');
  roots.push(root);
  const file = join(root, 'reference.png');
  await writeFile(file, new Uint8Array([1, 2, 3]));
  const provider = new RunningHubAiAppProvider({ apiKey: 'test-key', profile: defaultAiAppProfile('global') });
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ code: 200, message: 'success', data: { filename: 'openapi/global-reference.png' } }), { status: 200 });
  };
  try {
    const asset: MediaAsset = {
      id: 'asset-global', kind: 'image', fileName: 'reference.png', mimeType: 'image/png', sizeBytes: 3,
      source: 'import', label: 'Global reference', tags: [], createdAt: new Date().toISOString(),
    };
    const uploaded = await provider.uploadAsset(asset, file);
    assert.equal(requestedUrl, 'https://www.runninghub.ai/openapi/v2/media/upload/binary');
    assert.equal(uploaded.providerRef, 'openapi/global-reference.png');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('switching RunningHub region updates both profiles and invalidates old verification', async () => {
  const { root, store } = await makeStore('runninghub-region-switch');
  roots.push(root);
  await makeProject(store, 'Region Switch');
  const registry = new ProviderRegistry(() => store.current, () => store.registry, new Ffmpeg(), null, 'runninghub');
  registry.refresh();
  registry.saveApiKey('cn-key');
  const videoProfile = registry.getProfile()!;
  registry.saveProfile({
    ...videoProfile,
    verification: { status: 'verified', checkedAt: new Date().toISOString(), note: 'old region verified' },
  });
  registry.saveStoryboardProfile({
    ...registry.getStoryboardProfile(),
    verification: { status: 'verified', checkedAt: new Date().toISOString(), note: 'old region verified' },
  });

  const changed = registry.setRunningHubRegion('global');

  assert.equal(changed.profile.region, 'global');
  assert.match(changed.profile.invokeUrl, /^https:\/\/www\.runninghub\.ai\//);
  assert.equal(changed.profile.verification.status, 'unconfigured');
  assert.equal(changed.storyboardProfile.region, 'global');
  assert.match(changed.storyboardProfile.invokeUrl, /^https:\/\/www\.runninghub\.ai\//);
  assert.equal(changed.storyboardProfile.verification.status, 'unconfigured');
  assert.deepEqual(changed.storyboardProfile.nodes, []);
  assert.equal(registry.getApiKey(), null, 'a Mainland settings key is never reused on Global');
  registry.saveApiKey('global-key');
  assert.equal(registry.getApiKey(), 'global-key');
  registry.setRunningHubRegion('cn');
  assert.equal(registry.getApiKey(), 'cn-key', 'regional settings keys remain isolated');
});
