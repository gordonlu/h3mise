// Deterministic nearest-neighbor compositor.
// The p5 preview uses the same resolveComposerFrame() and layerDrawRect()
// placement. This rasterizer is what stills and the MP4 are built from, so
// repeating a frame does not depend on the clock or on a browser.

import { PNG } from 'pngjs';
import {
  ComposerError,
  layerDrawRect,
  resolveComposerFrame,
  type ResolvedComposerLayer,
  type ShotComposer,
} from '@h3mise/shared';

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export function decodePng(bytes: Buffer): RgbaImage {
  const png = PNG.sync.read(bytes);
  return { width: png.width, height: png.height, data: Uint8Array.from(png.data) };
}

export function encodePng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data.set(image.data.subarray(0, png.data.length));
  return PNG.sync.write(png);
}

function fillOpaqueBlack(buffer: Uint8Array): void {
  buffer.fill(0);
  for (let i = 3; i < buffer.length; i += 4) buffer[i] = 255;
}

function composite(stage: Uint8Array, di: number, sr: number, sg: number, sb: number, sa: number): void {
  if (sa <= 0) return;
  if (sa >= 255) {
    stage[di] = sr;
    stage[di + 1] = sg;
    stage[di + 2] = sb;
    stage[di + 3] = 255;
    return;
  }
  const dr = stage[di] ?? 0;
  const dg = stage[di + 1] ?? 0;
  const db = stage[di + 2] ?? 0;
  const da = stage[di + 3] ?? 0;
  const inv = 255 - sa;
  const outA = sa + Math.round((da * inv) / 255);
  if (outA <= 0) return;
  stage[di] = Math.min(255, Math.round((sr * sa + (dr * da * inv) / 255) / outA));
  stage[di + 1] = Math.min(255, Math.round((sg * sa + (dg * da * inv) / 255) / outA));
  stage[di + 2] = Math.min(255, Math.round((sb * sa + (db * da * inv) / 255) / outA));
  stage[di + 3] = Math.min(255, outA);
}

function sampleSource(image: RgbaImage, u: number, v: number, opacity: number): { r: number; g: number; b: number; a: number } | null {
  if (u < 0 || v < 0 || u >= image.width || v >= image.height) return null;
  const x = Math.min(image.width - 1, Math.floor(u));
  const y = Math.min(image.height - 1, Math.floor(v));
  const si = (y * image.width + x) * 4;
  const srcA = image.data[si + 3] ?? 0;
  if (srcA === 0 || opacity <= 0) return null;
  const a = opacity >= 1 ? srcA : Math.round(srcA * opacity);
  if (a <= 0) return null;
  return { r: image.data[si] ?? 0, g: image.data[si + 1] ?? 0, b: image.data[si + 2] ?? 0, a };
}

function blitAxisAligned(
  stage: Uint8Array,
  stageW: number,
  stageH: number,
  image: RgbaImage,
  left: number,
  top: number,
  destW: number,
  destH: number,
  opacity: number,
): void {
  const x0 = Math.max(0, Math.floor(left));
  const y0 = Math.max(0, Math.floor(top));
  const x1 = Math.min(stageW, Math.ceil(left + destW));
  const y1 = Math.min(stageH, Math.ceil(top + destH));
  const srcW = image.width;
  const srcH = image.height;
  for (let y = y0; y < y1; y++) {
    const localY = y + 0.5 - top;
    if (localY < 0 || localY >= destH) continue;
    const v = (localY / destH) * srcH;
    const sy = Math.min(srcH - 1, Math.max(0, Math.floor(v)));
    const srcRow = sy * srcW;
    const stageRow = y * stageW;
    for (let x = x0; x < x1; x++) {
      const localX = x + 0.5 - left;
      if (localX < 0 || localX >= destW) continue;
      const sx = Math.min(srcW - 1, Math.max(0, Math.floor((localX / destW) * srcW)));
      const si = (srcRow + sx) * 4;
      const srcA = image.data[si + 3] ?? 0;
      if (srcA === 0) continue;
      const sa = opacity >= 1 ? srcA : Math.round(srcA * opacity);
      composite(stage, (stageRow + x) * 4, image.data[si] ?? 0, image.data[si + 1] ?? 0, image.data[si + 2] ?? 0, sa);
    }
  }
}

function blitRotated(
  stage: Uint8Array,
  stageW: number,
  stageH: number,
  image: RgbaImage,
  anchorPx: number,
  anchorPy: number,
  destW: number,
  destH: number,
  anchorX: number,
  anchorY: number,
  rotationDeg: number,
  opacity: number,
): void {
  const theta = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const local = [
    [-anchorX * destW, -anchorY * destH],
    [(1 - anchorX) * destW, -anchorY * destH],
    [(1 - anchorX) * destW, (1 - anchorY) * destH],
    [-anchorX * destW, (1 - anchorY) * destH],
  ];
  let minX = stageW;
  let maxX = 0;
  let minY = stageH;
  let maxY = 0;
  for (const corner of local) {
    const lx = corner[0] ?? 0;
    const ly = corner[1] ?? 0;
    const sx = anchorPx + lx * cos - ly * sin;
    const sy = anchorPy + lx * sin + ly * cos;
    minX = Math.min(minX, Math.floor(sx));
    maxX = Math.max(maxX, Math.ceil(sx));
    minY = Math.min(minY, Math.floor(sy));
    maxY = Math.max(maxY, Math.ceil(sy));
  }
  const x0 = Math.max(0, minX);
  const y0 = Math.max(0, minY);
  const x1 = Math.min(stageW, maxX);
  const y1 = Math.min(stageH, maxY);
  const invCos = cos;
  const invSin = -sin;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - anchorPx;
      const dy = y + 0.5 - anchorPy;
      const rx = dx * invCos - dy * invSin;
      const ry = dx * invSin + dy * invCos;
      const localX = rx + anchorX * destW;
      const localY = ry + anchorY * destH;
      if (localX < 0 || localY < 0 || localX >= destW || localY >= destH) continue;
      const sampled = sampleSource(image, (localX / destW) * image.width, (localY / destH) * image.height, opacity);
      if (!sampled) continue;
      composite(stage, (y * stageW + x) * 4, sampled.r, sampled.g, sampled.b, sampled.a);
    }
  }
}

function drawLayer(stage: Uint8Array, stageW: number, stageH: number, layer: ResolvedComposerLayer, image: RgbaImage): void {
  const draw = layerDrawRect(layer, stageW, stageH, image.width, image.height);
  if (draw.destW < 0.5 || draw.destH < 0.5) return;
  if (Math.abs(draw.rotationDeg) < 0.001) {
    blitAxisAligned(stage, stageW, stageH, image, draw.left, draw.top, draw.destW, draw.destH, layer.opacity);
    return;
  }
  blitRotated(
    stage,
    stageW,
    stageH,
    image,
    draw.anchorPx,
    draw.anchorPy,
    draw.destW,
    draw.destH,
    layer.anchorX,
    layer.anchorY,
    draw.rotationDeg,
    layer.opacity,
  );
}

function paintStage(doc: ShotComposer, frameIndex: number, images: ReadonlyMap<string, RgbaImage>, stage: Uint8Array): void {
  const frame = resolveComposerFrame(doc, frameIndex);
  fillOpaqueBlack(stage);
  for (const layer of frame.layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    if (layer.sourceKind !== 'image') throw new ComposerError(`unsupported composer source kind: ${layer.sourceKind}`);
    if (!layer.assetId) throw new ComposerError('invalid composer layer: missing asset');
    const image = images.get(layer.assetId);
    if (!image) throw new ComposerError('invalid composer layer: missing asset');
    drawLayer(stage, doc.width, doc.height, layer, image);
  }
}

function copyCamera(
  stage: Uint8Array,
  stageW: number,
  stageH: number,
  out: Uint8Array,
  frameIndex: number,
  doc: ShotComposer,
): void {
  const view = resolveComposerFrame(doc, frameIndex).camera;
  const rect = view.rect;
  const outW = doc.width;
  const outH = doc.height;
  if (
    Math.abs(view.angleDeg) < 0.001
    && Math.abs(rect.x) < 1e-6
    && Math.abs(rect.y) < 1e-6
    && Math.abs(rect.w - 1) < 1e-6
    && Math.abs(rect.h - 1) < 1e-6
  ) {
    out.set(stage);
    return;
  }
  if (Math.abs(view.angleDeg) < 0.001) {
    const xScale = (rect.w * stageW) / outW;
    const yScale = (rect.h * stageH) / outH;
    const xOrigin = rect.x * stageW;
    const yOrigin = rect.y * stageH;
    for (let y = 0; y < outH; y++) {
      const sy = Math.floor(yOrigin + (y + 0.5) * yScale);
      const outRow = y * outW;
      if (sy < 0 || sy >= stageH) {
        for (let x = 0; x < outW; x++) {
          const di = (outRow + x) * 4;
          out[di] = 0;
          out[di + 1] = 0;
          out[di + 2] = 0;
          out[di + 3] = 255;
        }
        continue;
      }
      let sxFloat = xOrigin + 0.5 * xScale;
      const srcRow = sy * stageW;
      for (let x = 0; x < outW; x++) {
        const sx = Math.floor(sxFloat);
        sxFloat += xScale;
        const di = (outRow + x) * 4;
        if (sx < 0 || sx >= stageW) {
          out[di] = 0;
          out[di + 1] = 0;
          out[di + 2] = 0;
          out[di + 3] = 255;
          continue;
        }
        const si = (srcRow + sx) * 4;
        out[di] = stage[si] ?? 0;
        out[di + 1] = stage[si + 1] ?? 0;
        out[di + 2] = stage[si + 2] ?? 0;
        out[di + 3] = stage[si + 3] ?? 255;
      }
    }
    return;
  }
  const theta = (-view.angleDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const cx = outW / 2;
  const cy = outH / 2;
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const rx = dx * cos - dy * sin;
      const ry = dx * sin + dy * cos;
      const preX = cx + rx;
      const preY = cy + ry;
      const sx = (rect.x + (preX / outW) * rect.w) * stageW;
      const sy = (rect.y + (preY / outH) * rect.h) * stageH;
      const di = (y * outW + x) * 4;
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      if (ix < 0 || iy < 0 || ix >= stageW || iy >= stageH) {
        out[di] = 0;
        out[di + 1] = 0;
        out[di + 2] = 0;
        out[di + 3] = 255;
        continue;
      }
      const si = (iy * stageW + ix) * 4;
      out[di] = stage[si] ?? 0;
      out[di + 1] = stage[si + 1] ?? 0;
      out[di + 2] = stage[si + 2] ?? 0;
      out[di + 3] = stage[si + 3] ?? 255;
    }
  }
}

export function renderComposerRgbaInto(
  doc: ShotComposer,
  frameIndex: number,
  images: ReadonlyMap<string, RgbaImage>,
  stage: Uint8Array,
  out: Uint8Array,
): void {
  const pixels = doc.width * doc.height * 4;
  if (stage.length < pixels || out.length < pixels) throw new ComposerError('invalid composer frame bytes');
  paintStage(doc, frameIndex, images, stage);
  copyCamera(stage, doc.width, doc.height, out, frameIndex, doc);
}

export function renderComposerRgba(
  doc: ShotComposer,
  frameIndex: number,
  images: ReadonlyMap<string, RgbaImage>,
): Uint8Array {
  const pixels = doc.width * doc.height * 4;
  const stage = new Uint8Array(pixels);
  const out = new Uint8Array(pixels);
  renderComposerRgbaInto(doc, frameIndex, images, stage, out);
  return out;
}
