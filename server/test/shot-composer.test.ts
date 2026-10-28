// Shot composer: placement, keyframes, camera reuse, deterministic pixels,
// persistence, and local still / MP4 export. No paid provider calls.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ComposerError,
  composerCameraPreset,
  composerChannelAt,
  composerFrameCount,
  composerFrameSize,
  composerHandoffForModes,
  composerSampleIndices,
  describeCameraPlan,
  emptyCameraPlan,
  normalizeShotComposer,
  resolveComposerFrame,
  viewAt,
  type ComposerLayer,
  type ShotComposer,
} from '@h3mise/shared';
import { Ffmpeg } from '../src/ffmpeg.js';
import { saveCameraPlan, getCameraPlan } from '../src/modules/camera-plan.js';
import { createBinding, getMedia, insertMedia, listBindings } from '../src/modules/assets.js';
import { createShot, getShot } from '../src/modules/shots.js';
import { decodePng, encodePng, renderComposerRgba, renderComposerRgbaInto, type RgbaImage } from '../src/modules/shot-composer-raster.js';
import {
  exportShotComposerFrames,
  exportShotComposerPreview,
  getShotComposer,
  installPalaceDemo,
  saveShotComposer,
} from '../src/modules/shot-composer.js';
import { paintPalaceColumn, paintPalaceFigure, paintPalaceHall, PALACE_COLOR, PALACE_SAMPLES, palaceComposer } from '../src/modules/shot-composer-fixtures.js';
import { cleanupTempRoot, fakeTake, listTakes, makeProject, makeShotWithPrompt, makeStore } from './helpers.js';

const exec = promisify(execFile);
const roots: string[] = [];
after(() => {
  for (const root of roots) cleanupTempRoot(root);
});

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function solid(width: number, height: number, rgba: [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return { width, height, data };
}

function pixel(buf: Uint8Array, width: number, x: number, y: number): number[] {
  const i = (y * width + x) * 4;
  return [buf[i] ?? 0, buf[i + 1] ?? 0, buf[i + 2] ?? 0, buf[i + 3] ?? 0];
}

function countColor(buf: Uint8Array, width: number, y: number, rgb: readonly [number, number, number, number]): number {
  let n = 0;
  for (let x = 0; x < width; x++) {
    const sample = pixel(buf, width, x, y);
    if (sample[0] === rgb[0] && sample[1] === rgb[1] && sample[2] === rgb[2]) n += 1;
  }
  return n;
}

function layer(partial: Partial<ComposerLayer> & Pick<ComposerLayer, 'id' | 'assetId'>): ComposerLayer {
  return {
    name: partial.id,
    role: 'custom',
    sourceKind: 'image',
    sequencePath: null,
    x: 0.5,
    y: 0.5,
    anchorX: 0.5,
    anchorY: 0.5,
    scale: 1,
    rotation: 0,
    opacity: 1,
    zIndex: 0,
    visible: true,
    keyframes: [],
    ...partial,
  };
}

function stage(layers: ComposerLayer[], extra?: Record<string, unknown>): ShotComposer {
  return normalizeShotComposer({
    durationSeconds: 1,
    fps: 24,
    aspectRatio: '16:9',
    width: 32,
    height: 18,
    camera: composerCameraPreset('static', 1, '16:9'),
    layers,
    ...extra,
  });
}

test('composer defaults are 16:9, 24fps, 5s and reject illegal values', () => {
  const doc = normalizeShotComposer({});
  assert.equal(doc.durationSeconds, 5);
  assert.equal(doc.fps, 24);
  assert.equal(doc.aspectRatio, '16:9');
  assert.deepEqual(composerFrameSize('16:9'), { width: 1280, height: 720 });
  assert.equal(doc.width, 1280);
  assert.equal(doc.height, 720);
  assert.equal(doc.limits.spatial, '2d-crop');
  assert.equal(composerFrameCount(doc), 120);
  assert.deepEqual(normalizeShotComposer(doc), doc);
  assert.throws(() => normalizeShotComposer({ layers: [{ opacity: 2 }] }), (error: unknown) => error instanceof ComposerError && /opacity/.test(error.message));
  assert.throws(() => normalizeShotComposer({ width: 101 }), (error: unknown) => error instanceof ComposerError && /width/.test(error.message));
  assert.throws(() => normalizeShotComposer({ fps: 23.5 }), (error: unknown) => error instanceof ComposerError && /fps/.test(error.message));
  assert.throws(() => normalizeShotComposer({ layers: [{ sourceKind: 'mesh' }] }), (error: unknown) => error instanceof ComposerError && /source kind/.test(error.message));
  assert.throws(() => normalizeShotComposer({ layers: [{ sequencePath: '../secret' }] }), (error: unknown) => error instanceof ComposerError && /sequence path/.test(error.message));
  const handoff = composerHandoffForModes(['t2va', 'i2va', 'fl2va']);
  assert.deepEqual(handoff.firstFrameModes, ['i2va', 'fl2va']);
  assert.deepEqual(handoff.lastFrameModes, ['fl2va']);
  assert.equal(handoff.motionIsPreviewOnly, true);
  assert.equal(handoff.submitsRender, false);
  assert.equal(handoff.bypassesPreflight, false);
  assert.equal(handoff.spatial, '2d-crop');
});

test('keyframes interpolate and the base pose holds before the first key', () => {
  const moving = layer({
    id: 'subject',
    assetId: 'img',
    x: 0.2,
    keyframes: [{ id: 'end', t: 1, ease: 'linear', x: 0.8 }],
  });
  assert.equal(composerChannelAt(moving, 'x', 0), 0.2);
  assert.equal(composerChannelAt(moving, 'x', 0.5), 0.5);
  assert.equal(composerChannelAt(moving, 'x', 1), 0.8);
  const eased = layer({
    id: 'subject',
    assetId: 'img',
    x: 0.2,
    keyframes: [{ id: 'end', t: 1, ease: 'ease-in', x: 0.8 }],
  });
  assert.ok(Math.abs(composerChannelAt(eased, 'x', 0.5) - 0.35) < 1e-9);
  const smooth = layer({
    id: 'subject',
    assetId: 'img',
    scale: 1,
    keyframes: [{ id: 'end', t: 1, ease: 'smooth', scale: 2 }],
  });
  assert.ok(Math.abs(composerChannelAt(smooth, 'scale', 0.5) - 1.5) < 1e-9);
  assert.equal(composerChannelAt(moving, 'y', 0.5), 0.5);
});

test('z-index and anchors place opaque pixels, and a higher layer occludes', () => {
  const bg = solid(32, 18, [200, 0, 0, 255]);
  const subject = solid(8, 8, [0, 180, 0, 255]);
  const front = solid(6, 18, [0, 0, 220, 255]);
  const images = new Map<string, RgbaImage>([['bg', bg], ['subject', subject], ['front', front]]);
  const backFirst = stage([
    layer({ id: 'bg', assetId: 'bg', zIndex: 0, scale: 1 }),
    layer({ id: 'subject', assetId: 'subject', zIndex: 10, scale: 8 / 18 }),
    layer({ id: 'front', assetId: 'front', zIndex: 20, x: 0.375, scale: 1 }),
  ]);
  const frame = renderComposerRgba(backFirst, 0, images);
  assert.deepEqual(pixel(frame, 32, 16, 9), [0, 180, 0, 255]);
  assert.deepEqual(pixel(frame, 32, 13, 9), [0, 0, 220, 255]);
  assert.deepEqual(pixel(frame, 32, 2, 2), [200, 0, 0, 255]);
  const order = resolveComposerFrame(backFirst, 0).layers.map((item) => item.id);
  assert.deepEqual(order, ['bg', 'subject', 'front']);

  const subjectOnTop = stage([
    layer({ id: 'bg', assetId: 'bg', zIndex: 0 }),
    layer({ id: 'front', assetId: 'front', zIndex: 5, x: 0.375, scale: 1 }),
    layer({ id: 'subject', assetId: 'subject', zIndex: 30, scale: 8 / 18 }),
  ]);
  const covered = renderComposerRgba(subjectOnTop, 0, images);
  assert.deepEqual(pixel(covered, 32, 13, 9), [0, 180, 0, 255]);
});

test('clockwise rotation moves the left side of a bitmap upward', () => {
  const bitmap = solid(8, 8, [0, 0, 220, 255]);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 4; x++) {
      const i = (y * 8 + x) * 4;
      bitmap.data[i] = 220;
      bitmap.data[i + 1] = 0;
      bitmap.data[i + 2] = 0;
    }
  }
  const doc = normalizeShotComposer({
    durationSeconds: 1,
    fps: 24,
    aspectRatio: '1:1',
    width: 32,
    height: 32,
    layers: [layer({ id: 'card', assetId: 'card', scale: 0.25, rotation: 90 })],
  });
  const frame = renderComposerRgba(doc, 0, new Map([['card', bitmap]]));
  assert.deepEqual(pixel(frame, 32, 16, 13), [220, 0, 0, 255]);
  assert.deepEqual(pixel(frame, 32, 16, 18), [0, 0, 220, 255]);
});

test('the same frame is byte-identical, including after the buffer is reused', () => {
  const doc = stage([
    layer({
      id: 'subject',
      assetId: 'subject',
      scale: 8 / 18,
      keyframes: [{ id: 'end', t: 1, ease: 'smooth', x: 0.8 }],
    }),
  ]);
  const images = new Map<string, RgbaImage>([['subject', solid(8, 8, [0, 180, 0, 255])]]);
  const a = renderComposerRgba(doc, 4, images);
  const b = renderComposerRgba(doc, 4, images);
  assert.equal(sha(a), sha(b));
  const stageBuf = new Uint8Array(32 * 18 * 4);
  const out = new Uint8Array(32 * 18 * 4);
  const again = new Uint8Array(32 * 18 * 4);
  renderComposerRgbaInto(doc, 10, images, stageBuf, out);
  renderComposerRgbaInto(doc, 4, images, stageBuf, again);
  assert.equal(sha(again), sha(a));
  const start = resolveComposerFrame(doc, 0);
  const end = resolveComposerFrame(doc, composerFrameCount(doc) - 1);
  assert.ok((start.layers[0]?.x ?? 1) < (end.layers[0]?.x ?? 0));
});

test('camera presets reuse viewAt and only crop in 2D', () => {
  const push = composerCameraPreset('push-in', 5, '16:9');
  assert.equal(viewAt(push, 0).rect.w, 1);
  assert.ok(viewAt(push, 1).rect.w < 0.8);
  assert.match(describeCameraPlan(push), /not a 3D/);
  const pan = composerCameraPreset('pan-right', 5, '16:9');
  assert.ok(viewAt(pan, 1).rect.x > viewAt(pan, 0).rect.x);
  const pull = composerCameraPreset('pull-out', 5, '16:9');
  assert.ok(viewAt(pull, 1).rect.w > viewAt(pull, 0).rect.w);
  const doc = stage(
    [layer({ id: 'subject', assetId: 'subject', scale: 8 / 18 })],
    { durationSeconds: 5, camera: composerCameraPreset('push-in', 5, '16:9') },
  );
  const images = new Map<string, RgbaImage>([['subject', solid(8, 8, [0, 180, 0, 255])]]);
  const first = renderComposerRgba(doc, 0, images);
  const last = renderComposerRgba(doc, composerSampleIndices(doc).last, images);
  assert.deepEqual(pixel(first, 32, 16, 9), [0, 180, 0, 255]);
  assert.deepEqual(pixel(last, 32, 16, 9), [0, 180, 0, 255]);
  assert.ok(countColor(last, 32, 9, [0, 180, 0, 255]) > countColor(first, 32, 9, [0, 180, 0, 255]));
  const rolled = stage(
    [layer({ id: 'plate', assetId: 'plate' })],
    {
      camera: {
        ...emptyCameraPlan(),
        frameMode: false,
        durationSeconds: 1,
        aspectRatio: '16:9',
        steps: [{ id: 'roll', axis: 'roll', amount: 1, start: 0, end: 1, ease: 'linear' }],
      },
    },
  );
  const plate = solid(32, 18, [0, 0, 180, 255]);
  for (let x = 0; x < 32; x++) {
    const i = x * 4;
    plate.data[i] = 220;
    plate.data[i + 1] = 0;
    plate.data[i + 2] = 0;
  }
  assert.equal(resolveComposerFrame(rolled, composerFrameCount(rolled) - 1).camera.angleDeg, 12);
  const still = renderComposerRgba(rolled, 0, new Map([['plate', plate]]));
  const turned = renderComposerRgba(rolled, composerFrameCount(rolled) - 1, new Map([['plate', plate]]));
  assert.notEqual(sha(still), sha(turned));
});

test('saving a composer does not change the camera plan, shot, or takes', async () => {
  const { root, store } = await makeStore('composer-keep');
  roots.push(root);
  const project = await makeProject(store, 'keep');
  const { shotId, promptVersionId } = makeShotWithPrompt(project, 't2va');
  const before = getShot(project, shotId);
  await fakeTake(project, shotId, promptVersionId, 'keep');
  const plan = saveCameraPlan(project, shotId, { ...emptyCameraPlan(), sourceAssetId: null, durationSeconds: 4, frameMode: true });
  const jobsBefore = project.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM render_jobs')?.n ?? 0;
  saveShotComposer(project, shotId, { layers: [], durationSeconds: 5 });
  const again = saveShotComposer(project, shotId, getShotComposer(project, shotId));
  assert.equal(again.durationSeconds, 5);
  assert.deepEqual(getCameraPlan(project, shotId), plan);
  assert.equal(getShot(project, shotId).title, before.title);
  assert.equal(getShot(project, shotId).status, before.status);
  assert.equal(listTakes(project, shotId).length, 1);
  assert.equal(project.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM render_jobs')?.n ?? 0, jobsBefore);
});

async function writePngAsset(
  project: Awaited<ReturnType<typeof makeProject>>,
  fileName: string,
  image: RgbaImage,
  label: string,
) {
  const rel = `assets/${fileName}`;
  const abs = project.resolveProjectPath(rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, encodePng(image));
  return insertMedia(project, {
    kind: 'image',
    fileName: rel,
    mimeType: 'image/png',
    sizeBytes: 8,
    width: image.width,
    height: image.height,
    source: 'import',
    label,
  });
}

test('missing files, escaping paths, and non-image layers fail closed', async () => {
  const { root, store } = await makeStore('composer-bad');
  roots.push(root);
  const project = await makeProject(store, 'bad');
  const shot = createShot(project, { title: 'Bad', durationSeconds: 5 });
  const missing = insertMedia(project, {
    kind: 'image',
    fileName: 'assets/missing.png',
    mimeType: 'image/png',
    sizeBytes: 1,
    source: 'import',
    label: 'missing',
  });
  saveShotComposer(project, shot.id, stage([layer({ id: 'a', assetId: missing.id })]));
  await assert.rejects(
    () => exportShotComposerFrames(project, new Ffmpeg(), shot.id),
    (error: unknown) => error instanceof ComposerError && /asset path/.test(error.message),
  );
  const escaped = insertMedia(project, {
    kind: 'image',
    fileName: '../outside.png',
    mimeType: 'image/png',
    sizeBytes: 1,
    source: 'import',
    label: 'escaped',
  });
  saveShotComposer(project, shot.id, stage([layer({ id: 'a', assetId: escaped.id })]));
  await assert.rejects(
    () => exportShotComposerFrames(project, new Ffmpeg(), shot.id),
    (error: unknown) => error instanceof ComposerError && /asset path/.test(error.message),
  );
  const real = await writePngAsset(project, 'real.png', solid(8, 8, [10, 20, 30, 255]), 'real');
  saveShotComposer(project, shot.id, stage([
    layer({ id: 'hidden-video', assetId: null, sourceKind: 'video', visible: false, zIndex: 0 }),
    layer({ id: 'shown', assetId: real.id, zIndex: 1, scale: 0.5 }),
  ]));
  const stills = await exportShotComposerFrames(project, new Ffmpeg(), shot.id);
  assert.equal(stills.videoAssetId, null);
  assert.equal(stills.width, 32);
  saveShotComposer(project, shot.id, stage([layer({ id: 'clip', assetId: real.id, sourceKind: 'video' })]));
  await assert.rejects(
    () => exportShotComposerFrames(project, new Ffmpeg(), shot.id),
    (error: unknown) => error instanceof ComposerError && /unsupported composer source kind: video/.test(error.message),
  );
});

test('first and last stills bind only for modes the provider already supports', async () => {
  const { root, store } = await makeStore('composer-bind');
  roots.push(root);
  const project = await makeProject(store, 'bind');
  const { shotId } = makeShotWithPrompt(project, 'i2va');
  const image = await writePngAsset(project, 'plate.png', solid(32, 18, [20, 40, 60, 255]), 'plate');
  saveShotComposer(project, shotId, stage([layer({ id: 'plate', assetId: image.id })]));
  const ffmpeg = new Ffmpeg();
  const textOnly = await exportShotComposerFrames(project, ffmpeg, shotId, { bind: true, supportedModes: ['t2va'] });
  assert.equal(textOnly.firstBindingId, null);
  assert.equal(textOnly.lastBindingId, null);
  assert.equal(textOnly.handoff.lastFrameModes.length, 0);
  assert.equal(project.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM render_jobs')?.n ?? 0, 0);

  const firstOnly = await exportShotComposerFrames(project, ffmpeg, shotId, { bind: true, supportedModes: ['i2va'] });
  assert.ok(firstOnly.firstBindingId);
  assert.equal(firstOnly.lastBindingId, null);
  const lastOnly = await exportShotComposerFrames(project, ffmpeg, shotId, { bind: true, supportedModes: ['l2va'] });
  assert.equal(lastOnly.firstBindingId, null);
  assert.ok(lastOnly.lastBindingId);

  const user = await writePngAsset(project, 'user.png', solid(4, 4, [1, 2, 3, 255]), 'user');
  createBinding(project, { assetId: user.id, roles: ['first_frame'], label: 'User first frame', shotId });
  const both = await exportShotComposerFrames(project, ffmpeg, shotId, { bind: true, supportedModes: ['fl2va'] });
  assert.equal(both.firstBindingId, null);
  assert.ok(both.lastBindingId);
  const labels = listBindings(project, shotId).map((binding) => binding.label);
  assert.ok(labels.includes('User first frame'));
  assert.equal(labels.filter((label) => label.startsWith('Composer first')).length, 0);
  const unbound = await exportShotComposerFrames(project, ffmpeg, shotId, { bind: false, supportedModes: ['i2va', 'fl2va', 'l2va'] });
  assert.equal(unbound.firstBindingId, null);
  assert.equal(unbound.lastBindingId, null);
  const decoded = decodePng(await readFile(project.resolveProjectPath(getMedia(project, both.firstAssetId).fileName)));
  assert.equal(decoded.width, 32);
  assert.equal(decoded.height, 18);
});

test('palace rehearsal keeps the figure planted, the column in front, and the push-in centered', () => {
  const doc = palaceComposer({ hall: 'hall', figure: 'figure', column: 'column' }, { width: 320, height: 180 });
  assert.equal(doc.fps, 24);
  assert.equal(doc.durationSeconds, 5);
  assert.equal(composerFrameCount(doc), 120);
  const images = new Map<string, RgbaImage>([
    ['hall', paintPalaceHall()],
    ['figure', paintPalaceFigure()],
    ['column', paintPalaceColumn()],
  ]);
  const firstIndex = 0;
  const lastIndex = composerSampleIndices(doc).last;
  const first = renderComposerRgba(doc, firstIndex, images);
  const last = renderComposerRgba(doc, lastIndex, images);
  assert.equal(sha(first), sha(renderComposerRgba(doc, firstIndex, images)));
  const robe0 = outputPixel(doc, firstIndex, PALACE_SAMPLES.robe.x, PALACE_SAMPLES.robe.y);
  const cover0 = outputPixel(doc, firstIndex, PALACE_SAMPLES.occlusion.x, PALACE_SAMPLES.occlusion.y);
  const sky0 = outputPixel(doc, firstIndex, PALACE_SAMPLES.ceiling.x, PALACE_SAMPLES.ceiling.y);
  assert.deepEqual(pixel(first, doc.width, robe0.x, robe0.y), [...PALACE_COLOR.robe]);
  assert.deepEqual(pixel(first, doc.width, cover0.x, cover0.y), [...PALACE_COLOR.column]);
  assert.deepEqual(pixel(first, doc.width, sky0.x, sky0.y), [...PALACE_COLOR.ceiling]);
  const robe1 = outputPixel(doc, lastIndex, PALACE_SAMPLES.robe.x, PALACE_SAMPLES.robe.y);
  const cover1 = outputPixel(doc, lastIndex, PALACE_SAMPLES.occlusion.x, PALACE_SAMPLES.occlusion.y);
  assert.deepEqual(pixel(last, doc.width, robe1.x, robe1.y), [...PALACE_COLOR.robe]);
  assert.deepEqual(pixel(last, doc.width, cover1.x, cover1.y), [...PALACE_COLOR.column]);
  assert.equal(resolveComposerFrame(doc, firstIndex).layers.find((item) => item.id === 'figure')?.x, 0.5);
  assert.equal(resolveComposerFrame(doc, lastIndex).layers.find((item) => item.id === 'figure')?.x, 0.5);
  assert.ok(countColor(last, doc.width, robe1.y, PALACE_COLOR.robe) > countColor(first, doc.width, robe0.y, PALACE_COLOR.robe));
  assert.ok(viewAt(doc.camera, 1).rect.w < viewAt(doc.camera, 0).rect.w);
});

function outputPixel(doc: ShotComposer, frameIndex: number, nx: number, ny: number): { x: number; y: number } {
  const view = resolveComposerFrame(doc, frameIndex).camera.rect;
  return {
    x: Math.round(((nx - view.x) / view.w) * doc.width - 0.5),
    y: Math.round(((ny - view.y) / view.h) * doc.height - 0.5),
  };
}

test('preview MP4 is 24fps and five seconds, and the palace demo can be reloaded', async (t) => {
  const ffmpeg = new Ffmpeg();
  if (!(await ffmpeg.capabilityCheck()).available) {
    t.skip('ffmpeg not available');
    return;
  }
  const { root, store } = await makeStore('composer-mp4');
  roots.push(root);
  const project = await makeProject(store, 'mp4');
  const { shotId } = makeShotWithPrompt(project, 'fl2va');
  const installed = await installPalaceDemo(project, shotId, { width: 320, height: 180 });
  assert.equal(getShot(project, shotId).durationSeconds, 5);
  assert.equal(getShot(project, shotId).aspectRatio, '16:9');
  assert.equal(installed.composer.layers.length, 3);
  const saved = getShotComposer(project, shotId);
  assert.equal(saved?.layers.find((item) => item.role === 'foreground')?.zIndex, 20);
  const jobsBefore = project.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM render_jobs')?.n ?? 0;
  const preview = await exportShotComposerPreview(project, ffmpeg, shotId, { bind: true, supportedModes: ['fl2va', 'i2va', 'l2va'] });
  assert.equal(preview.width, 320);
  assert.equal(preview.height, 180);
  assert.equal(preview.fps, 24);
  assert.equal(preview.frameCount, 120);
  assert.equal(preview.durationSeconds, 5);
  assert.ok(preview.videoAssetId);
  assert.ok(preview.firstBindingId);
  assert.ok(preview.lastBindingId);
  assert.equal(project.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM render_jobs')?.n ?? 0, jobsBefore);
  const video = getMedia(project, preview.videoAssetId!);
  const { stdout } = await exec('ffprobe', [
    '-v', 'error',
    '-count_frames',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=nb_read_frames,width,height,duration,avg_frame_rate',
    '-of', 'json',
    project.resolveProjectPath(video.fileName),
  ]);
  const stream = (JSON.parse(stdout) as { streams: Array<{ nb_read_frames?: string; width: number; height: number; duration?: string; avg_frame_rate?: string }> }).streams[0];
  assert.ok(stream);
  assert.equal(stream.width, 320);
  assert.equal(stream.height, 180);
  assert.equal(Number(stream.nb_read_frames), 120);
  assert.ok(Math.abs(Number(stream.duration) - 5) < 0.05);
  assert.equal(stream.avg_frame_rate, '24/1');
});
