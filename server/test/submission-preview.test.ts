import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cleanupTempRoot, makeProject, makeStore } from './helpers.js';
import { defaultAiAppProfile, ProviderRegistry } from '../src/providers/registry.js';
import { Ffmpeg } from '../src/ffmpeg.js';
import { createShot } from '../src/modules/shots.js';
import { createBinding, insertMedia } from '../src/modules/assets.js';
import { importRawPrompt } from '../src/modules/prompt.js';
import { intentFromInput } from '../src/modules/preflight.js';
import { buildSubmissionPreview } from '../src/modules/shot-production.js';

const roots: string[] = [];
after(() => roots.forEach((root) => cleanupTempRoot(root)));

test('RunningHub payload preview maps five ordered references and records only successful exact evidence', async () => {
  const { root, store } = await makeStore('rh-payload-preview');
  roots.push(root);
  const project = await makeProject(store, 'Payload preview');
  const shot = createShot(project, { title: 'Five refs', purpose: 'Preview only', durationSeconds: 6, aspectRatio: '3:4', h3Mode: 'ref2va' });
  const assets = Array.from({ length: 5 }, (_, index) => insertMedia(project, {
    kind: 'image', fileName: `assets/ref-${index}.png`, mimeType: 'image/png', sizeBytes: 1, width: 720, height: 960, label: `R${index + 1}`,
  }));
  const bindings = assets.map((asset, index) => createBinding(project, {
    assetId: asset.id, shotId: shot.id, roles: index === 0 ? ['identity'] : [], framePolicy: 'reference_only', label: `R${index + 1}`,
  }));
  const reordered = [bindings[4]!, ...bindings.slice(0, 4)];
  project.db.tx(() => reordered.forEach((binding, index) => project.db.run('UPDATE reference_bindings SET position = ? WHERE id = ?', [index + 1, binding.id])));
  const prompt = importRawPrompt(project, shot.id, '<Picture 1> <Picture 2> <Picture 3> <Picture 4> <Picture 5> ancient room, soft light, fixed camera, calm performance, full robe.', 'ref2va');
  const registry = new ProviderRegistry(() => store.current, () => store.registry, new Ffmpeg(), null, 'mock', undefined, join(root, 'mock'));
  registry.refresh();
  const profile = defaultAiAppProfile();
  const slot = (nodeId: string, fieldName: string) => ({ nodeId, fieldName });
  registry.saveProfile({
    ...profile,
    appId: 'mock-app-id',
    inputs: {
      ...profile.inputs,
      prompt: slot('1', 'prompt'),
      duration: slot('2', 'duration'),
      resolution: slot('3', 'aspect_ratio'),
      megapixels: slot('4', 'megapixels'),
      refImages: Array.from({ length: 5 }, (_, index) => slot(`${10 + index}`, 'image')),
    },
    capabilities: { supportedModes: ['ref2va'], supportedAspectRatios: ['3:4'], maxImageRefs: 9, costEstimate: { cnyPerTask: 0.2, cnyPerSecond: 0.01, failureCharge: 'unknown', note: 'Mock price evidence' } },
    verification: { status: 'verified', checkedAt: '2026-01-01T00:00:00.000Z', note: 'Mock profile only; no network was called' },
  });
  registry.confirmSubmission('mock-app-id', 'ref2va');
  assert.equal(registry.getProfileForMode('ref2va')?.capabilities.testedCombinations?.length ?? 0, 0, 'taskId evidence is not exact success evidence');
  const intent = await intentFromInput(project, registry, { shotId: shot.id, promptVersionId: prompt.id, providerId: 'runninghub', durationSeconds: 6, aspectRatio: '3:4', megapixels: 0.6 });
  const preview = buildSubmissionPreview(project, registry, intent);
  assert.equal(preview.references[0]?.assetId, assets[4]?.id);
  assert.equal(preview.cost.estimatedCny, 0.26);
  assert.equal(preview.cost.failureCharge, 'unknown');
  assert.equal(preview.verification.exactCombination, 'declared');
  const nodes = preview.providerPayload.nodeInfoList as Array<{ nodeId: string; fieldName: string; fieldValue: string }>;
  assert.equal(nodes.find((node) => node.nodeId === '1')?.fieldValue, prompt.text);
  assert.equal(nodes.find((node) => node.nodeId === '2')?.fieldValue, '6');
  assert.equal(nodes.find((node) => node.nodeId === '3')?.fieldValue, '3:4');
  assert.equal(nodes.find((node) => node.nodeId === '4')?.fieldValue, '0.6');
  assert.equal(nodes.find((node) => node.nodeId === '10')?.fieldValue, `{{upload:${bindings[4]!.id}}}`);
  assert.equal(nodes.find((node) => node.nodeId === '14')?.fieldValue, `{{upload:${bindings[3]!.id}}}`);
  registry.confirmSuccessfulRender({ provider: 'runninghub', aiAppId: 'mock-app-id', mode: 'ref2va', promptVersionId: prompt.id, durationSeconds: 6, aspectRatio: '3:4', megapixels: 0.6, references: intent.references, providerParams: {} });
  assert.equal(registry.getProfileForMode('ref2va')?.capabilities.testedCombinations?.length, 1);
  assert.equal(buildSubmissionPreview(project, registry, intent).verification.exactCombination, 'tested');
  const current = registry.getProfile()!;
  const emptyEstimate = { cnyPerTask: null, cnyPerSecond: null, failureCharge: 'unknown' } as const;
  registry.saveProfile({
    ...current,
    capabilities: { ...current.capabilities, costEstimate: emptyEstimate },
    apps: current.apps.map((app) => app.id === current.activeWorkflowId ? { ...app, capabilities: { ...app.capabilities, costEstimate: emptyEstimate } } : app),
  });
  const unknownCost = buildSubmissionPreview(project, registry, intent);
  assert.equal(unknownCost.cost.estimatedCny, null);
  assert.equal(unknownCost.cost.evidence, 'unknown');
});
