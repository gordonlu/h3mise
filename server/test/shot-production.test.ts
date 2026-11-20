import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { AppServices } from '../src/http/routes.js';
import { buildRoutes } from '../src/http/routes.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { RenderQueue } from '../src/modules/render.js';
import { Ffmpeg } from '../src/ffmpeg.js';
import { EventBus } from '../src/events.js';
import { cleanupTempRoot, makeProject, makeStore, makeShotWithPrompt } from './helpers.js';
import { createShot, advanceTo, getShot, listShots } from '../src/modules/shots.js';
import { importRawPrompt } from '../src/modules/prompt.js';
import { importUpload } from '../src/modules/media.js';
import { createBinding, createEntity, ensureShotEntityImageBindings, getMedia, listBindings } from '../src/modules/assets.js';
import { runBasicPreflight } from '../src/modules/preflight.js';
import { createLockedCameraSegment, prepareReferenceImage, updateShotProduction } from '../src/modules/shot-production.js';
import { lintPrompt } from '../src/modules/prompt-lint.js';
import { runningHub805RecoveryPlan } from '@h3mise/shared';
import type { MediaAsset, ProviderCapabilities, ReferenceBinding, RenderJob, Shot, SubmissionPayloadPreview, Take, TakeQualityReport } from '@h3mise/shared';
import type { RenderJobHandle, RenderRequestInput, RenderResult, RenderStatus, UploadedAsset, VideoProvider } from '../src/providers/types.js';
import { Db } from '../src/db/sqlite.js';
import { migrate } from '../src/db/migrate.js';
import { PROJECT_MIGRATIONS } from '../src/db/schema.js';
import { makeTempRoot } from './helpers.js';

const roots: string[] = [];
after(() => roots.forEach((root) => cleanupTempRoot(root)));

function png(width: number, height: number, seed: number): Uint8Array {
  const image = new PNG({ width, height });
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = (seed * 37) % 255;
    image.data[index + 1] = (index / 4 + seed * 11) % 255;
    image.data[index + 2] = 120;
    image.data[index + 3] = 255;
  }
  return new Uint8Array(PNG.sync.write(image));
}

async function response<T>(app: ReturnType<typeof buildRoutes>, path: string, init?: RequestInit, expected = 200): Promise<T> {
  const result = await app.request(path, init);
  const body = await result.json() as T & { error?: string };
  assert.equal(result.status, expected, `${path}: ${body.error ?? JSON.stringify(body)}`);
  return body;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 25_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('timed out waiting for mock render');
}

test('migration v27 preserves legacy rows and assigns final prompts and reference positions', () => {
  const root = makeTempRoot('production-migration');
  roots.push(root);
  const db = new Db(join(root, 'legacy.db'));
  migrate(db, PROJECT_MIGRATIONS.filter((migration) => migration.version <= 26));
  db.run("INSERT INTO story (id, created_at, updated_at) VALUES ('story-old', '2020-01-01', '2020-01-01')");
  db.run("INSERT INTO shots (id, story_id, ord, title, created_at, updated_at) VALUES ('shot-old', 'story-old', 1, 'Legacy', '2020-01-01', '2020-01-01')");
  db.run("INSERT INTO media_assets (id, kind, file_name, created_at) VALUES ('media-old', 'image', 'assets/old.png', '2020-01-01')");
  db.run("INSERT INTO reference_bindings (id, asset_id, type, shot_id, created_at) VALUES ('ref-old', 'media-old', 'image', 'shot-old', '2020-01-01')");
  db.run("INSERT INTO prompt_versions (id, shot_id, h3_mode, text, created_at) VALUES ('prompt-old', 'shot-old', 'ref2va', '<Picture 1>', '2020-01-01')");
  migrate(db, PROJECT_MIGRATIONS);
  assert.equal(db.get<{ stage: string }>('SELECT stage FROM prompt_versions WHERE id = ?', ['prompt-old'])?.stage, 'final');
  assert.equal(db.get<{ position: number }>('SELECT position FROM reference_bindings WHERE id = ?', ['ref-old'])?.position, 1);
  assert.equal(db.get<{ production_json: string }>('SELECT production_json FROM shots WHERE id = ?', ['shot-old'])?.production_json, '{}');
  assert.ok(db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'take_quality_reports'").length === 1);
  assert.ok(db.all<{ name: string }>('PRAGMA table_info(prompt_versions)').some((column) => column.name === 'production_signature'));
  db.close();
});

test('Prompt lint blocks mixed modes, bad references, unmarked dialogue and rewrite payloads', () => {
  const badReference = lintPrompt('Subject and room, soft light, fixed camera, calm performance, tied hair. <Picture 3>', {
    mode: 'ref2va', pictureCount: 2, durationSeconds: 6,
  });
  assert.ok(badReference.some((issue) => issue.key === 'prompt_lint.picture_range' && issue.severity === 'error'));
  const mixed = lintPrompt('<Picture 1> subject_definitions: silent', { mode: 't2va', pictureCount: 0 });
  assert.ok(mixed.some((issue) => issue.key === 'prompt_lint.mode_mixed' && issue.severity === 'error'));
  const dialogue = lintPrompt('overall_soundscape: 你好\n\n<d start="0.45" end="1.2">你好</d>', { durationSeconds: 6, nativeDialogue: true });
  assert.ok(dialogue.some((issue) => issue.key === 'prompt_lint.dialogue_speaker' && issue.severity === 'error'));
  assert.ok(dialogue.some((issue) => issue.key === 'prompt_lint.soundscape_dialogue' && issue.severity === 'error'));
  assert.ok(dialogue.some((issue) => issue.key === 'prompt_lint.native_timing' && issue.severity === 'warning'));
  const rewrite = lintPrompt('rewrite: silent\nsubject_definitions: none\nsummary: silent\nretention_analysis: silent\noverall_soundscape: silent', { mode: 'ref2va' });
  assert.ok(rewrite.some((issue) => issue.key === 'prompt_lint.rewrite_payload' && issue.severity === 'error'));
});

test('3:4 preflight requires an explicit 16:9 reference policy and crop creates a reusable derived asset', async () => {
  const { root, store } = await makeStore('reference-policy');
  roots.push(root);
  const project = await makeProject(store, 'Reference policy');
  project.config.default_provider = 'mock';
  const shot = createShot(project, { title: 'Portrait', purpose: 'Ancient room', aspectRatio: '3:4', durationSeconds: 6, h3Mode: 'ref2va' });
  const asset = await importUpload(project, new Ffmpeg(), { fileName: 'wide.png', mimeType: 'image/png', data: Buffer.from(png(160, 90, 1)) });
  const binding = createBinding(project, { assetId: asset.id, shotId: shot.id, roles: ['environment'], referenceUse: 'scene_plate' });
  const prompt = importRawPrompt(project, shot.id, 'Subject in an ancient room, soft light, fixed camera, calm performance, hair and robe. Environment <Picture 1>.', 'ref2va');
  const registry = new ProviderRegistry(() => store.current, () => store.registry, new Ffmpeg(), null, 'mock', undefined, join(root, 'mock'));
  registry.refresh();
  const blocked = await runBasicPreflight(project, registry, { shotId: shot.id, promptVersionId: prompt.id, providerId: 'mock' });
  assert.ok(blocked.basic.flatMap((section) => section.checks).some((check) => check.key === `ref.aspect.choice.${binding.id}` && check.severity === 'error'));
  const prepared = await prepareReferenceImage(project, new Ffmpeg(), binding.id, 'crop');
  assert.equal(prepared.framePolicy, 'crop');
  assert.notEqual(prepared.assetId, asset.id);
  assert.equal(getMedia(project, prepared.assetId).width, 720);
  assert.equal(getMedia(project, prepared.assetId).height, 960);
  const repeated = await prepareReferenceImage(project, new Ffmpeg(), binding.id, 'crop');
  assert.equal(repeated.assetId, prepared.assetId, 'repeating the same completed crop is idempotent');
  assert.equal(getMedia(project, repeated.assetId).fileName, getMedia(project, prepared.assetId).fileName);
  project.db.run("UPDATE media_assets SET label = label || ' · 居中裁切 3:4' WHERE id = ?", [prepared.assetId]);
  await prepareReferenceImage(project, new Ffmpeg(), binding.id, 'crop');
  assert.equal(getMedia(project, repeated.assetId).label, `${asset.label} · 居中裁切 3:4`);
  const ready = await runBasicPreflight(project, registry, { shotId: shot.id, promptVersionId: prompt.id, providerId: 'mock' });
  assert.ok(!ready.basic.flatMap((section) => section.checks).some((check) => check.key.startsWith('ref.aspect.choice.')));
  assert.equal(listBindings(project, shot.id)[0]?.assetId, repeated.assetId);
});




test('changing production config invalidates the final Prompt', async () => {
  const { root, store } = await makeStore('production-prompt-stale');
  roots.push(root);
  const project = await makeProject(store, 'Production prompt stale');
  const shot = createShot(project, { title: 'Stale production', durationSeconds: 3 });
  const prompt = importRawPrompt(project, shot.id, 'A test prompt for the invariant suite.', 't2va');
  const registry = new ProviderRegistry(() => store.current, () => store.registry, new Ffmpeg(), null, 'mock', undefined, join(root, 'mock'));
  registry.refresh();
  const before = await runBasicPreflight(project, registry, { shotId: shot.id, promptVersionId: prompt.id, providerId: 'mock' });
  assert.ok(!before.basic.flatMap((section) => section.checks).some((check) => check.key === 'prompt.production_stale'));
  updateShotProduction(project, shot.id, { camera: { heightMeters: 2, focalLengthMm: null, tiltDegrees: null, locked: true } });
  const after = await runBasicPreflight(project, registry, { shotId: shot.id, promptVersionId: prompt.id, providerId: 'mock' });
  assert.ok(after.basic.flatMap((section) => section.checks).some((check) => check.key === 'prompt.production_stale' && check.severity === 'error'));
});

test('same-camera segments insert after the group without duplicating shot order', async () => {
  const { root, store } = await makeStore('segment-order');
  roots.push(root);
  const project = await makeProject(store, 'Segment order');
  const first = createShot(project, { title: 'A', order: 1 });
  const second = createShot(project, { title: 'B', order: 2 });
  const third = createShot(project, { title: 'C', order: 3 });
  const created = createLockedCameraSegment(project, first.id, { kind: 'continuous', durationSeconds: 4 });
  const shots = listShots(project);
  assert.deepEqual(shots.map((shot) => shot.order), [1, 2, 3, 4]);
  assert.equal(created.segment.order, 2);
  assert.equal(getShot(project, second.id).order, 3);
  assert.equal(getShot(project, third.id).order, 4);
});

test('cropping an auto-managed entity reference survives the next preflight sync', async () => {
  const { root, store } = await makeStore('reference-policy-managed');
  roots.push(root);
  const project = await makeProject(store, 'Reference policy managed');
  const image = await importUpload(project, new Ffmpeg(), { fileName: 'wide.png', mimeType: 'image/png', data: Buffer.from(png(160, 90, 3)) });
  const character = createEntity(project, { kind: 'character', name: 'MISE', imageAssetId: image.id });
  const shot = createShot(project, { title: 'Portrait', purpose: 'Ancient room', aspectRatio: '3:4', durationSeconds: 6, h3Mode: 'ref2va', primaryCharacterId: character.id });
  const managed = ensureShotEntityImageBindings(project, shot).bindings.find((binding) => binding.sourceEntityId === character.id)!;
  assert.ok(managed);
  const prepared = await prepareReferenceImage(project, new Ffmpeg(), managed.id, 'crop');
  assert.equal(prepared.framePolicy, 'crop');
  assert.equal(prepared.sourceEntityId ?? null, null);
  ensureShotEntityImageBindings(project, getShot(project, shot.id));
  const after = listBindings(project, shot.id);
  assert.equal(after.length, 1);
  assert.equal(after[0]?.id, managed.id);
  assert.equal(after[0]?.assetId, prepared.assetId);
  assert.equal(after[0]?.framePolicy, 'crop');
});

test('API e2e: five references, 3:4, six seconds, payload, quality, A/B and persistence use only Mock', async () => {
  const { root, store } = await makeStore('production-e2e');
  roots.push(root);
  const project = await makeProject(store, 'Production e2e');
  project.config.default_provider = 'mock';
  project.config.default_aspect_ratio = '3:4';
  await store.saveConfig(project);
  const ffmpeg = new Ffmpeg();
  const events = new EventBus();
  const registry = new ProviderRegistry(() => store.current, () => store.registry, ffmpeg, null, 'mock', undefined, join(root, 'mock'));
  registry.refresh();
  const queue = new RenderQueue(() => store, registry, ffmpeg, events, 20);
  const app = buildRoutes({ store, providers: registry, queue, bus: events, ffmpeg } as AppServices);

  const shot = await response<Shot>(app, '/api/shots', json('POST', {
    title: 'CAM 04 · Ancient hall', purpose: 'A robed attendant crosses an ancient hall', durationSeconds: 6, aspectRatio: '3:4', h3Mode: 'ref2va',
  }), 201);
  const assets: MediaAsset[] = [];
  for (let index = 0; index < 5; index += 1) {
    const form = new FormData();
    form.append('file', new Blob([png(60, 80, index + 2)], { type: 'image/png' }), `reference-${index + 1}.png`);
    form.append('label', `Reference ${index + 1}`);
    assets.push(await response<MediaAsset>(app, '/api/assets/media/upload', { method: 'POST', body: form }, 201));
  }
  const uses = ['full_body', 'costume', 'face', 'scene_plate', 'expression'] as const;
  const roles = [['identity'], ['costume'], ['identity'], ['environment'], ['identity']] as const;
  const bindings: ReferenceBinding[] = [];
  for (let index = 0; index < 5; index += 1) {
    bindings.push(await response<ReferenceBinding>(app, '/api/assets/bindings', json('POST', {
      assetId: assets[index]!.id, shotId: shot.id, roles: roles[index], referenceUse: uses[index], framePolicy: 'reference_only', label: `Reference ${index + 1}`,
    }), 201));
  }
  const reordered = [bindings[4]!, ...bindings.slice(0, 4)];
  await response<ReferenceBinding[]>(app, '/api/assets/bindings/reorder', json('POST', { shotId: shot.id, ids: reordered.map((binding) => binding.id) }));
  await response(app, `/api/shots/${shot.id}/production`, json('PATCH', {
    camera: { heightMeters: 3.2, focalLengthMm: 35, tiltDegrees: 12, locked: true },
    cctv: { enabled: true, cameraLabel: 'CAM 04', location: 'Ancient hall', startTime: '2026-01-01T08:00:00', showRec: true, lowResolution: true, dotMatrix: true, blurUpscale: true },
  }));
  const prompt = await response<{ id: string; stage: string; text: string }>(app, `/api/shots/${shot.id}/prompts/compile`, json('POST', { mode: 'ref2va', durationSeconds: 6 }), 201);
  assert.equal(prompt.stage, 'final');
  for (let index = 1; index <= 5; index += 1) assert.ok(prompt.text.includes(`<Picture ${index}>`));
  assert.ok(prompt.text.includes('clean scene picture'));
  assert.ok(prompt.text.includes('stays off-screen'));

  await response<ReferenceBinding[]>(app, '/api/assets/bindings/reorder', json('POST', { shotId: shot.id, ids: bindings.map((binding) => binding.id) }));
  const staleOrder = await response<{ basic: Array<{ checks: Array<{ key: string; severity: string }> }> }>(app, `/api/shots/${shot.id}/preflight`, json('POST', {
    promptVersionId: prompt.id, providerId: 'mock', durationSeconds: 6, aspectRatio: '3:4',
  }), 201);
  assert.ok(staleOrder.basic.flatMap((section) => section.checks).some((check) => check.key === 'prompt.reference_order' && check.severity === 'error'));
  await response<ReferenceBinding[]>(app, '/api/assets/bindings/reorder', json('POST', { shotId: shot.id, ids: reordered.map((binding) => binding.id) }));

  const badPrompt = await response<{ id: string }>(app, `/api/shots/${shot.id}/prompts/raw`, json('POST', {
    mode: 'ref2va', text: 'Subject, room, light, camera, performance, hair. Wrong <Picture 6>.',
  }), 201);
  const badReport = await response<{ blocked: boolean; basic: Array<{ checks: Array<{ key: string; severity: string }> }> }>(app, `/api/shots/${shot.id}/preflight`, json('POST', {
    promptVersionId: badPrompt.id, providerId: 'mock', durationSeconds: 6, aspectRatio: '3:4',
  }), 201);
  assert.equal(badReport.blocked, true);
  assert.ok(badReport.basic.flatMap((section) => section.checks).some((check) => check.key === 'prompt_lint.picture_range' && check.severity === 'error'));
  const rewrite = await response<{ id: string }>(app, `/api/shots/${shot.id}/prompts/artifacts`, json('POST', { stage: 'rewrite', mode: 'ref2va', text: 'rewrite: silent six-section draft' }), 201);
  const rewriteReport = await response<{ basic: Array<{ checks: Array<{ key: string }> }> }>(app, `/api/shots/${shot.id}/preflight`, json('POST', {
    promptVersionId: rewrite.id, providerId: 'mock',
  }), 201);
  assert.ok(rewriteReport.basic.flatMap((section) => section.checks).some((check) => check.key === 'prompt.not_final'));
  const risky = await response<{ basic: Array<{ checks: Array<{ key: string; severity: string }> }> }>(app, `/api/shots/${shot.id}/preflight`, json('POST', {
    promptVersionId: prompt.id, providerId: 'runninghub', durationSeconds: 15, aspectRatio: '3:4', megapixels: 1.2,
  }), 201);
  assert.ok(risky.basic.flatMap((section) => section.checks).some((check) => check.key === 'provider.workflow_805.risk' && check.severity === 'warning'));

  const preview = await response<SubmissionPayloadPreview>(app, `/api/shots/${shot.id}/submission-preview`, json('POST', {
    promptVersionId: prompt.id, providerId: 'mock', durationSeconds: 6, aspectRatio: '3:4',
  }));
  assert.equal(preview.references.length, 5);
  assert.equal(preview.references[0]?.tag, '<Picture 1>');
  assert.equal(preview.references[0]?.assetId, bindings[4]?.assetId);
  assert.equal(preview.aspectRatio, '3:4');
  assert.equal(preview.durationSeconds, 6);
  assert.equal(preview.cost.estimatedCny, 0);
  assert.equal(preview.verification.exactCombination, 'tested');
  assert.deepEqual(preview.providerPayload.output, { takes: 1, variants: [], silentVariant: false });
  const preflight = await response<{ id: string; blocked: boolean; payload: SubmissionPayloadPreview }>(app, `/api/shots/${shot.id}/preflight`, json('POST', {
    promptVersionId: prompt.id, providerId: 'mock', durationSeconds: 6, aspectRatio: '3:4',
  }), 201);
  assert.equal(preflight.blocked, false, JSON.stringify(preflight));
  assert.equal(preflight.payload.references.length, 5);

  const job = await response<RenderJob>(app, '/api/render', json('POST', {
    shotId: shot.id, promptVersionId: prompt.id, providerId: 'mock', durationSeconds: 6, aspectRatio: '3:4', confirmed: true,
  }), 201);
  const finished = await waitFor(() => response<RenderJob>(app, `/api/render/${job.id}`), (current) => current.status === 'LOCAL_READY');
  assert.ok(finished.takeId);
  assert.equal(finished.provider, 'mock');
  assert.equal(finished.cost?.credits, 0);
  const takes = await response<Take[]>(app, `/api/shots/${shot.id}`).then((detail) => (detail as unknown as { takes: Take[] }).takes);
  assert.equal(takes.length, 1);
  assert.equal(takes[0]?.duration, 6);
  assert.ok(!takes[0]?.localVideoPath.includes('_silent'));
  const qualityPayload = await response<{ latest: TakeQualityReport }>(app, `/api/takes/${finished.takeId}/quality`);
  assert.ok(qualityPayload.latest);
  assert.equal(qualityPayload.latest.items.find((item) => item.key === 'duration')?.status, 'pass');
  assert.equal(qualityPayload.latest.items.find((item) => item.key === 'aspect_ratio')?.status, 'pass');
  assert.equal(qualityPayload.latest.items.find((item) => item.key === 'character_presence')?.status, 'unknown');
  const aiQuality = await response<TakeQualityReport>(app, `/api/takes/${finished.takeId}/quality`, json('POST', {
    source: 'ai_inference', aiObservations: [{ key: 'text_watermark', status: 'fail', message: 'Detected unexpected lettering', observed: 'corner text' }],
  }), 201);
  assert.equal(aiQuality.items.find((item) => item.key === 'text_watermark')?.evidence, 'ai_inference');
  const manualQuality = await response<TakeQualityReport>(app, `/api/takes/${finished.takeId}/quality/text_watermark`, json('PATCH', { status: 'pass', message: 'Reviewed: it is the intended Mock diagnostic label' }));
  assert.equal(manualQuality.items.find((item) => item.key === 'text_watermark')?.evidence, 'manual');
  assert.equal(manualQuality.items.find((item) => item.key === 'text_watermark')?.overridden, true);
  await response(app, `/api/takes/${finished.takeId}/select`, json('POST', {}));
  const cctv = await response<{ method: string; times: Array<{ timestamp: string }> }>(app, `/api/shots/${shot.id}/cctv-preview`);
  assert.equal(cctv.method, 'post_overlay_only');
  assert.ok(cctv.times[0]!.timestamp < cctv.times[2]!.timestamp);
  const siblings = await response<{ source: Shot; segment: Shot }>(app, `/api/shots/${shot.id}/segments`, json('POST', { kind: 'continuous', durationSeconds: 6 }), 201);
  assert.equal(siblings.segment.production.segment.groupId, siblings.source.production.segment.groupId);
  assert.deepEqual(siblings.segment.production.camera, siblings.source.production.camera);
  assert.equal(listBindings(project, siblings.segment.id).length, 5);
  assert.equal((await response<RenderJob[]>(app, `/api/render?shotId=${siblings.segment.id}`)).length, 0);
  const segmentPrompt = await response<{ prompts: Array<{ shotId: string; text: string; stage: string }> }>(app, `/api/shots/${siblings.segment.id}`);
  assert.ok(segmentPrompt.prompts.filter((item) => item.stage === 'final').at(-1)?.text.includes('part 2/2'));
  const third = await response<{ source: Shot; segment: Shot }>(app, `/api/shots/${siblings.segment.id}/segments`, json('POST', { kind: 'time_jump', durationSeconds: 6, timeJumpSeconds: 30 }), 201);
  const group = [getShot(project, siblings.source.id), third.source, third.segment];
  assert.deepEqual(group.map((item) => item.production.segment.index), [1, 2, 3]);
  assert.ok(group.every((item) => item.production.segment.count === 3));
  assert.equal((await response<RenderJob[]>(app, `/api/render?shotId=${third.segment.id}`)).length, 0);

  await queue.forgetProject(project.meta.id);
  const reopened = await store.open(project.meta.id);
  assert.equal(getShot(reopened, shot.id).production.camera.heightMeters, 3.2);
  assert.equal(listBindings(reopened, shot.id)[0]?.id, bindings[4]?.id);
  const persistedQuality = await response<{ latest: TakeQualityReport }>(app, `/api/takes/${finished.takeId}/quality`);
  assert.equal(persistedQuality.latest.items.find((item) => item.key === 'text_watermark')?.evidence, 'manual');
  const persistedDetail = await response<{ takes: Take[]; prompts: Array<{ stage: string }> }>(app, `/api/shots/${shot.id}`);
  assert.equal(persistedDetail.takes[0]?.status, 'selected');
  assert.ok(persistedDetail.prompts.some((item) => item.stage === 'rewrite'));
});

class Fail805Provider implements VideoProvider {
  readonly id = 'runninghub';
  readonly name = 'Mock RunningHub 805';
  readonly configured = true;
  submits = 0;
  async capabilities(): Promise<ProviderCapabilities> { return { supportedModes: ['t2va'] }; }
  async uploadAsset(asset: MediaAsset): Promise<UploadedAsset> { return { providerRef: `mock://${asset.id}` }; }
  async submit(_request: RenderRequestInput): Promise<RenderJobHandle> { this.submits += 1; return { providerTaskId: 'mock-rh-805' }; }
  async status(_handle: RenderJobHandle): Promise<RenderStatus> { return { status: 'FAILED', error: '805 workflow run failed' }; }
  async result(_handle: RenderJobHandle): Promise<RenderResult> { throw new Error('must not download a failed task'); }
  async cancel(): Promise<void> {}
}

test('Mocked RunningHub 805 creates no Take, never auto-retries and returns same-camera recovery choices', async () => {
  const { root, store } = await makeStore('runninghub-805');
  roots.push(root);
  const project = await makeProject(store, '805');
  const { shotId, promptVersionId } = makeShotWithPrompt(project, 't2va');
  advanceTo(project, shotId, 'PREFLIGHT_READY');
  const provider = new Fail805Provider();
  const registry = { get: () => provider, confirmSubmission: () => undefined };
  const queue = new RenderQueue(() => store, registry as never, new Ffmpeg(), new EventBus(), 5);
  const job = queue.submit({
    projectId: project.meta.id,
    shotId,
    promptVersionId,
    provider: 'runninghub',
    request: { provider: 'runninghub', aiAppId: 'mock-app', mode: 't2va', promptVersionId, durationSeconds: 15, aspectRatio: '16:9', megapixels: 1.2, references: [], providerParams: {} },
    intentHash: '805-test',
  });
  const failed = await waitFor(async () => queue.get(job.id)!, (current) => current.status === 'FAILED', 3000);
  assert.equal(provider.submits, 1);
  assert.equal(failed.takeId, null);
  assert.equal(failed.failureAdvice?.code, 'RUNNINGHUB_805', JSON.stringify(failed));
  assert.equal(failed.failureAdvice?.automaticRetry, false);
  assert.equal(failed.failureAdvice?.suggestions.find((item) => item.key === 'lower_mp')?.megapixels, 0.6);
  assert.equal(failed.failureAdvice?.suggestions.find((item) => item.key === 'same_camera_segments')?.segments?.length, 3);
  await assert.rejects(queue.retry(job.id), /805 不允许重试/);
  assert.equal(provider.submits, 1);
  assert.equal(project.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM takes WHERE shot_id = ?', [shotId])?.n, 0);
  assert.equal(runningHub805RecoveryPlan(15, 1.2, null).suggestions.length, 3);
  await queue.forgetProject(project.meta.id);
});
