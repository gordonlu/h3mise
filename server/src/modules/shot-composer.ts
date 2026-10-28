// Shot composer persistence and export.
// Stills and the preview MP4 are local. Binding a still only creates a
// reference binding when the active provider already has that frame slot.
// Nothing here submits a render or skips Preflight.

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ComposerHandoff, MediaAsset, ShotComposer } from '@h3mise/shared';
import {
  ComposerError,
  assertComposerImagesRenderable,
  composerCanBindFrame,
  composerFrameCount,
  composerHandoffForModes,
  composerSampleIndices,
  normalizeShotComposer,
} from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import type { Ffmpeg } from '../ffmpeg.js';
import { j, jget } from '../db/sqlite.js';
import { nextId } from '../db/ids.js';
import { createBinding, deleteBinding, getMedia, insertMedia, listBindings, listMedia } from './assets.js';
import { getShot, updateShot } from './shots.js';
import { decodePng, encodePng, renderComposerRgba, renderComposerRgbaInto, type RgbaImage } from './shot-composer-raster.js';
import { paintPalaceColumn, paintPalaceFigure, paintPalaceHall, palaceComposer } from './shot-composer-fixtures.js';

interface ComposerRow {
  id: string;
  shot_id: string;
  document_json: string;
  created_at: string;
  updated_at: string;
}

export interface ComposerExportResult {
  firstAssetId: string;
  midAssetId: string;
  lastAssetId: string;
  videoAssetId: string | null;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  durationSeconds: number;
  firstBindingId: string | null;
  lastBindingId: string | null;
  handoff: ComposerHandoff;
}

export function getShotComposer(p: ProjectContext, shotId: string): ShotComposer | null {
  const row = p.db.get<ComposerRow>('SELECT * FROM shot_composers WHERE shot_id = ?', [shotId]);
  return row ? normalizeShotComposer(jget<unknown>(row.document_json, null)) : null;
}

export function saveShotComposer(p: ProjectContext, shotId: string, raw: unknown): ShotComposer {
  getShot(p, shotId);
  const doc = normalizeShotComposer(raw);
  for (const layer of doc.layers) {
    if (layer.assetId) getMedia(p, layer.assetId);
  }
  const existing = p.db.get<{ id: string }>('SELECT id FROM shot_composers WHERE shot_id = ?', [shotId]);
  const now = new Date().toISOString();
  if (existing) {
    p.db.run('UPDATE shot_composers SET document_json = ?, updated_at = ? WHERE shot_id = ?', [j(doc), now, shotId]);
  } else {
    p.db.run(
      'INSERT INTO shot_composers (id, shot_id, document_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      [nextId(p.db, 'composer'), shotId, j(doc), now, now],
    );
  }
  return doc;
}

async function loadImages(p: ProjectContext, ffmpeg: Ffmpeg, doc: ShotComposer): Promise<Map<string, RgbaImage>> {
  const images = new Map<string, RgbaImage>();
  for (const layer of doc.layers) {
    if (!layer.visible || !layer.assetId) continue;
    if (layer.sourceKind !== 'image') throw new ComposerError(`unsupported composer source kind: ${layer.sourceKind}`);
    if (images.has(layer.assetId)) continue;
    const asset = getMedia(p, layer.assetId);
    if (asset.kind !== 'image') throw new ComposerError('unsupported composer layer media');
    let abs: string;
    try {
      abs = p.resolveProjectPath(asset.fileName);
    } catch {
      throw new ComposerError('invalid composer asset path');
    }
    let bytes: Buffer | null = null;
    if (asset.fileName.toLowerCase().endsWith('.png')) {
      try {
        bytes = await readFile(abs);
      } catch {
        throw new ComposerError('invalid composer asset path');
      }
      try {
        images.set(layer.assetId, decodePng(bytes));
      } catch {
        throw new ComposerError('unsupported composer layer media');
      }
      continue;
    }
    try {
      images.set(layer.assetId, await ffmpeg.readImageRgba(abs));
    } catch (error) {
      if (error instanceof ComposerError) throw error;
      const missing = error instanceof Error && /no such file|ENOENT/i.test(error.message);
      throw new ComposerError(missing ? 'invalid composer asset path' : 'unsupported composer layer media');
    }
  }
  return images;
}

function requireComposer(p: ProjectContext, shotId: string): ShotComposer {
  const doc = getShotComposer(p, shotId);
  if (!doc) throw new ComposerError('invalid composer: not saved');
  assertComposerImagesRenderable(doc);
  return doc;
}

async function writeStill(
  p: ProjectContext,
  rgba: Uint8Array,
  width: number,
  height: number,
  label: string,
  stem: string,
): Promise<MediaAsset> {
  const id = nextId(p.db, 'media');
  const rel = `assets/${stem}-${id}.png`;
  const abs = p.resolveProjectPath(rel);
  await mkdir(dirname(abs), { recursive: true });
  const png = encodePng({ width, height, data: rgba });
  await writeFile(abs, png);
  return insertMedia(p, {
    id,
    kind: 'image',
    fileName: rel,
    mimeType: 'image/png',
    sizeBytes: png.length,
    width,
    height,
    source: 'other',
    label,
  });
}

function bindExportedFrames(
  p: ProjectContext,
  shotId: string,
  firstAssetId: string,
  lastAssetId: string,
  supportedModes: readonly string[],
  bind: boolean,
): { firstBindingId: string | null; lastBindingId: string | null; handoff: ComposerHandoff } {
  const handoff = composerHandoffForModes(supportedModes);
  const canFirst = composerCanBindFrame(handoff, 'first_frame');
  const canLast = composerCanBindFrame(handoff, 'last_frame');
  // An unsupported request must not delete bindings written by an earlier
  // export when the provider did support them.
  if (!bind || (!canFirst && !canLast)) return { firstBindingId: null, lastBindingId: null, handoff };
  const shotBindings = listBindings(p, shotId);
  const ours = (label: string) => label.startsWith('Composer ');
  for (const binding of shotBindings) {
    const framed = binding.roles.includes('first_frame') || binding.roles.includes('last_frame');
    if (framed && ours(binding.label)) deleteBinding(p, binding.id);
  }
  const remainsFirst = shotBindings.some((binding) => !ours(binding.label) && binding.roles.includes('first_frame'));
  const remainsLast = shotBindings.some((binding) => !ours(binding.label) && binding.roles.includes('last_frame'));
  const firstBindingId = !remainsFirst && canFirst
    ? createBinding(p, { assetId: firstAssetId, roles: ['first_frame'], label: 'Composer first frame (planned)', shotId }).id
    : null;
  const lastBindingId = !remainsLast && canLast
    ? createBinding(p, { assetId: lastAssetId, roles: ['last_frame'], label: 'Composer last frame (planned)', shotId }).id
    : null;
  return { firstBindingId, lastBindingId, handoff };
}

async function renderSampleRgba(
  p: ProjectContext,
  ffmpeg: Ffmpeg,
  doc: ShotComposer,
): Promise<{ images: Map<string, RgbaImage>; first: Uint8Array; mid: Uint8Array; last: Uint8Array }> {
  const images = await loadImages(p, ffmpeg, doc);
  const samples = composerSampleIndices(doc);
  return {
    images,
    first: renderComposerRgba(doc, samples.first, images),
    mid: renderComposerRgba(doc, samples.mid, images),
    last: renderComposerRgba(doc, samples.last, images),
  };
}

export async function renderShotComposerPng(
  p: ProjectContext,
  ffmpeg: Ffmpeg,
  shotId: string,
  frameIndex: number,
  raw?: unknown,
): Promise<Buffer> {
  const doc = raw === undefined ? requireComposer(p, shotId) : normalizeShotComposer(raw);
  getShot(p, shotId);
  assertComposerImagesRenderable(doc);
  for (const layer of doc.layers) {
    if (layer.assetId) getMedia(p, layer.assetId);
  }
  const images = await loadImages(p, ffmpeg, doc);
  const rgba = renderComposerRgba(doc, frameIndex, images);
  return encodePng({ width: doc.width, height: doc.height, data: rgba });
}

export async function exportShotComposerFrames(
  p: ProjectContext,
  ffmpeg: Ffmpeg,
  shotId: string,
  options?: { bind?: boolean; supportedModes?: readonly string[] },
): Promise<ComposerExportResult> {
  const doc = requireComposer(p, shotId);
  const rendered = await renderSampleRgba(p, ffmpeg, doc);
  const first = await writeStill(p, rendered.first, doc.width, doc.height, 'Composer first frame', 'composer-first');
  const mid = await writeStill(p, rendered.mid, doc.width, doc.height, 'Composer mid frame', 'composer-mid');
  const last = await writeStill(p, rendered.last, doc.width, doc.height, 'Composer last frame', 'composer-last');
  const bound = bindExportedFrames(p, shotId, first.id, last.id, options?.supportedModes ?? [], options?.bind === true);
  return {
    firstAssetId: first.id,
    midAssetId: mid.id,
    lastAssetId: last.id,
    videoAssetId: null,
    width: doc.width,
    height: doc.height,
    fps: doc.fps,
    frameCount: composerFrameCount(doc),
    durationSeconds: doc.durationSeconds,
    ...bound,
  };
}

export async function exportShotComposerPreview(
  p: ProjectContext,
  ffmpeg: Ffmpeg,
  shotId: string,
  options?: {
    bind?: boolean;
    supportedModes?: readonly string[];
    onProgress?: (frame: number, total: number) => void;
  },
): Promise<ComposerExportResult> {
  const doc = requireComposer(p, shotId);
  const images = await loadImages(p, ffmpeg, doc);
  const frameCount = composerFrameCount(doc);
  const samples = composerSampleIndices(doc);
  const stage = new Uint8Array(doc.width * doc.height * 4);
  const frame = new Uint8Array(doc.width * doc.height * 4);
  let firstRgba: Uint8Array | null = null;
  let midRgba: Uint8Array | null = null;
  let lastRgba: Uint8Array | null = null;
  const id = nextId(p.db, 'media');
  const rel = `assets/composer-preview-${id}.mp4`;
  const abs = p.resolveProjectPath(rel);
  await mkdir(dirname(abs), { recursive: true });
  const part = `${abs}.part`;
  await ffmpeg.encodeRgbaStream(
    { width: doc.width, height: doc.height, fps: doc.fps, frameCount },
    part,
    async (writeFrame) => {
      for (let index = 0; index < frameCount; index++) {
        renderComposerRgbaInto(doc, index, images, stage, frame);
        if (index === samples.first) firstRgba = frame.slice();
        if (index === samples.mid) midRgba = frame.slice();
        if (index === samples.last) lastRgba = frame.slice();
        await writeFrame(frame);
        options?.onProgress?.(index + 1, frameCount);
      }
    },
  );
  if (!firstRgba || !midRgba || !lastRgba) throw new ComposerError('invalid composer frame');
  const fileStat = await stat(part);
  await rename(part, abs);
  const video = insertMedia(p, {
    id,
    kind: 'video',
    fileName: rel,
    mimeType: 'video/mp4',
    sizeBytes: fileStat.size,
    width: doc.width,
    height: doc.height,
    durationSeconds: doc.durationSeconds,
    source: 'other',
    label: 'Composer preview',
  });
  const first = await writeStill(p, firstRgba, doc.width, doc.height, 'Composer first frame', 'composer-first');
  const mid = await writeStill(p, midRgba, doc.width, doc.height, 'Composer mid frame', 'composer-mid');
  const last = await writeStill(p, lastRgba, doc.width, doc.height, 'Composer last frame', 'composer-last');
  const bound = bindExportedFrames(p, shotId, first.id, last.id, options?.supportedModes ?? [], options?.bind === true);
  return {
    firstAssetId: first.id,
    midAssetId: mid.id,
    lastAssetId: last.id,
    videoAssetId: video.id,
    width: doc.width,
    height: doc.height,
    fps: doc.fps,
    frameCount,
    durationSeconds: doc.durationSeconds,
    ...bound,
  };
}

const DEMO_HALL = 'Composer demo — palace hall';
const DEMO_FIGURE = 'Composer demo — figure';
const DEMO_COLUMN = 'Composer demo — foreground';

async function upsertDemoPng(p: ProjectContext, label: string, fileName: string, image: RgbaImage): Promise<MediaAsset> {
  const existing = listMedia(p).find((asset) => asset.label === label && asset.kind === 'image');
  const rel = existing?.fileName ?? `assets/${fileName}`;
  let abs: string;
  try {
    abs = p.resolveProjectPath(rel);
  } catch {
    throw new ComposerError('invalid composer asset path');
  }
  await mkdir(dirname(abs), { recursive: true });
  const png = encodePng(image);
  await writeFile(abs, png);
  if (existing) return existing;
  return insertMedia(p, {
    kind: 'image',
    fileName: rel,
    mimeType: 'image/png',
    sizeBytes: png.length,
    width: image.width,
    height: image.height,
    source: 'import',
    label,
  });
}

/** Load the built-in palace rehearsal onto a shot. Does not submit a render. */
export async function installPalaceDemo(
  p: ProjectContext,
  shotId: string,
  size?: { width: number; height: number },
): Promise<{ composer: ShotComposer; hallAssetId: string; figureAssetId: string; columnAssetId: string }> {
  getShot(p, shotId);
  const hall = await upsertDemoPng(p, DEMO_HALL, 'composer-demo-hall.png', paintPalaceHall());
  const figure = await upsertDemoPng(p, DEMO_FIGURE, 'composer-demo-figure.png', paintPalaceFigure());
  const column = await upsertDemoPng(p, DEMO_COLUMN, 'composer-demo-foreground.png', paintPalaceColumn());
  const composer = saveShotComposer(p, shotId, palaceComposer({
    hall: hall.id,
    figure: figure.id,
    column: column.id,
  }, size));
  updateShot(p, shotId, { durationSeconds: composer.durationSeconds, aspectRatio: composer.aspectRatio });
  return { composer, hallAssetId: hall.id, figureAssetId: figure.id, columnAssetId: column.id };
}
