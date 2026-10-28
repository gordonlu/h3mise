// Shot Composer — multi-layer stage preview for one Shot.
// ---------------------------------------------------------------------------
// Coordinates are normalized to the stage, origin at the top-left, +x right,
// +y down (the same orientation as CameraPlan). A layer's (x, y) is its
// anchor on that stage. The anchor inside the bitmap is (anchorX, anchorY):
// (0, 0) is the bitmap's top-left and (0.5, 0.5) is its center. The default
// anchor is the center.
//
// `scale` is the rendered bitmap height divided by the stage height. Width
// follows the bitmap's pixel aspect, so a scale of 1 covers the stage height
// without stretching the image.
//
// The camera is a CameraMotionPlan. viewAt() supplies the 2D crop. That crop
// can hold, push in, pull out, or pan. It does not create perspective or
// parallax. `limits.spatial` is always `2d-crop`.
//
// Layer sourceKind may be `video` or `image_sequence` so a later version can
// store those layers. This version only draws `image`.

import type { H3Mode } from './director.js';
import {
  describeCameraPlan,
  emptyCameraPlan,
  normalizeCameraPlan,
  viewAt,
  type CameraMotionPlan,
  type CameraViewFrame,
} from './camera.js';

export const COMPOSER_EASES = ['linear', 'smooth', 'ease-in', 'ease-out'] as const;
export type ComposerEase = (typeof COMPOSER_EASES)[number];

export const COMPOSER_SOURCE_KINDS = ['image', 'video', 'image_sequence'] as const;
export type ComposerSourceKind = (typeof COMPOSER_SOURCE_KINDS)[number];

export const COMPOSER_LAYER_ROLES = ['background', 'subject', 'foreground', 'custom'] as const;
export type ComposerLayerRole = (typeof COMPOSER_LAYER_ROLES)[number];

export const COMPOSER_CAMERA_PRESETS = ['static', 'push-in', 'pull-out', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down'] as const;
export type ComposerCameraPreset = (typeof COMPOSER_CAMERA_PRESETS)[number];

export const COMPOSER_DEFAULT_FPS = 24;
export const COMPOSER_DEFAULT_DURATION = 5;
export const COMPOSER_DEFAULT_ASPECT = '16:9';
export const COMPOSER_DEFAULT_LONG_EDGE = 1280;
export const COMPOSER_MAX_LAYERS = 24;
export const COMPOSER_MAX_KEYS = 64;

export class ComposerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComposerError';
  }
}

export interface ComposerKeyframe {
  id: string;
  /** Normalized time, 0 at the first frame and 1 at the last. */
  t: number;
  ease: ComposerEase;
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  opacity?: number;
}

export interface ComposerLayer {
  id: string;
  name: string;
  role: ComposerLayerRole;
  assetId: string | null;
  sourceKind: ComposerSourceKind;
  /** Reserved for a future image sequence. Unused by the v1 renderer. */
  sequencePath: string | null;
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
  scale: number;
  /** Clockwise degrees in screen space (y grows downward). */
  rotation: number;
  opacity: number;
  zIndex: number;
  visible: boolean;
  keyframes: ComposerKeyframe[];
}

export interface ShotComposer {
  version: 1;
  durationSeconds: number;
  fps: number;
  aspectRatio: string;
  width: number;
  height: number;
  camera: CameraMotionPlan;
  layers: ComposerLayer[];
  limits: { spatial: '2d-crop' };
}

export interface ResolvedComposerLayer {
  id: string;
  assetId: string | null;
  sourceKind: ComposerSourceKind;
  visible: boolean;
  zIndex: number;
  x: number;
  y: number;
  anchorX: number;
  anchorY: number;
  scale: number;
  rotation: number;
  opacity: number;
}

export interface ResolvedComposerFrame {
  frameIndex: number;
  frameCount: number;
  t: number;
  camera: CameraViewFrame;
  /** Back to front. */
  layers: ResolvedComposerLayer[];
}

export interface LayerDrawRect {
  anchorPx: number;
  anchorPy: number;
  destW: number;
  destH: number;
  left: number;
  top: number;
  rotationDeg: number;
}

export interface ComposerHandoff {
  spatial: '2d-crop';
  /** Modes that can consume the exported first still. Empty when the active provider has no such slot. */
  firstFrameModes: Array<'i2va' | 'fl2va'>;
  /** Modes that can consume the exported last still. Empty when the provider has no last-frame slot. */
  lastFrameModes: Array<'l2va' | 'fl2va'>;
  /** The MP4 is a local 2D rehearsal. It is not sent as a motion track. */
  motionIsPreviewOnly: true;
  submitsRender: false;
  bypassesPreflight: false;
}

type PoseChannel = 'x' | 'y' | 'scale' | 'rotation' | 'opacity';

const ASPECT = /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/;

function fail(name: string): never {
  throw new ComposerError(`invalid composer ${name}`);
}

function isEase(value: unknown): value is ComposerEase {
  return COMPOSER_EASES.includes(value as ComposerEase);
}

function isSourceKind(value: unknown): value is ComposerSourceKind {
  return COMPOSER_SOURCE_KINDS.includes(value as ComposerSourceKind);
}

function isRole(value: unknown): value is ComposerLayerRole {
  return COMPOSER_LAYER_ROLES.includes(value as ComposerLayerRole);
}

/** smoothstep and the two quadratics. Linear stays linear. */
export function composerEase(p: number, ease: ComposerEase): number {
  const t = Math.min(1, Math.max(0, p));
  switch (ease) {
    case 'linear':
      return t;
    case 'smooth':
      return t * t * (3 - 2 * t);
    case 'ease-in':
      return t * t;
    case 'ease-out':
      return 1 - (1 - t) * (1 - t);
    default: {
      const neverEase: never = ease;
      return neverEase;
    }
  }
}

export function composerFrameSize(aspectRatio: string, longEdge = COMPOSER_DEFAULT_LONG_EDGE): { width: number; height: number } {
  const [rawW, rawH] = aspectRatio.split(':').map((part) => Number(part));
  const w = rawW && rawW > 0 ? rawW : 16;
  const h = rawH && rawH > 0 ? rawH : 9;
  let width: number;
  let height: number;
  if (w >= h) {
    width = longEdge;
    height = Math.round((longEdge * h) / w);
  } else {
    height = longEdge;
    width = Math.round((longEdge * w) / h);
  }
  if (width % 2) width -= 1;
  if (height % 2) height -= 1;
  return { width: Math.max(16, width), height: Math.max(16, height) };
}

export function composerFrameCount(doc: Pick<ShotComposer, 'durationSeconds' | 'fps'>): number {
  return Math.max(2, Math.round(doc.durationSeconds * doc.fps));
}

export function composerTimeAtFrame(doc: Pick<ShotComposer, 'durationSeconds' | 'fps'>, frameIndex: number): number {
  const count = composerFrameCount(doc);
  const index = Math.min(count - 1, Math.max(0, frameIndex));
  return index / (count - 1);
}

export function composerSampleIndices(doc: Pick<ShotComposer, 'durationSeconds' | 'fps'>): { first: number; mid: number; last: number } {
  const count = composerFrameCount(doc);
  return { first: 0, mid: Math.round((count - 1) / 2), last: count - 1 };
}

function num(value: unknown, name: string, fallback: number, ok: (n: number) => boolean): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || !ok(value)) fail(name);
  return value;
}

function evenSize(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 16 || value > 1920 || value % 2 !== 0) fail(name);
  return value;
}

function sequencePath(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail('sequence path');
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('..') || trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    fail('sequence path');
  }
  return trimmed;
}

function uniqueId(raw: unknown, fallback: string, used: Set<string>): string {
  let id = typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
  if (!used.has(id)) {
    used.add(id);
    return id;
  }
  let n = 2;
  let next = `${fallback}-${n}`;
  while (used.has(next)) next = `${fallback}-${++n}`;
  used.add(next);
  return next;
}

function normalizeKeyframe(raw: unknown, index: number, used: Set<string>): ComposerKeyframe {
  if (typeof raw !== 'object' || raw === null) fail('keyframe');
  const row = raw as Record<string, unknown>;
  const ease = row.ease === undefined ? 'smooth' : row.ease;
  if (!isEase(ease)) fail('ease');
  const key: ComposerKeyframe = {
    id: uniqueId(row.id, `kf-${index + 1}`, used),
    t: num(row.t, 'keyframe time', Number.NaN, (n) => n >= 0 && n <= 1),
    ease,
  };
  if (!Number.isFinite(key.t)) fail('keyframe time');
  const optional = (channel: PoseChannel, name: string, ok: (n: number) => boolean) => {
    if (row[channel] === undefined) return;
    key[channel] = num(row[channel], name, 0, ok);
  };
  optional('x', 'x', (n) => n >= -1 && n <= 2);
  optional('y', 'y', (n) => n >= -1 && n <= 2);
  optional('scale', 'scale', (n) => n > 0 && n <= 8);
  optional('rotation', 'rotation', (n) => n >= -1080 && n <= 1080);
  optional('opacity', 'opacity', (n) => n >= 0 && n <= 1);
  return key;
}

function normalizeLayer(raw: unknown, index: number, usedLayers: Set<string>): ComposerLayer {
  if (typeof raw !== 'object' || raw === null) fail('layer');
  const row = raw as Record<string, unknown>;
  const role = row.role === undefined ? 'custom' : row.role;
  if (!isRole(role)) fail('role');
  const sourceKind = row.sourceKind === undefined ? 'image' : row.sourceKind;
  if (!isSourceKind(sourceKind)) fail('source kind');
  if (row.visible !== undefined && typeof row.visible !== 'boolean') fail('visible');
  const keyRaw = row.keyframes === undefined ? [] : row.keyframes;
  if (!Array.isArray(keyRaw) || keyRaw.length > COMPOSER_MAX_KEYS) fail('keyframes');
  const usedKeys = new Set<string>();
  const keyframes = keyRaw.map((key, keyIndex) => normalizeKeyframe(key, keyIndex, usedKeys)).sort((a, b) => a.t - b.t);
  const assetId = row.assetId === undefined || row.assetId === null || row.assetId === ''
    ? null
    : typeof row.assetId === 'string'
      ? row.assetId
      : fail('asset');
  return {
    id: uniqueId(row.id, `layer-${index + 1}`, usedLayers),
    name: typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 80) : role,
    role,
    assetId,
    sourceKind,
    sequencePath: sequencePath(row.sequencePath),
    x: num(row.x, 'x', 0.5, (n) => n >= -1 && n <= 2),
    y: num(row.y, 'y', 0.5, (n) => n >= -1 && n <= 2),
    anchorX: num(row.anchorX, 'anchor', 0.5, (n) => n >= 0 && n <= 1),
    anchorY: num(row.anchorY, 'anchor', 0.5, (n) => n >= 0 && n <= 1),
    scale: num(row.scale, 'scale', 1, (n) => n > 0 && n <= 8),
    rotation: num(row.rotation, 'rotation', 0, (n) => n >= -1080 && n <= 1080),
    opacity: num(row.opacity, 'opacity', 1, (n) => n >= 0 && n <= 1),
    zIndex: Math.round(num(row.zIndex, 'z-index', index, (n) => n >= -100 && n <= 100)),
    visible: row.visible === undefined ? true : row.visible,
    keyframes,
  };
}

export function emptyShotComposer(partial?: { durationSeconds?: number; aspectRatio?: string; width?: number; height?: number }): ShotComposer {
  const aspectRatio = partial?.aspectRatio && ASPECT.test(partial.aspectRatio) ? partial.aspectRatio : COMPOSER_DEFAULT_ASPECT;
  const durationSeconds = partial?.durationSeconds && partial.durationSeconds > 0 ? Math.min(15, partial.durationSeconds) : COMPOSER_DEFAULT_DURATION;
  const size = composerFrameSize(aspectRatio);
  return {
    version: 1,
    durationSeconds,
    fps: COMPOSER_DEFAULT_FPS,
    aspectRatio,
    width: partial?.width ?? size.width,
    height: partial?.height ?? size.height,
    camera: composerCameraPreset('static', durationSeconds, aspectRatio),
    layers: [],
    limits: { spatial: '2d-crop' },
  };
}

export function normalizeShotComposer(raw: unknown): ShotComposer {
  const base = emptyShotComposer();
  if (raw === undefined || raw === null) return base;
  if (typeof raw !== 'object') fail('document');
  const row = raw as Record<string, unknown>;
  if (row.version !== undefined && row.version !== 1) fail('version');
  const aspectRatio = row.aspectRatio === undefined
    ? base.aspectRatio
    : typeof row.aspectRatio === 'string' && ASPECT.test(row.aspectRatio)
      ? row.aspectRatio
      : fail('aspect ratio');
  const durationSeconds = num(row.durationSeconds, 'duration', base.durationSeconds, (n) => n > 0 && n <= 15);
  const fps = num(row.fps, 'fps', base.fps, (n) => Number.isInteger(n) && n >= 1 && n <= 60);
  const size = composerFrameSize(aspectRatio);
  const width = evenSize(row.width, 'width', size.width);
  const height = evenSize(row.height, 'height', size.height);
  const layerRaw = row.layers === undefined ? [] : row.layers;
  if (!Array.isArray(layerRaw) || layerRaw.length > COMPOSER_MAX_LAYERS) fail('layers');
  const usedLayers = new Set<string>();
  const layers = layerRaw.map((layer, index) => normalizeLayer(layer, index, usedLayers));
  const cameraInput = typeof row.camera === 'object' && row.camera !== null ? row.camera as Record<string, unknown> : {};
  const camera = normalizeCameraPlan({
    ...cameraInput,
    sourceAssetId: null,
    durationSeconds,
    aspectRatio,
  });
  return {
    version: 1,
    durationSeconds,
    fps,
    aspectRatio,
    width,
    height,
    camera,
    layers,
    limits: { spatial: '2d-crop' },
  };
}

/** 2D crop presets. Amounts stay inside CameraPlan's safe view. */
export function composerCameraPreset(preset: ComposerCameraPreset, durationSeconds: number, aspectRatio: string): CameraMotionPlan {
  const camera = emptyCameraPlan();
  camera.durationSeconds = durationSeconds;
  camera.aspectRatio = aspectRatio;
  camera.sourceAssetId = null;
  camera.frameMode = true;
  camera.steps = [];
  const full = { x: 0, y: 0, w: 1, h: 1 };
  const tight = { x: 0.11, y: 0.11, w: 0.78, h: 0.78 };
  const left = { x: 0, y: 0.12, w: 0.76, h: 0.76 };
  const right = { x: 0.24, y: 0.12, w: 0.76, h: 0.76 };
  const up = { x: 0.12, y: 0, w: 0.76, h: 0.76 };
  const down = { x: 0.12, y: 0.24, w: 0.76, h: 0.76 };
  switch (preset) {
    case 'static':
      camera.startFraming = full;
      camera.endFraming = full;
      break;
    case 'push-in':
      camera.startFraming = full;
      camera.endFraming = tight;
      break;
    case 'pull-out':
      camera.startFraming = tight;
      camera.endFraming = full;
      break;
    case 'pan-left':
      camera.startFraming = right;
      camera.endFraming = left;
      break;
    case 'pan-right':
      camera.startFraming = left;
      camera.endFraming = right;
      break;
    case 'tilt-up':
      camera.startFraming = down;
      camera.endFraming = up;
      break;
    case 'tilt-down':
      camera.startFraming = up;
      camera.endFraming = down;
      break;
    default: {
      const neverPreset: never = preset;
      return neverPreset;
    }
  }
  return camera;
}

function channelSamples(layer: ComposerLayer, channel: PoseChannel): Array<{ t: number; value: number; ease: ComposerEase }> {
  const out: Array<{ t: number; value: number; ease: ComposerEase }> = [];
  for (const key of layer.keyframes) {
    const value = key[channel];
    if (value === undefined) continue;
    out.push({ t: key.t, value, ease: key.ease });
  }
  return out;
}

/**
 * Interpolate one channel. With no keys, the layer base value holds.
 * Otherwise the base value is an implicit key at t=0 when the first real key
 * is later than 0, so adding one end key does not erase the start pose.
 */
export function composerChannelAt(layer: ComposerLayer, channel: PoseChannel, t: number): number {
  const keys = channelSamples(layer, channel);
  const base = layer[channel];
  if (!keys.length) return base;
  const time = Math.min(1, Math.max(0, t));
  const series = keys[0]!.t > 0 ? [{ t: 0, value: base, ease: 'linear' as const }, ...keys] : keys;
  const first = series[0]!;
  if (time <= first.t) return first.value;
  const last = series[series.length - 1]!;
  if (time >= last.t) return last.value;
  for (let i = 1; i < series.length; i++) {
    const right = series[i]!;
    if (time > right.t) continue;
    const left = series[i - 1]!;
    const span = right.t - left.t;
    const p = span <= 1e-9 ? 1 : (time - left.t) / span;
    return left.value + (right.value - left.value) * composerEase(p, right.ease);
  }
  return last.value;
}

export function orderedComposerLayers(layers: readonly ComposerLayer[]): ComposerLayer[] {
  return layers
    .map((layer, index) => ({ layer, index }))
    .sort((a, b) => a.layer.zIndex - b.layer.zIndex || a.index - b.index)
    .map((item) => item.layer);
}

export function resolveComposerFrame(doc: ShotComposer, frameIndex: number): ResolvedComposerFrame {
  if (!Number.isInteger(frameIndex)) fail('frame');
  const frameCount = composerFrameCount(doc);
  if (frameIndex < 0 || frameIndex >= frameCount) fail('frame');
  const t = composerTimeAtFrame(doc, frameIndex);
  const layers = orderedComposerLayers(doc.layers).map((layer): ResolvedComposerLayer => ({
    id: layer.id,
    assetId: layer.assetId,
    sourceKind: layer.sourceKind,
    visible: layer.visible,
    zIndex: layer.zIndex,
    x: composerChannelAt(layer, 'x', t),
    y: composerChannelAt(layer, 'y', t),
    anchorX: layer.anchorX,
    anchorY: layer.anchorY,
    scale: composerChannelAt(layer, 'scale', t),
    rotation: composerChannelAt(layer, 'rotation', t),
    opacity: composerChannelAt(layer, 'opacity', t),
  }));
  return {
    frameIndex,
    frameCount,
    t,
    camera: viewAt(doc.camera, t),
    layers,
  };
}

/** Pixel placement shared by the p5 preview and the exporter. */
export function layerDrawRect(
  layer: Pick<ResolvedComposerLayer, 'x' | 'y' | 'anchorX' | 'anchorY' | 'scale' | 'rotation'>,
  stageW: number,
  stageH: number,
  imageW: number,
  imageH: number,
): LayerDrawRect {
  const destH = layer.scale * stageH;
  const aspect = imageW / Math.max(1, imageH);
  const destW = destH * aspect;
  const anchorPx = layer.x * stageW;
  const anchorPy = layer.y * stageH;
  return {
    anchorPx,
    anchorPy,
    destW,
    destH,
    left: anchorPx - layer.anchorX * destW,
    top: anchorPy - layer.anchorY * destH,
    rotationDeg: layer.rotation,
  };
}

export function assertComposerImagesRenderable(doc: ShotComposer): void {
  for (const layer of doc.layers) {
    if (!layer.visible) continue;
    if (layer.sourceKind !== 'image') {
      throw new ComposerError(`unsupported composer source kind: ${layer.sourceKind}`);
    }
    if (!layer.assetId) fail('layer: missing asset');
  }
}

const FIRST_FRAME_MODES = ['i2va', 'fl2va'] as const;
const LAST_FRAME_MODES = ['l2va', 'fl2va'] as const;

/** Which already-supported still modes can receive an exported frame. */
function placementPhrase(label: string, layer: ResolvedComposerLayer, end: ResolvedComposerLayer | undefined): string {
  const here = `(${layer.x.toFixed(2)}, ${layer.y.toFixed(2)}), scale ${layer.scale.toFixed(2)}, z ${layer.zIndex}`;
  const moved = end !== undefined && (
    Math.abs(layer.x - end.x) > 0.01
    || Math.abs(layer.y - end.y) > 0.01
    || Math.abs(layer.scale - end.scale) > 0.01
  );
  const span = moved && end
    ? `from ${here} to (${end.x.toFixed(2)}, ${end.y.toFixed(2)}), scale ${end.scale.toFixed(2)}`
    : `at ${here}`;
  return `${label} ${span}`;
}

/** One deterministic sentence for the prompt compiler and Agent context. */
export function describeShotComposer(doc: ShotComposer): string {
  const start = resolveComposerFrame(doc, 0);
  const end = resolveComposerFrame(doc, composerFrameCount(doc) - 1);
  const visible = start.layers.filter((layer) => layer.visible);
  if (!visible.length) return '';
  const endById = new Map(end.layers.map((layer) => [layer.id, layer]));
  const names = new Map(doc.layers.map((layer) => [layer.id, layer.role === 'custom' ? layer.name : `${layer.role} ${layer.name}`]));
  const placement = visible.map((layer) => placementPhrase(names.get(layer.id) ?? layer.id, layer, endById.get(layer.id))).join('; ');
  const camera = describeCameraPlan(doc.camera, doc.durationSeconds);
  return `Stage placement: ${placement}. Camera: ${camera}. 2D crop rehearsal only. Exported stills can be bound as first or last frames when the provider already supports that mode. The preview MP4 does not make a video model follow the p5 camera path.`;
}

export function composerHandoffForModes(modes: readonly string[]): ComposerHandoff {
  const available = new Set(modes);
  return {
    spatial: '2d-crop',
    firstFrameModes: FIRST_FRAME_MODES.filter((mode): mode is 'i2va' | 'fl2va' => available.has(mode)),
    lastFrameModes: LAST_FRAME_MODES.filter((mode): mode is 'l2va' | 'fl2va' => available.has(mode)),
    motionIsPreviewOnly: true,
    submitsRender: false,
    bypassesPreflight: false,
  };
}

export function composerCanBindFrame(handoff: ComposerHandoff, role: 'first_frame' | 'last_frame'): boolean {
  return role === 'first_frame' ? handoff.firstFrameModes.length > 0 : handoff.lastFrameModes.length > 0;
}

export function isComposerCameraPreset(value: string): value is ComposerCameraPreset {
  return COMPOSER_CAMERA_PRESETS.includes(value as ComposerCameraPreset);
}

/** Kept so a caller can pass provider mode lists without inventing modes. */
export type ComposerProviderMode = H3Mode;
