// Synthetic palace rehearsal. Flat color regions are intentional: tests sample
// them and expect exact bytes. Nothing here is a photograph or a licensed still.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  composerCameraPreset,
  composerFrameCount,
  composerSampleIndices,
  normalizeShotComposer,
  type ShotComposer,
} from '@h3mise/shared';
import type { Ffmpeg } from '../ffmpeg.js';
import { encodePng, renderComposerRgbaInto, type RgbaImage } from './shot-composer-raster.js';

export const PALACE_COLOR = {
  ceiling: [32, 44, 72, 255],
  wall: [110, 86, 64, 255],
  floor: [168, 132, 78, 255],
  column: [74, 48, 32, 255],
  robe: [216, 199, 161, 255],
  head: [236, 214, 190, 255],
  gold: [212, 168, 72, 255],
  shadow: [62, 48, 36, 255],
} as const;

/**
 * Stage-normalized points that sit in flat color.
 * `ceiling` is outside the push-in end crop; the other two stay inside it.
 */
export const PALACE_SAMPLES = {
  robe: { x: 0.52, y: 0.62 },
  occlusion: { x: 0.46, y: 0.62 },
  ceiling: { x: 0.7, y: 0.08 },
} as const;

export const PALACE_FIGURE_SIZE = { width: 360, height: 720 };
export const PALACE_COLUMN_SIZE = { width: 220, height: 720 };

type Rgba = readonly [number, number, number, number];

function paint(width: number, height: number, pixel: (x: number, y: number) => Rgba | null): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = pixel(x, y);
      if (!color) continue;
      const i = (y * width + x) * 4;
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = color[3];
    }
  }
  return { width, height, data };
}

export function paintPalaceHall(width = 1280, height = 720): RgbaImage {
  return paint(width, height, (x, y) => {
    const nx = x / width;
    const ny = y / height;
    const distantColumn = (nx > 0.08 && nx < 0.14) || (nx > 0.86 && nx < 0.92);
    if (distantColumn && ny > 0.18 && ny < 0.78) return PALACE_COLOR.shadow;
    const arch = nx > 0.38 && nx < 0.62 && ny > 0.16 && ny < 0.58 && (nx < 0.42 || nx > 0.58 || ny > 0.5);
    if (arch) return PALACE_COLOR.gold;
    if (ny < 0.34) return PALACE_COLOR.ceiling;
    if (ny < 0.62) return PALACE_COLOR.wall;
    return Math.floor(y / 14) % 2 === 0 ? PALACE_COLOR.wall : PALACE_COLOR.floor;
  });
}

export function paintPalaceFigure(width = PALACE_FIGURE_SIZE.width, height = PALACE_FIGURE_SIZE.height): RgbaImage {
  return paint(width, height, (x, y) => {
    const u = x / width;
    const v = y / height;
    const head = ((u - 0.5) ** 2) / (0.16 ** 2) + ((v - 0.12) ** 2) / (0.08 ** 2) <= 1;
    if (head) return PALACE_COLOR.head;
    if (u >= 0.22 && u <= 0.78 && v >= 0.2 && v <= 0.98) return PALACE_COLOR.robe;
    return null;
  });
}

export function paintPalaceColumn(width = PALACE_COLUMN_SIZE.width, height = PALACE_COLUMN_SIZE.height): RgbaImage {
  return paint(width, height, (_x, y) => {
    const v = y / height;
    return v < 0.08 || v > 0.93 ? PALACE_COLOR.gold : PALACE_COLOR.column;
  });
}

/** The rehearsal: centered figure, foreground column overlapping its left side, slow 2D push-in. */
export function palaceComposer(
  assets: { hall: string; figure: string; column: string },
  size?: { width: number; height: number },
): ShotComposer {
  const width = size?.width ?? 1280;
  const height = size?.height ?? 720;
  return normalizeShotComposer({
    version: 1,
    durationSeconds: 5,
    fps: 24,
    aspectRatio: '16:9',
    width,
    height,
    camera: composerCameraPreset('push-in', 5, '16:9'),
    layers: [
      {
        id: 'hall',
        name: 'Palace hall',
        role: 'background',
        assetId: assets.hall,
        sourceKind: 'image',
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
      },
      {
        id: 'figure',
        name: 'Figure',
        role: 'subject',
        assetId: assets.figure,
        sourceKind: 'image',
        x: 0.5,
        y: 0.62,
        anchorX: 0.5,
        anchorY: 0.5,
        scale: 0.72,
        rotation: 0,
        opacity: 1,
        zIndex: 10,
        visible: true,
        keyframes: [],
      },
      {
        id: 'column',
        name: 'Foreground column',
        role: 'foreground',
        assetId: assets.column,
        sourceKind: 'image',
        x: 0.39,
        y: 0.5,
        anchorX: 0.5,
        anchorY: 0.5,
        scale: 1,
        rotation: 0,
        opacity: 1,
        zIndex: 20,
        visible: true,
        keyframes: [],
      },
    ],
  });
}

export function palaceImages(): { hall: RgbaImage; figure: RgbaImage; column: RgbaImage } {
  return {
    hall: paintPalaceHall(),
    figure: paintPalaceFigure(),
    column: paintPalaceColumn(),
  };
}

/** Write the committable fixtures plus a 16:9, 24fps, 5s rehearsal. */
export async function writePalaceDemoFiles(dir: string, ffmpeg: Ffmpeg, size?: { width: number; height: number }): Promise<ShotComposer> {
  const images = palaceImages();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'palace-hall.png'), encodePng(images.hall));
  await writeFile(join(dir, 'figure.png'), encodePng(images.figure));
  await writeFile(join(dir, 'foreground.png'), encodePng(images.column));
  const doc = palaceComposer({ hall: 'palace-hall.png', figure: 'figure.png', column: 'foreground.png' }, size);
  const bitmaps = new Map<string, RgbaImage>([
    ['palace-hall.png', images.hall],
    ['figure.png', images.figure],
    ['foreground.png', images.column],
  ]);
  const renders = join(dir, 'renders');
  await mkdir(renders, { recursive: true });
  const stage = new Uint8Array(doc.width * doc.height * 4);
  const frame = new Uint8Array(doc.width * doc.height * 4);
  const samples = composerSampleIndices(doc);
  const saved = new Map<number, Uint8Array>();
  const count = composerFrameCount(doc);
  const mp4 = join(renders, 'preview.mp4');
  await ffmpeg.encodeRgbaStream(
    { width: doc.width, height: doc.height, fps: doc.fps, frameCount: count },
    mp4,
    async (writeFrame) => {
      for (let index = 0; index < count; index++) {
        renderComposerRgbaInto(doc, index, bitmaps, stage, frame);
        if (index === samples.first || index === samples.mid || index === samples.last) saved.set(index, frame.slice());
        await writeFrame(frame);
      }
    },
  );
  const names: Record<number, string> = {
    [samples.first]: 'first_frame.png',
    [samples.mid]: 'mid_frame.png',
    [samples.last]: 'last_frame.png',
  };
  for (const [index, name] of Object.entries(names)) {
    const rgba = saved.get(Number(index));
    if (!rgba) throw new Error(`missing demo frame ${index}`);
    await writeFile(join(renders, name), encodePng({ width: doc.width, height: doc.height, data: rgba }));
  }
  await writeFile(join(dir, 'scene.json'), JSON.stringify({
    note: 'Asset ids in this file are the fixture filenames. Import them into a project to bind real media ids. The camera is a 2D crop, not a 3D move.',
    spatial: '2d-crop',
    composer: doc,
  }, null, 2));
  return doc;
}
