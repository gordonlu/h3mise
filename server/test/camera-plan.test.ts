// Camera-planning tests — geometry invariants, screen-direction preflight,
// compiler constraints, and a real (offline) FFmpeg render regression.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { join as pathJoin } from 'node:path';
import { tmpdir } from 'node:os';
import { makeStore, makeProject, cleanupTempRoot } from './helpers.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { Ffmpeg } from '../src/ffmpeg.js';
import type { Db } from '../src/db/sqlite.js';
import type { ProjectContext } from '../src/project-store.js';
import { createShot, updateShot } from '../src/modules/shots.js';
import { compilePrompt } from '../src/modules/prompt.js';
import { createPlanVersion } from '../src/modules/director.js';
import { intentFromInput, runBasicPreflightIntent } from '../src/modules/preflight.js';
import { saveCameraPlan, getCameraPlan, renderCameraFrames, cameraPlanWarningsFor, renderCameraMotion } from '../src/modules/camera-plan.js';
import { importUpload } from '../src/modules/media.js';
import { createBinding } from '../src/modules/assets.js';
import { emptyCameraPlan } from '@h3mise/shared';
import { cameraPlanWarnings, normalizeCameraPlan, viewAt } from '@h3mise/shared';

const roots: string[] = [];
after(() => { for (const r of roots) cleanupTempRoot(r); });

function makeRegistry(registryDb: Db) {
  const r = new ProviderRegistry(() => null, () => registryDb, new Ffmpeg(), null, 'mock');
  r.refresh();
  return r;
}

// --- geometry ---------------------------------------------------------------

test('camera geometry: push-in then pan then pull-back stays sequential and bounded', () => {
  const base = emptyCameraPlan();
  const steps = [
    { id: 'm1', axis: 'zoom' as const, amount: 0.6, start: 0, end: 1 / 3, ease: 'smooth' as const },
    { id: 'm2', axis: 'pan' as const, amount: 0.8, start: 1 / 3, end: 2 / 3, ease: 'smooth' as const },
    { id: 'm3', axis: 'zoom' as const, amount: -0.5, start: 2 / 3, end: 1, ease: 'smooth' as const },
  ];
  const plan = { ...base, frameMode: false, startFraming: { x: 0, y: 0, w: 1, h: 1 }, steps };
  const mid = viewAt(plan, 0.5);
  assert.ok(mid.rect.w < 1, 'zoom-in shrinks the view');
  assert.ok(mid.rect.x > 0, 'pan moves right');
  const end = viewAt(plan, 1);
  assert.ok(end.rect.w > mid.rect.w, 'pull-back widens the view again');
  assert.ok(end.rect.x + end.rect.w <= 1 + 1e-9, 'view stays inside the stage');
  // Compiler summary uses the H3-native motion vocabulary in order.
  const summary = plan.steps.map((s) => s.axis).join(' → ');
  assert.equal(summary, 'zoom → pan → zoom');
  assert.ok(cameraPlanWarnings(plan).length >= 1, 'over-shoot at the edge clamps and warns');
});

test('camera geometry: framing mode interpolates start→end with smoothstep', () => {
  const base = emptyCameraPlan();
  const plan = {
    ...base,
    frameMode: true,
    startFraming: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 },
    endFraming: { x: 0.4, y: 0.4, w: 0.3, h: 0.3 },
    steps: [],
  };
  const start = viewAt(plan, 0);
  const end = viewAt(plan, 1);
  assert.deepEqual(start.rect, plan.startFraming);
  assert.deepEqual(end.rect, plan.endFraming);
  const mid = viewAt(plan, 0.5);
  assert.ok(Math.abs(mid.rect.w - 0.45) < 1e-6, 'smoothstep(0.5)=0.5 → lerp midpoint');
  assert.ok(cameraPlanWarnings(plan).length === 0, 'in-bounds framing imports no warnings');
});

test('camera geometry: out-of-safe-area is clamped and reported — never faked', () => {
  const base = emptyCameraPlan();
  const plan = {
    ...base,
    frameMode: false,
    startFraming: { x: 0.6, y: 0.6, w: 0.3, h: 0.3 },
    steps: [{ id: 'a', axis: 'zoom' as const, amount: -0.9, start: 0, end: 1, ease: 'linear' as const }],
  };
  const end = viewAt(plan, 1);
  assert.ok(end.rect.w <= 1 && end.rect.x >= 0 && end.rect.x + end.rect.w <= 1 + 1e-9, 'clamped into the stage');
  assert.ok(cameraPlanWarnings(plan).some((w) => w.axis === 'zoom'), 'pull-out at the corner warns');
  const normalized = normalizeCameraPlan({
    frameMode: false,
    steps: [{ axis: 'zoom', amount: -0.9, start: 0, end: 1, ease: 'linear' }],
  });
  assert.equal(normalized.steps.length, 1);
});

test('roll is a bounded 2D content roll', () => {
  const base = emptyCameraPlan();
  const plan = {
    ...base,
    frameMode: false,
    startFraming: { x: 0, y: 0, w: 1, h: 1 },
    steps: [{ id: 'r', axis: 'roll' as const, amount: 1, start: 0, end: 1, ease: 'linear' as const }],
  };
  assert.equal(viewAt(plan, 1).angleDeg, 12);
  assert.equal(viewAt(plan, 0.5).angleDeg, 6);
});

// --- persistence + preflight ------------------------------------------------

test('screen direction reversal warns; intentional flag dissolves it', async () => {
  const { root, store } = await makeStore('camera-sdir');
  roots.push(root);
  const p = await makeProject(store, 'sdir');
  const shotA = createShot(p, { title: 'A', order: 1, screenDirection: 'left_to_right' });
  const shotB = createShot(p, { title: 'B', order: 2 });
  updateShot(p, shotB.id, { screenDirection: 'right_to_left' });
  void shotA;
  compilePrompt(p, shotA.id, 't2va');
  const pb = compilePrompt(p, shotB.id, 't2va');
  const registry = makeRegistry(store.registry);
  const intent = await intentFromInput(p, registry, { shotId: shotB.id, promptVersionId: pb.id, providerId: 'mock' });
  const report = await runBasicPreflightIntent(p, registry, intent);
  const section = report.basic.find((s) => s.key === 'continuity');
  assert.ok(section, 'continuity section exists');
  assert.ok(
    section!.checks.some((c) => c.key === 'continuity.screen_direction.reversal' && c.severity === 'warning'),
    'reverse direction produces a warning (never a hard error)',
  );
  assert.equal(report.blocked, false, 'direction warning must not block rendering');

  updateShot(p, shotB.id, { intentionalReversal: true });
  const withFlag = await intentFromInput(p, registry, { shotId: shotB.id, promptVersionId: pb.id, providerId: 'mock' });
  const reReport = await runBasicPreflightIntent(p, registry, withFlag);
  const reSection = reReport.basic.find((s) => s.key === 'continuity');
  assert.ok(
    reSection!.checks.some((c) => c.key === 'continuity.screen_direction.intentional' && c.severity === 'info'),
    'intentional reversal is recorded as info, not a warning',
  );
});

test('compiler emits screen direction and temporal beats lines deterministically', async () => {
  const { root, store } = await makeStore('camera-compiler');
  roots.push(root);
  const p = await makeProject(store, 'compiler');
  const shot = createShot(p, { title: 'Beats Shot', durationSeconds: 6, screenDirection: 'left_to_right' });
  createPlanVersion(p, {
    shotId: shot.id,
    source: 'manual',
    plan: {
      version: 0,
      intent: { shotFunction: shot.shotFunction, visualThesis: 'Battery charge', dramaticGoal: '', peak: '', endState: '' },
      subject: { primarySubject: '', action: 'walk in, set the bag down, leave', primaryMotionOwner: '' },
      blocking: { startPosition: '', endPosition: '', facing: '', movementAxis: '', travelPath: '', spatialRelationships: '' },
      camera: { shotSizeStart: '', shotSizePeak: '', shotSizeEnd: '', geometry: '', lensIntent: '', dominantBehavior: '', trigger: '', speedRelation: '', stopCondition: '' },
      performance: { objective: '', obstacle: '', tactic: '', performanceTurn: '', movementQuality: { weight: '', time: '', space: '', flow: '' }, anticipation: '', primaryAction: '', followThrough: '', recovery: '', gaze: '', endPose: '' },
      environment: { location: '', weather: '', medium: '', wind: '', lighting: '', foreground: '', midground: '', background: '' },
      reality: { mode: 'strict_realism', constraints: [] },
      continuity: { plannedStartState: '', plannedEndState: '' },
      generation: { requestedMode: 't2va', durationSeconds: 6, aspectRatio: '16:9', audioIntent: '' },
      temporalBeats: [
        { id: 'b1', label: 'Approach', start: 0, end: 0.33 },
        { id: 'b2', label: 'Action', start: 0.33, end: 0.75 },
        { id: 'b3', label: 'Recovery', start: 0.75, end: 1 },
      ],
    },
  });
  const prompt = compilePrompt(p, shot.id, 't2va');
  assert.match(prompt.text, /Screen direction: subjects move from left to right/);
  assert.match(prompt.text, /Time progression: 0\.0s–2\.0s Approach; 2\.0s–4\.5s Action; 4\.5s–6\.0s Recovery/);
});

// --- render regression (local FFmpeg, no paid API) --------------------------

async function makeSourceImage(p: ProjectContext, ffmpeg: Ffmpeg) {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'h3mise-camera-'));
  const png = pathJoin(dir, 'src.png');
  await ffmpeg.runRaw([
    '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=0.1:size=640x360:rate=1',
    '-frames:v', '1', '-update', '1', png,
  ], 'src');
  const data = await readFile(png);
  const asset = await importUpload(p, ffmpeg, {
    fileName: 'camera-src.png',
    mimeType: 'image/png',
    data,
    source: 'import',
    label: 'Camera source',
  });
  return asset;
}

test('camera frames render + bind locally (FL2VA consumable)', async (t) => {
  const ffmpeg = new Ffmpeg();
  const available = (await ffmpeg.capabilityCheck()).available;
  if (!available) return t.skip('ffmpeg not available');
  const { root, store } = await makeStore('camera-frames');
  roots.push(root);
  const p = await makeProject(store, 'frames');
  const shot = createShot(p, { title: 'Frames', durationSeconds: 2 });
  const asset = await makeSourceImage(p, ffmpeg);
  const plan = normalizeCameraPlan({
    ...emptyCameraPlan(),
    sourceAssetId: asset.id,
    durationSeconds: 2,
    aspectRatio: '16:9',
    frameMode: true,
    startFraming: { x: 0.1, y: 0.1, w: 0.7, h: 0.7 },
    endFraming: { x: 0.3, y: 0.25, w: 0.4, h: 0.4 },
  });
  saveCameraPlan(p, shot.id, plan);
  assert.deepEqual(getCameraPlan(p, shot.id)!.startFraming, plan.startFraming, 'plan persists');

  const result = await renderCameraFrames(p, ffmpeg, plan, asset, shot.id, { bind: true });
  assert.ok(result.firstAssetId && result.lastAssetId);
  assert.ok(result.firstBindingId && result.lastBindingId, 'frames are bound to the shot');
  const first = p.db.get<{ kind: string; label: string }>('SELECT kind, label FROM media_assets WHERE id = ?', [result.firstAssetId]);
  assert.equal(first!.kind, 'image');
  const bindings = p.db.all<{ roles_json: string }>("SELECT roles_json FROM reference_bindings WHERE shot_id = ?", [shot.id]);
  const roles = bindings.map((b) => JSON.parse(b.roles_json) as string[]).flat();
  assert.ok(roles.includes('first_frame') && roles.includes('last_frame'));

  const motionWarnings = cameraPlanWarningsFor(p, shot.id);
  assert.ok(Array.isArray(motionWarnings));
});

test('closed loop: stale prompt is blocked after plan/camera/screen-direction changes', async () => {
  const { root, store } = await makeStore('camera-stale');
  roots.push(root);
  const p = await makeProject(store, 'stale');
  const shot = createShot(p, { title: 'Stale', durationSeconds: 3 });
  const registry = makeRegistry(store.registry);

  const fresh = compilePrompt(p, shot.id, 't2va');
  const before = await runBasicPreflightIntent(p, registry, await intentFromInput(p, registry, { shotId: shot.id, promptVersionId: fresh.id, providerId: 'mock' }));
  const beforeSection = before.basic.find((s) => s.key === 'integrity');
  assert.ok(!beforeSection!.checks.some((c) => c.key === 'integrity.prompt_stale'), 'fresh prompt has no stale error');

  // Camera plan modified after the prompt → stale error blocks the render gate.
  const plan = normalizeCameraPlan({ ...emptyCameraPlan(), durationSeconds: 3, sourceAssetId: null, startFraming: { x: 0, y: 0, w: 1, h: 1 }, frameMode: false, steps: [{ id: 'm', axis: 'pan', amount: 0.5, start: 0, end: 1, ease: 'smooth' }] });
  saveCameraPlan(p, shot.id, plan);
  const camAfter = await runBasicPreflightIntent(p, registry, await intentFromInput(p, registry, { shotId: shot.id, promptVersionId: fresh.id, providerId: 'mock' }));
  const camSection = camAfter.basic.find((s) => s.key === 'integrity');
  assert.ok(camSection!.checks.some((c) => c.key === 'integrity.prompt_stale' && c.severity === 'error'), 'camera plan change makes the old prompt stale');
  assert.equal(camAfter.blocked, true, 'stale prompt blocks paid submission');

  // Recompile → gates open again; the camera-plan summary is embedded.
  const recompiled = compilePrompt(p, shot.id, 't2va');
  assert.match(recompiled.text, /Camera planning: /, 'camera summary is compiled into the prompt');
  const after = await runBasicPreflightIntent(p, registry, await intentFromInput(p, registry, { shotId: shot.id, promptVersionId: recompiled.id, providerId: 'mock' }));
  assert.equal(after.blocked, false, 'recompiled prompt passes the gate');

  // Screen-direction change after the prompt → stale again, until recompile.
  updateShot(p, shot.id, { screenDirection: 'right_to_left' });
  const dirAfter = await runBasicPreflightIntent(p, registry, await intentFromInput(p, registry, { shotId: shot.id, promptVersionId: recompiled.id, providerId: 'mock' }));
  const dirSection = dirAfter.basic.find((s) => s.key === 'integrity');
  assert.ok(dirSection!.checks.some((c) => c.key === 'integrity.prompt_stale' && c.severity === 'error'), 'screen-direction change makes the prompt stale');
  const recompiled2 = compilePrompt(p, shot.id, 't2va');
  assert.match(recompiled2.text, /Screen direction: subjects move from right to left/);
  const after2 = await runBasicPreflightIntent(p, registry, await intentFromInput(p, registry, { shotId: shot.id, promptVersionId: recompiled2.id, providerId: 'mock' }));
  assert.equal(after2.blocked, false, 'recompiled prompt passes again');
});

test('camera frames bind never clobbers a user Frame Bridge binding', async (t) => {
  const ffmpeg = new Ffmpeg();
  const available = (await ffmpeg.capabilityCheck()).available;
  if (!available) return t.skip('ffmpeg not available');
  const { root, store } = await makeStore('camera-bind-guard');
  roots.push(root);
  const p = await makeProject(store, 'bind-guard');
  const shot = createShot(p, { title: 'Bind guard', durationSeconds: 2 });
  const asset = await makeSourceImage(p, ffmpeg);
  // A pre-existing Frame Bridge pick (next shot's tail frame as this first frame).
  const bridgeAsset = await makeSourceImage(p, ffmpeg);
  createBinding(p, { assetId: bridgeAsset.id, roles: ['first_frame'], label: 'Frame bridge from shot-000/take-004 last frame', shotId: shot.id });
  const plan = normalizeCameraPlan({ ...emptyCameraPlan(), sourceAssetId: asset.id, durationSeconds: 2, aspectRatio: '16:9', frameMode: true });
  saveCameraPlan(p, shot.id, plan);
  await renderCameraFrames(p, ffmpeg, plan, asset, shot.id, { bind: true });
  const kept = p.db
    .all<{ label: string; roles_json: string }>('SELECT label, roles_json FROM reference_bindings WHERE shot_id IS ?', [shot.id])
    .filter((b) => (JSON.parse(b.roles_json) as string[]).includes('first_frame'));
  assert.ok(
    kept.some((b) => b.label.startsWith('Frame bridge')),
    'user frame-bridge binding survives camera-frame generation',
  );
});

test('camera motion reference video renders locally', async (t) => {
  const ffmpeg = new Ffmpeg();
  const available = (await ffmpeg.capabilityCheck()).available;
  if (!available) return t.skip('ffmpeg not available');
  const { root, store } = await makeStore('camera-motion');
  roots.push(root);
  const p = await makeProject(store, 'motion');
  const shot = createShot(p, { title: 'Motion', durationSeconds: 2 });
  const asset = await makeSourceImage(p, ffmpeg);
  const plan = normalizeCameraPlan({
    ...emptyCameraPlan(),
    sourceAssetId: asset.id,
    durationSeconds: 2,
    aspectRatio: '16:9',
    frameMode: false,
    startFraming: { x: 0, y: 0, w: 1, h: 1 },
    steps: [
      { id: 'm1', axis: 'zoom', amount: 0.5, start: 0, end: 0.5, ease: 'smooth' },
      { id: 'm2', axis: 'pan', amount: 0.6, start: 0.5, end: 1, ease: 'smooth' },
    ],
  });
  saveCameraPlan(p, shot.id, plan);
  const video = await renderCameraMotion(p, ffmpeg, plan, asset);
  const vib = p.resolveProjectPath(video.fileName);
  const probe = await ffmpeg.probe(vib);
  assert.equal(video.kind, 'video');
  assert.ok(probe.durationSeconds !== null && Math.abs(probe.durationSeconds - 2) < 0.4, `duration ≈ 2s (got ${probe.durationSeconds})`);
  assert.ok((probe.width ?? 0) > 0 && (probe.height ?? 0) > 0);
});
