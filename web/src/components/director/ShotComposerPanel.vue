<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { MediaAsset, Shot, ShotComposer } from '@h3mise/shared';
import type p5 from 'p5';
import {
  composerCameraPreset,
  composerFrameCount,
  composerHandoffForModes,
  composerTimeAtFrame,
  emptyShotComposer,
  layerDrawRect,
  normalizeShotComposer,
  resolveComposerFrame,
  type ComposerCameraPreset,
  type ComposerKeyframe,
  type ComposerLayer,
  type ComposerLayerRole,
} from '@h3mise/shared';
import { get, mediaUrl, post, put } from '../../api/client';
import { t as tr } from '../../stores/locale';
import { useToastStore } from '../../stores/toast';

const props = defineProps<{
  shot: Shot;
  media: MediaAsset[];
  modes: string[];
}>();
const emit = defineEmits<{ assetsAdded: [] }>();
const toasts = useToastStore();

type P5Instance = InstanceType<typeof import('p5')>;
type P5Constructor = new (sketch: (sk: P5Instance) => void, node?: HTMLElement) => P5Instance;

interface ComposerExportResult {
  firstBindingId: string | null;
  lastBindingId: string | null;
  videoAssetId?: string | null;
}

const doc = ref<ShotComposer>(emptyShotComposer({
  durationSeconds: props.shot.durationSeconds,
  aspectRatio: props.shot.aspectRatio,
}));
const loaded = ref(false);
const frameIndex = ref(0);
const playing = ref(false);
const selectedId = ref<string | null>(null);
const addAssetId = ref('');
const addRole = ref<ComposerLayerRole>('subject');
const busy = ref<'stills' | 'preview' | 'exact' | 'demo' | null>(null);
const bindFrames = ref(false);
const exactUrl = ref<string | null>(null);
const previewAssetId = ref<string | null>(null);
const host = ref<HTMLDivElement | null>(null);
const stageReady = ref(false);
const stageError = ref<string | null>(null);
const images = new Map<string, p5.Image>();
let sketch: P5Instance | null = null;
let gfx: p5.Graphics | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let playTimer = 0;
let keySeq = 1;
let stageToken = 0;

const imagesOnly = computed(() => props.media.filter((asset) => asset.kind === 'image'));
const selected = computed(() => doc.value.layers.find((layer) => layer.id === selectedId.value) ?? null);
const resolved = computed(() => {
  const frame = resolveComposerFrame(doc.value, Math.min(frameIndex.value, Math.max(0, frameCount.value - 1)));
  return frame.layers.find((layer) => layer.id === selectedId.value) ?? null;
});
const frameCount = computed(() => composerFrameCount(doc.value));
const seconds = computed(() => composerTimeAtFrame(doc.value, frameIndex.value) * doc.value.durationSeconds);
const handoff = computed(() => composerHandoffForModes(props.modes));
const bindSupported = computed(() => handoff.value.firstFrameModes.length > 0 || handoff.value.lastFrameModes.length > 0);
const presets: ComposerCameraPreset[] = ['static', 'push-in', 'pull-out', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down'];
const presetLabel: Record<ComposerCameraPreset, string> = {
  static: 'shot.composer.preset.static',
  'push-in': 'shot.composer.preset.push',
  'pull-out': 'shot.composer.preset.pull',
  'pan-left': 'shot.composer.preset.left',
  'pan-right': 'shot.composer.preset.right',
  'tilt-up': 'shot.composer.preset.up',
  'tilt-down': 'shot.composer.preset.down',
};

const activePreset = computed<ComposerCameraPreset | null>(() => {
  const camera = doc.value.camera;
  return presets.find((preset) => {
    const candidate = composerCameraPreset(preset, doc.value.durationSeconds, doc.value.aspectRatio);
    return sameRect(candidate.startFraming, camera.startFraming)
      && sameRect(candidate.endFraming, camera.endFraming)
      && candidate.steps.length === camera.steps.length;
  }) ?? null;
});

watch(bindSupported, (supported) => {
  if (!supported) bindFrames.value = false;
}, { immediate: true });

function sameRect(
  a: { x: number; y: number; w: number; h: number } | null,
  b: { x: number; y: number; w: number; h: number } | null,
): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < 1e-6
    && Math.abs(a.y - b.y) < 1e-6
    && Math.abs(a.w - b.w) < 1e-6
    && Math.abs(a.h - b.h) < 1e-6;
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function toastError(reason: unknown): void {
  toasts.push({ kind: 'err', text: describe(reason) });
}

function roleLabel(role: ComposerLayerRole): string {
  return tr(`shot.composer.role.${role}`);
}

function modeList(modes: readonly string[]): string {
  return modes.map((mode) => tr(`shot.mode.${mode}`)).join(', ');
}

async function load(): Promise<void> {
  try {
    const saved = await get<ShotComposer | null>(`/api/shots/${props.shot.id}/composer`);
    doc.value = saved
      ? normalizeShotComposer(saved)
      : emptyShotComposer({ durationSeconds: props.shot.durationSeconds, aspectRatio: props.shot.aspectRatio });
    selectedId.value = doc.value.layers[0]?.id ?? null;
    frameIndex.value = Math.min(frameIndex.value, Math.max(0, frameCount.value - 1));
  } catch (error) {
    toastError(error);
  }
  loaded.value = true;
  if (sketch) await ensureImages(sketch);
  else paint();
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void persist(), 700);
}

async function persist(): Promise<void> {
  doc.value = normalizeShotComposer(doc.value);
  await put(`/api/shots/${props.shot.id}/composer`, doc.value);
}

async function saveNow(): Promise<void> {
  try {
    if (saveTimer) clearTimeout(saveTimer);
    await persist();
    toasts.push({ kind: 'ok', text: tr('shot.composer.saved') });
  } catch (error) {
    toastError(error);
  }
}

function paintFrame(): void {
  const sk = sketch;
  if (!sk || !gfx || !loaded.value || !stageReady.value) return;
  const width = doc.value.width;
  const height = doc.value.height;
  if (sk.width !== width || sk.height !== height) {
    sk.resizeCanvas(width, height);
    gfx?.remove();
    const next = sk.createGraphics(width, height);
    next.pixelDensity(1);
    (next.drawingContext as CanvasRenderingContext2D).imageSmoothingEnabled = false;
    gfx = next;
  }
  const buffer = gfx;
  if (!buffer) return;
  const frame = resolveComposerFrame(doc.value, Math.min(frameIndex.value, frameCount.value - 1));
  buffer.clear();
  buffer.background(0);
  for (const layer of frame.layers) {
    if (!layer.visible || layer.opacity <= 0 || !layer.assetId) continue;
    const img = images.get(layer.assetId);
    if (!img || img.width <= 0) continue;
    const draw = layerDrawRect(layer, width, height, img.width, img.height);
    buffer.push();
    buffer.translate(draw.anchorPx, draw.anchorPy);
    buffer.rotate(buffer.radians(draw.rotationDeg));
    buffer.tint(255, Math.round(layer.opacity * 255));
    buffer.image(img, -layer.anchorX * draw.destW, -layer.anchorY * draw.destH, draw.destW, draw.destH);
    buffer.pop();
    buffer.noTint();
    if (layer.id === selectedId.value) {
      buffer.noFill();
      buffer.stroke(232, 116, 42);
      buffer.strokeWeight(2);
      buffer.push();
      buffer.translate(draw.anchorPx, draw.anchorPy);
      buffer.rotate(buffer.radians(draw.rotationDeg));
      buffer.rect(-layer.anchorX * draw.destW, -layer.anchorY * draw.destH, draw.destW, draw.destH);
      buffer.pop();
    }
  }
  const view = frame.camera.rect;
  sk.background(0);
  sk.push();
  sk.translate(width / 2, height / 2);
  sk.rotate(sk.radians(frame.camera.angleDeg));
  sk.image(buffer, -width / 2, -height / 2, width, height, view.x * width, view.y * height, view.w * width, view.h * height);
  sk.pop();
}

function paint(): void {
  try {
    paintFrame();
  } catch (error) {
    stageError.value = describe(error);
  }
}

async function ensureImages(sk: P5Instance): Promise<void> {
  const ids = [...new Set(doc.value.layers.map((layer) => layer.assetId).filter((id): id is string => Boolean(id)))];
  await Promise.all(ids.filter((id) => !images.has(id)).map((id) => new Promise<void>((resolve) => {
    sk.loadImage(mediaUrl(id), (img: p5.Image) => {
      images.set(id, img);
      resolve();
    }, () => resolve());
  })));
  paint();
}

async function mountSketch(): Promise<void> {
  const node = host.value;
  if (!node) return;
  const token = ++stageToken;
  stageError.value = null;
  stageReady.value = false;
  try {
    const module = await import('p5');
    if (token !== stageToken || !host.value) return;
    const loadedModule = module as unknown as { default?: P5Constructor };
    const P5 = loadedModule.default ?? (module as unknown as P5Constructor);
    sketch = new P5((sk) => {
      sk.setup = () => {
        try {
          const canvas = sk.createCanvas(doc.value.width, doc.value.height);
          canvas.parent(node);
          sk.pixelDensity(1);
          sk.noLoop();
          (sk.drawingContext as CanvasRenderingContext2D).imageSmoothingEnabled = false;
          const buffer = sk.createGraphics(doc.value.width, doc.value.height);
          buffer.pixelDensity(1);
          (buffer.drawingContext as CanvasRenderingContext2D).imageSmoothingEnabled = false;
          gfx = buffer;
          stageReady.value = true;
          paint();
          void ensureImages(sk);
        } catch (error) {
          stageError.value = describe(error);
        }
      };
    }, node);
  } catch (error) {
    if (token === stageToken) stageError.value = describe(error);
  }
}

async function retryStage(): Promise<void> {
  stageToken += 1;
  images.clear();
  gfx?.remove();
  gfx = null;
  sketch?.remove();
  sketch = null;
  stageError.value = null;
  stageReady.value = false;
  await nextTick();
  await mountSketch();
}

function onTimeInput(value: number): void {
  const max = Math.max(0, frameCount.value - 1);
  frameIndex.value = Math.min(max, Math.max(0, Math.round(value)));
  paint();
}

function togglePlay(): void {
  if (!playing.value && !stageReady.value) return;
  playing.value = !playing.value;
  if (!playing.value) {
    cancelAnimationFrame(playTimer);
    return;
  }
  let last = 0;
  const tick = (now: number) => {
    if (!playing.value) return;
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    const advance = dt * doc.value.fps;
    frameIndex.value = Math.round(frameIndex.value + advance) % frameCount.value;
    paint();
    playTimer = requestAnimationFrame(tick);
  };
  playTimer = requestAnimationFrame(tick);
}

function liveTarget(layer: ComposerLayer): ComposerLayer | ComposerKeyframe {
  if (!layer.keyframes.length) return layer;
  const t = composerTimeAtFrame(doc.value, frameIndex.value);
  const near = layer.keyframes.find((key) => Math.abs(key.t - t) <= 1e-4);
  if (near) return near;
  const frame = resolveComposerFrame(doc.value, frameIndex.value);
  const resolved = frame.layers.find((item) => item.id === layer.id);
  const key: ComposerKeyframe = {
    id: `kf-${keySeq++}`,
    t,
    ease: 'smooth',
    x: resolved?.x ?? layer.x,
    y: resolved?.y ?? layer.y,
    scale: resolved?.scale ?? layer.scale,
    rotation: resolved?.rotation ?? layer.rotation,
    opacity: resolved?.opacity ?? layer.opacity,
  };
  layer.keyframes.push(key);
  layer.keyframes.sort((a, b) => a.t - b.t);
  return key;
}

function patchSelected(patch: Partial<Pick<ComposerLayer, 'x' | 'y' | 'scale' | 'rotation' | 'opacity' | 'zIndex' | 'visible'>>): void {
  const layer = selected.value;
  if (!layer) return;
  const pose = { ...patch };
  delete pose.zIndex;
  delete pose.visible;
  if (patch.zIndex !== undefined) layer.zIndex = patch.zIndex;
  if (patch.visible !== undefined) layer.visible = patch.visible;
  if (pose.x !== undefined || pose.y !== undefined || pose.scale !== undefined || pose.rotation !== undefined || pose.opacity !== undefined) {
    Object.assign(liveTarget(layer), pose);
  }
  paint();
  scheduleSave();
}

function addKeyframe(): void {
  const layer = selected.value;
  if (!layer) return;
  const t = composerTimeAtFrame(doc.value, frameIndex.value);
  if (!layer.keyframes.length && t > 0) {
    layer.keyframes.push({
      id: `kf-${keySeq++}`,
      t: 0,
      ease: 'smooth',
      x: layer.x,
      y: layer.y,
      scale: layer.scale,
      rotation: layer.rotation,
      opacity: layer.opacity,
    });
  }
  liveTarget(layer);
  paint();
  scheduleSave();
}

function removeKeyframe(id: string): void {
  const layer = selected.value;
  if (!layer) return;
  layer.keyframes = layer.keyframes.filter((key) => key.id !== id);
  scheduleSave();
  paint();
}

function setEase(key: ComposerKeyframe, ease: string): void {
  if (ease === 'linear' || ease === 'smooth' || ease === 'ease-in' || ease === 'ease-out') key.ease = ease;
  scheduleSave();
  paint();
}

function addLayer(): void {
  if (!addAssetId.value) return;
  const role = addRole.value;
  const asset = imagesOnly.value.find((item) => item.id === addAssetId.value);
  let n = doc.value.layers.length + 1;
  let id = `layer-${n}`;
  const used = new Set(doc.value.layers.map((layer) => layer.id));
  while (used.has(id)) id = `layer-${++n}`;
  doc.value.layers.push({
    id,
    name: (asset?.label || roleLabel(role)).slice(0, 80),
    role,
    assetId: addAssetId.value,
    sourceKind: 'image',
    sequencePath: null,
    x: role === 'foreground' ? 0.39 : 0.5,
    y: role === 'subject' ? 0.62 : 0.5,
    anchorX: 0.5,
    anchorY: 0.5,
    scale: role === 'subject' ? 0.72 : 1,
    rotation: 0,
    opacity: 1,
    zIndex: role === 'background' ? 0 : role === 'subject' ? 10 : 20,
    visible: true,
    keyframes: [],
  });
  selectedId.value = id;
  scheduleSave();
  if (sketch) void ensureImages(sketch);
}

function removeLayer(id: string): void {
  doc.value.layers = doc.value.layers.filter((layer) => layer.id !== id);
  if (selectedId.value === id) selectedId.value = doc.value.layers[0]?.id ?? null;
  scheduleSave();
  paint();
}

function setDuration(event: Event): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value) || value <= 0 || value > 15) return;
  doc.value.durationSeconds = value;
  doc.value.camera = { ...doc.value.camera, durationSeconds: value };
  frameIndex.value = Math.min(frameIndex.value, Math.max(0, frameCount.value - 1));
  scheduleSave();
  paint();
}

function applyPreset(preset: ComposerCameraPreset): void {
  doc.value.camera = composerCameraPreset(preset, doc.value.durationSeconds, doc.value.aspectRatio);
  scheduleSave();
  paint();
}

function stagePoint(event: PointerEvent): { x: number; y: number } | null {
  const canvas = host.value?.querySelector('canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const nx = (event.clientX - rect.left) / rect.width;
  const ny = (event.clientY - rect.top) / rect.height;
  const frame = resolveComposerFrame(doc.value, frameIndex.value);
  const view = frame.camera.rect;
  let px = nx;
  let py = ny;
  if (Math.abs(frame.camera.angleDeg) > 0.01) {
    const dx = nx - 0.5;
    const dy = ny - 0.5;
    const rad = (-frame.camera.angleDeg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    px = 0.5 + dx * cos - dy * sin;
    py = 0.5 + dx * sin + dy * cos;
  }
  return { x: view.x + px * view.w, y: view.y + py * view.h };
}

function onDrag(event: PointerEvent): void {
  if (!selected.value || event.buttons !== 1) return;
  const point = stagePoint(event);
  if (!point) return;
  patchSelected({ x: Math.min(2, Math.max(-1, point.x)), y: Math.min(2, Math.max(-1, point.y)) });
}

async function loadDemo(): Promise<void> {
  busy.value = 'demo';
  try {
    const installed = await post<{ composer: ShotComposer }>(`/api/shots/${props.shot.id}/composer/demo`, {});
    doc.value = normalizeShotComposer(installed.composer);
    selectedId.value = doc.value.layers.find((layer) => layer.role === 'subject')?.id ?? doc.value.layers[0]?.id ?? null;
    frameIndex.value = 0;
    emit('assetsAdded');
    if (sketch) await ensureImages(sketch);
    toasts.push({ kind: 'ok', text: tr('shot.composer.demoDone') });
  } catch (error) {
    toastError(error);
  } finally {
    busy.value = null;
  }
}

function reportExport(result: ComposerExportResult | null): void {
  const bound = Boolean(result?.firstBindingId || result?.lastBindingId);
  if (bindFrames.value && !bound) {
    toasts.push({ kind: 'info', text: tr('shot.composer.bindSkipped'), timeout: 8000 });
    return;
  }
  toasts.push({ kind: 'ok', text: bound ? tr('shot.composer.exportBound') : tr('shot.composer.exportDone') });
}

async function exportStills(): Promise<void> {
  busy.value = 'stills';
  try {
    await persist();
    const result = await post<ComposerExportResult>(`/api/shots/${props.shot.id}/composer/frames`, { bind: bindFrames.value });
    emit('assetsAdded');
    reportExport(result);
  } catch (error) {
    toastError(error);
  } finally {
    busy.value = null;
  }
}

async function exportPreview(): Promise<void> {
  busy.value = 'preview';
  try {
    await persist();
    const queued = await post<{ jobId: string }>(`/api/shots/${props.shot.id}/composer/preview`, { bind: bindFrames.value });
    for (let i = 0; i < 240; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const job = await get<{ status: string; result: ComposerExportResult | null; error: string | null }>(`/api/jobs/${queued.jobId}`);
      if (job.status === 'done') {
        previewAssetId.value = job.result?.videoAssetId ?? null;
        emit('assetsAdded');
        reportExport(job.result);
        return;
      }
      if (job.status === 'failed') throw new Error(job.error ?? 'preview failed');
    }
  } catch (error) {
    toastError(error);
  } finally {
    busy.value = null;
  }
}

async function showExact(): Promise<void> {
  busy.value = 'exact';
  try {
    await get('/api/session');
    const res = await fetch(`/api/shots/${props.shot.id}/composer/frame`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ frameIndex: frameIndex.value, composer: doc.value }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    if (exactUrl.value) URL.revokeObjectURL(exactUrl.value);
    exactUrl.value = URL.createObjectURL(blob);
  } catch (error) {
    toastError(error);
  } finally {
    busy.value = null;
  }
}

function setNumber(event: Event, key: 'x' | 'y' | 'scale' | 'rotation' | 'opacity' | 'zIndex'): void {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  patchSelected({ [key]: value });
}

watch(() => props.shot.id, () => {
  images.clear();
  void load().then(() => {
    if (sketch) void ensureImages(sketch);
  });
});
watch(() => props.media.map((asset) => asset.id).join(','), () => {
  if (sketch) void ensureImages(sketch);
});
watch(doc, () => paint(), { deep: true });

onMounted(() => {
  void mountSketch();
  void load();
});
onUnmounted(() => {
  stageToken += 1;
  playing.value = false;
  cancelAnimationFrame(playTimer);
  if (saveTimer) {
    clearTimeout(saveTimer);
    void persist().catch(() => {});
  }
  if (exactUrl.value) URL.revokeObjectURL(exactUrl.value);
  gfx?.remove();
  sketch?.remove();
  gfx = null;
  sketch = null;
});
</script>

<template>
  <div class="composer">
    <p class="lead">{{ tr('shot.composer.lead') }}</p>

    <div v-if="stageError" class="stage-error">
      <strong>{{ tr('shot.composer.stageFailed') }}</strong>
      <p class="muted">{{ tr('shot.composer.stageFailedHint') }}</p>
      <p class="muted mono">{{ stageError }}</p>
      <button class="sm" type="button" @click="retryStage">{{ tr('shot.composer.retryStage') }}</button>
    </div>
    <template v-else>
      <div class="stage-wrap">
        <div ref="host" class="stage" :style="{ aspectRatio: `${doc.width} / ${doc.height}` }" />
        <span v-if="!stageReady" class="stage-loading muted">{{ tr('common.loading') }}</span>
        <div class="drag-layer" @pointerdown="onDrag" @pointermove="onDrag" />
      </div>
      <div class="time-row">
        <button class="sm" type="button" :disabled="!stageReady" @click="togglePlay">{{ playing ? '⏸' : '▶' }}</button>
        <input
          type="range"
          min="0"
          :max="Math.max(0, frameCount - 1)"
          step="1"
          :value="frameIndex"
          @input="onTimeInput(Number(($event.target as HTMLInputElement).value))"
        />
        <span class="mono">{{ seconds.toFixed(2) }}s · {{ frameIndex + 1 }}/{{ frameCount }}</span>
      </div>
      <div class="presets">
        <span class="row-title">{{ tr('shot.composer.camera') }}</span>
        <button
          v-for="preset in presets"
          :key="preset"
          class="sm"
          :class="{ primary: activePreset === preset }"
          type="button"
          @click="applyPreset(preset)"
        >
          {{ tr(presetLabel[preset]) }}
        </button>
      </div>
      <p class="muted cam">{{ activePreset ? tr('shot.composer.currentPreset', { preset: tr(presetLabel[activePreset]) }) : tr('shot.composer.customCamera') }}</p>
      <label class="field duration">{{ tr('shot.composer.duration') }}
        <input type="number" min="1" max="15" step="0.5" :value="doc.durationSeconds" @change="setDuration" />
      </label>
      <div v-if="exactUrl" class="exact">
        <img :src="exactUrl" alt="" />
        <span class="muted">{{ tr('shot.composer.exactCaption') }}</span>
      </div>
    </template>

    <div class="split">
      <div>
        <div class="row-title">{{ tr('shot.composer.layers') }}</div>
        <p v-if="!doc.layers.length" class="muted">{{ tr('shot.composer.empty') }}</p>
        <button
          v-for="layer in doc.layers"
          :key="layer.id"
          type="button"
          class="sm layer"
          :class="{ primary: layer.id === selectedId }"
          @click="selectedId = layer.id"
        >
          {{ layer.name }} · {{ roleLabel(layer.role) }} · z{{ layer.zIndex }}
        </button>
        <div class="add">
          <div class="row-title">{{ tr('shot.composer.addTitle') }}</div>
          <select v-model="addAssetId">
            <option value="">{{ tr('shot.composer.pick') }}</option>
            <option v-for="asset in imagesOnly" :key="asset.id" :value="asset.id">{{ asset.label || asset.id }}</option>
          </select>
          <select v-model="addRole">
            <option value="background">{{ roleLabel('background') }}</option>
            <option value="subject">{{ roleLabel('subject') }}</option>
            <option value="foreground">{{ roleLabel('foreground') }}</option>
            <option value="custom">{{ roleLabel('custom') }}</option>
          </select>
          <button class="sm" type="button" :disabled="!addAssetId || busy !== null" @click="addLayer">{{ tr('shot.composer.add') }}</button>
        </div>
      </div>

      <div v-if="selected" class="fields">
        <div class="numeric-grid">
          <label class="field">{{ tr('shot.composer.field.x') }}
            <input type="number" min="-1" max="2" step="0.01" :value="resolved?.x ?? selected.x" @input="setNumber($event, 'x')" />
          </label>
          <label class="field">{{ tr('shot.composer.field.y') }}
            <input type="number" min="-1" max="2" step="0.01" :value="resolved?.y ?? selected.y" @input="setNumber($event, 'y')" />
          </label>
          <label class="field">{{ tr('shot.composer.field.scale') }}
            <input type="number" min="0.05" max="8" step="0.01" :value="resolved?.scale ?? selected.scale" @input="setNumber($event, 'scale')" />
          </label>
          <label class="field">{{ tr('shot.composer.field.rotation') }}
            <input type="number" min="-180" max="180" step="1" :value="resolved?.rotation ?? selected.rotation" @input="setNumber($event, 'rotation')" />
          </label>
          <label class="field">{{ tr('shot.composer.field.opacity') }}
            <input type="number" min="0" max="1" step="0.05" :value="resolved?.opacity ?? selected.opacity" @input="setNumber($event, 'opacity')" />
          </label>
          <label class="field">{{ tr('shot.composer.field.z') }}
            <input type="number" min="-100" max="100" step="1" :value="selected.zIndex" @input="setNumber($event, 'zIndex')" />
          </label>
        </div>
        <div class="field-actions">
          <label class="check"><input type="checkbox" :checked="selected.visible" @change="patchSelected({ visible: ($event.target as HTMLInputElement).checked })" /> {{ tr('shot.composer.field.visible') }}</label>
          <button class="sm danger" type="button" @click="removeLayer(selected.id)">{{ tr('shot.composer.remove') }}</button>
        </div>
        <div class="keyframes">
          <div class="row-title">{{ tr('shot.composer.keyframeTitle') }}</div>
          <p class="muted">{{ tr('shot.composer.keyframeHint') }}</p>
          <button class="sm" type="button" @click="addKeyframe">{{ tr('shot.composer.keyframe') }}</button>
          <div v-for="key in selected.keyframes" :key="key.id" class="key">
            <span class="mono">t {{ key.t.toFixed(2) }}</span>
            <select :value="key.ease" @change="setEase(key, ($event.target as HTMLSelectElement).value)">
              <option value="linear">linear</option>
              <option value="smooth">smooth</option>
              <option value="ease-in">ease-in</option>
              <option value="ease-out">ease-out</option>
            </select>
            <button class="sm ghost" type="button" @click="removeKeyframe(key.id)">×</button>
          </div>
        </div>
      </div>
    </div>

    <div class="actions">
      <button class="sm" type="button" :disabled="busy !== null" @click="saveNow">{{ tr('shot.composer.save') }}</button>
      <button class="sm" type="button" :disabled="busy !== null" @click="loadDemo">{{ tr('shot.composer.demo') }}</button>
      <button class="sm" type="button" :disabled="busy !== null" @click="showExact">{{ tr('shot.composer.exact') }}</button>
      <button class="sm" type="button" :disabled="busy !== null" @click="exportStills">
        {{ busy === 'stills' ? tr('shot.composer.exporting') : tr('shot.composer.exportStills') }}
      </button>
      <button class="sm primary" type="button" :disabled="busy !== null" @click="exportPreview">
        {{ busy === 'preview' ? tr('shot.composer.exporting') : tr('shot.composer.exportPreview') }}
      </button>
    </div>

    <details class="advanced">
      <summary>{{ tr('shot.composer.advanced') }}</summary>
      <p class="muted">{{ tr('shot.composer.coords') }}</p>
      <p class="muted">{{ tr('shot.composer.limit') }}</p>
      <p class="muted">{{ tr('shot.composer.handoffMotion') }}</p>
      <template v-if="bindSupported">
        <label class="check">
          <input v-model="bindFrames" type="checkbox" />
          {{ tr('shot.composer.bind') }}
        </label>
        <p class="muted">{{ tr('shot.composer.bindHint') }}</p>
        <p class="muted">
          {{ tr('shot.composer.handoffFirst', { modes: modeList(handoff.firstFrameModes) || tr('shot.composer.handoffNone') }) }}
          {{ tr('shot.composer.handoffLast', { modes: modeList(handoff.lastFrameModes) || tr('shot.composer.handoffNone') }) }}
        </p>
      </template>
      <p v-else class="muted">{{ tr('shot.composer.bindUnsupported') }}</p>
    </details>

    <video v-if="previewAssetId" class="preview" controls :src="mediaUrl(previewAssetId)" />
  </div>
</template>

<style scoped>
.composer { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.lead { margin: 0; }
.stage-wrap { position: relative; max-width: 720px; background: #111; border-radius: 8px; overflow: hidden; }
.stage { width: 100%; }
.stage :deep(canvas) { width: 100% !important; height: auto !important; display: block; }
.stage-loading { position: absolute; inset: 0; display: grid; place-items: center; background: #111; }
.stage-error { display: grid; gap: 6px; padding: 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-2); }
.stage-error strong { color: var(--bad); }
.stage-error p { margin: 0; }
.drag-layer { position: absolute; inset: 0; cursor: grab; }
.time-row, .actions, .presets, .add, .key { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.time-row input[type='range'] { flex: 1; }
.split { display: grid; grid-template-columns: minmax(180px, 240px) 1fr; gap: 16px; }
.layer { width: 100%; text-align: left; margin-bottom: 6px; }
.fields { display: flex; flex-direction: column; gap: 10px; }
.numeric-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.field-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.keyframes { display: grid; gap: 6px; }
.row-title { font-size: 12px; font-weight: 700; }
.add { margin-top: 10px; }
.add select { max-width: 100%; }
.duration { max-width: 160px; }
.check { display: flex; gap: 6px; align-items: center; font-size: 12px; }
.exact img, .preview { width: min(100%, 720px); border-radius: 8px; background: #111; }
.cam { font-family: var(--mono); }
.advanced { border-top: 1px solid var(--line); padding-top: 8px; }
.advanced summary { cursor: pointer; font-size: 12px; font-weight: 700; }
.advanced p { margin: 6px 0; }
.advanced .check { margin-top: 8px; }
@media (max-width: 800px) {
  .split, .fields { grid-template-columns: 1fr; }
}
</style>
