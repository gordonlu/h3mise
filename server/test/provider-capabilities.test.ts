// RunningHub exposes one account across several Apps. The UI and the shot
// composer must see the union of the primary App and a verified frame App,
// while an unverified frame App must never advertise frame modes.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AiAppProfile } from '@h3mise/shared';
import { cleanupTempRoot, makeStore } from './helpers.js';
import { defaultAiAppProfile, mapDiscoveredNodes, ProviderRegistry } from '../src/providers/registry.js';
import { Ffmpeg } from '../src/ffmpeg.js';
import { j } from '../src/db/sqlite.js';

const roots: string[] = [];
after(() => {
  for (const root of roots) cleanupTempRoot(root);
});

function node(nodeId: string, fieldName: string, description: string): AiAppProfile['nodes'][number] {
  return { nodeId, nodeName: fieldName, fieldName, fieldType: 'file', fieldData: null, description };
}

function frameProfile(verification: AiAppProfile['verification']['status']): AiAppProfile {
  return {
    ...defaultAiAppProfile(),
    appId: 'frame-app',
    inputs: mapDiscoveredNodes([
      node('p', 'prompt', 'Prompt'),
      node('i', 'image', 'first frame'),
      node('o', 'image', 'last frame'),
    ]),
    capabilities: { supportedModes: ['i2va', 'l2va', 'fl2va'] },
    verification: { status: verification, checkedAt: null, note: 'test' },
  };
}

test('account capabilities merge a verified separate frame App', async () => {
  const { root, store } = await makeStore('account-caps');
  roots.push(root);
  const registry = new ProviderRegistry(() => null, () => store.registry, new Ffmpeg(), null, 'runninghub');
  registry.saveProfile({
    ...defaultAiAppProfile(),
    capabilities: { supportedModes: ['t2va', 'ref2va'] },
    verification: { status: 'verified', checkedAt: null, note: 'test' },
  });
  store.registry.run(
    "INSERT INTO provider_profiles (id, profile_json, updated_at) VALUES ('runninghub_frames', ?, datetime('now'))",
    [j(frameProfile('verified'))],
  );

  const merged = await registry.accountCapabilities('runninghub');
  assert.deepEqual([...(merged?.supportedModes ?? [])].sort(), ['fl2va', 'i2va', 'l2va', 'ref2va', 't2va']);

  store.registry.run(
    "UPDATE provider_profiles SET profile_json = ? WHERE id = 'runninghub_frames'",
    [j(frameProfile('unconfigured'))],
  );
  const blocked = await registry.accountCapabilities('runninghub');
  assert.deepEqual([...(blocked?.supportedModes ?? [])].sort(), ['ref2va', 't2va']);
});
