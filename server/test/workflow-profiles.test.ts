import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AiAppProfile, H3Mode } from '@h3mise/shared';
import { ProviderRegistry, defaultAiAppProfile, inferSupportedModes, mapDiscoveredNodes } from '../src/providers/registry.js';
import { RunningHubAiAppProvider } from '../src/providers/runninghub.js';
import { Ffmpeg } from '../src/ffmpeg.js';
import { cleanupTempRoot, makeProject, makeStore } from './helpers.js';
import type { RenderRequestInput } from '../src/providers/types.js';
import { createShot, updateShot } from '../src/modules/shots.js';
import { importRawPrompt } from '../src/modules/prompt.js';
import { runBasicPreflight } from '../src/modules/preflight.js';
import { productionOverview } from '../src/modules/production.js';
import { buildRoutes, type AppServices } from '../src/http/routes.js';
import { EventBus } from '../src/events.js';
import { RenderQueue } from '../src/modules/render.js';

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

test('re-verifying an already-verified workflow preserves verified when mapping is unchanged and demotes when changed', async () => {
  const { root, store } = await makeStore('workflow-preserve-verified');
  roots.push(root);
  const registry = registryWithProfile(store, mainProfile());
  const originalFetch = globalThis.fetch;
  let nextNodes = mappedNodes();
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { nodeInfoList: nextNodes } }));
  try {
    const unchanged = await registry.verifyWorkflow('main');
    assert.equal(unchanged.verification?.status, 'verified', 'identical node mapping preserves verified status');

    nextNodes = [...mappedNodes(), node('233', 'image', '参考图3')];
    const changed = await registry.verifyWorkflow('main');
    assert.equal(changed.verification?.status, 'nodes_detected', 'changed node mapping demotes to nodes_detected');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('shot-level and request-level workflowId select workflows independently without changing activeWorkflowId', async () => {
  const { root, store } = await makeStore('workflow-per-shot');
  roots.push(root);
  const project = await makeProject(store, 'Dual Workflow');
  const audioNodes = [
    node('401', 'prompt', 'Prompt'),
    node('402', 'image', '参考图1'),
    node('403', 'audio', '原音频', 'AUDIO'),
  ];
  const audioInputs = mapDiscoveredNodes(audioNodes);
  const profile = mainProfile();
  profile.apps.push({
    id: 'wf-audio-lock',
    name: '原音频锁对口型',
    appId: '2116366903353630721',
    inputs: audioInputs,
    nodes: audioNodes,
    capabilities: { supportedModes: ['t2va', 'ref2va'], maxImageRefs: 1, maxAudioRefs: 1, maxVideoRefs: 0, maxTotalRefs: 2, audioReuse: 'copy' },
    verification: { status: 'verified', checkedAt: '2026-01-02', note: 'verified audio app' },
  });
  const registry = registryWithProfile(store, profile);

  const shot = createShot(project, { title: '对口型镜', durationSeconds: 6, h3Mode: 't2va', workflowId: 'wf-audio-lock' });
  assert.equal(shot.workflowId, 'wf-audio-lock');
  const pv = importRawPrompt(project, shot.id, 'Fish in tank, soft light, fixed camera, calm performance.', 't2va');

  const preflightShot = await runBasicPreflight(project, registry, { shotId: shot.id, promptVersionId: pv.id, providerId: 'runninghub' });
  assert.equal(preflightShot.blocked, false);
  assert.equal(preflightShot.payload?.appId, '2116366903353630721');
  assert.equal(preflightShot.payload?.workflowId, 'wf-audio-lock');
  assert.equal(registry.getProfile()?.activeWorkflowId, 'main', 'global activeWorkflowId is untouched');

  // Request-level override wins over shot default.
  const preflightOverride = await runBasicPreflight(project, registry, {
    shotId: shot.id, promptVersionId: pv.id, providerId: 'runninghub', workflowId: 'main',
  });
  assert.equal(preflightOverride.payload?.appId, 'main-app');

  // Unknown workflowId blocks cleanly instead of falling back to active workflow.
  const preflightMissing = await runBasicPreflight(project, registry, {
    shotId: shot.id, promptVersionId: pv.id, providerId: 'runninghub', workflowId: 'wf-nonexistent',
  });
  assert.equal(preflightMissing.blocked, true);
  assert.ok(preflightMissing.basic.flatMap((s) => s.checks).some((c) => c.key === 'provider.workflow_not_found'));

  // Updating shot workflowId does not invalidate existing prompt production_signature.
  const updated = updateShot(project, shot.id, { workflowId: 'main' });
  assert.equal(updated.workflowId, 'main');
  const afterSwitch = await runBasicPreflight(project, registry, { shotId: shot.id, promptVersionId: pv.id, providerId: 'runninghub' });
  assert.ok(!afterSwitch.basic.flatMap((s) => s.checks).some((c) => c.key === 'prompt.production_stale'));
});

test('RunningHub status maps chargedPoint/settleMode POINT and strips <d> attributes in payload', async () => {
  const { root, store } = await makeStore('workflow-point-billing');
  roots.push(root);
  const project = await makeProject(store, 'Point Billing');
  const provider = new RunningHubAiAppProvider({ apiKey: 'test-key', profile: mainProfile() });
  const nodeList = provider.previewNodeInfoList({
    mode: 't2va',
    prompt: '<Subject 1> speaks: <d speaker="S1" start="0.00" end="5.00">[Mandarin] 别难过</d>',
    durationSeconds: 5,
    aspectRatio: '3:4',
    references: [],
    providerParams: {},
  });
  assert.equal(nodeList.find((n) => n.nodeId === '250')?.fieldValue, '<Subject 1> speaks: <d>[Mandarin] 别难过</d>');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    status: 'SUCCESS',
    results: [{ url: 'https://example.com/out.mp4' }],
    usage: { consumeMoney: '0', consumeCoins: null, chargedPoint: '71.91', settleMode: 'POINT' },
  }));
  let status;
  try {
    status = await provider.status({ providerTaskId: 'task-point-1' });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(status.cost?.points, 71.91);
  assert.equal(status.cost?.credits, 71.91);
  assert.equal(status.cost?.unit, 'POINT');

  const shot = createShot(project, { title: 'S1', durationSeconds: 5 });
  const pv = importRawPrompt(project, shot.id, 'test', 't2va');
  const now = new Date().toISOString();
  project.db.run(
    `INSERT INTO render_jobs (id, project_id, shot_id, prompt_version_id, provider, status, cost_json, created_at, updated_at)
     VALUES ('job-pt-1', ?, ?, ?, 'runninghub', 'LOCAL_READY', ?, ?, ?)`,
    [project.meta.id, shot.id, pv.id, JSON.stringify(status.cost), now, now],
  );
  // Also verify retroactive fallback for legacy jobs that only saved raw.chargedPoint.
  project.db.run(
    `INSERT INTO render_jobs (id, project_id, shot_id, prompt_version_id, provider, status, cost_json, created_at, updated_at)
     VALUES ('job-pt-legacy', ?, ?, ?, 'runninghub', 'LOCAL_READY', ?, ?, ?)`,
    [project.meta.id, shot.id, pv.id, JSON.stringify({ credits: 0, unit: 'CNY', raw: { chargedPoint: '28.09', settleMode: 'POINT' } }), now, now],
  );
  const registry = new ProviderRegistry(() => store.current, () => store.registry, new Ffmpeg(), null, 'mock');
  registry.refresh();
  const overview = await productionOverview(project, registry);
  assert.equal(overview.summary.spentCny, 0, 'POINT billing must not inflate spentCny');
  assert.equal(overview.summary.spentPoints, 100);
});

test('POST /api/projects and GET /api/current-project share unified id + meta + config shape', async () => {
  const { root, store } = await makeStore('project-shape');
  roots.push(root);
  const ffmpeg = new Ffmpeg();
  const bus = new EventBus();
  const providers = new ProviderRegistry(() => store.current, () => store.registry, ffmpeg, null, 'mock');
  const queue = new RenderQueue(() => store, providers, ffmpeg, bus, 50);
  const app = buildRoutes({ store, providers, queue, ffmpeg, bus } as unknown as AppServices);

  const createdRes = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '海底合租屋', format: 'story' }),
  });
  assert.equal(createdRes.status, 201);
  const created = await createdRes.json() as { id: string; meta: { id: string }; config: { title: string } };
  assert.ok(created.id);
  assert.equal(created.meta.id, created.id);
  assert.equal(created.config.title, '海底合租屋');

  const currentRes = await app.request('/api/current-project');
  assert.equal(currentRes.status, 200);
  const current = await currentRes.json() as { id: string; meta: { id: string }; config: { title: string } };
  assert.equal(current.id, created.id);
  assert.equal(current.meta.id, created.id);
  assert.equal(current.config.title, '海底合租屋');
});
