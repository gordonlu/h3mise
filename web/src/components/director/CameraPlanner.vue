<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import type { CameraMotionPlan, FramingRect, MediaAsset, ReferenceBinding, Shot } from '@h3mise/shared';
import { cameraPlanWarnings, viewAt, normalizeCameraPlan, emptyCameraPlan } from '@h3mise/shared';
import { get, post, put, mediaUrl } from '../../api/client';
import { t as tr } from '../../stores/locale';
import { useToastStore } from '../../stores/toast';

const props = defineProps<{
  shot: Shot;
  media: MediaAsset[];
  bindings: ReferenceBinding[];
}>();

const emit = defineEmits<{ assetsAdded: [] }>();

const toasts = useToastStore();

const plan = ref<CameraMotionPlan>({
  ...emptyCameraPlan(),
  durationSeconds: props.shot.durationSeconds,
  aspectRatio: props.shot.aspectRatio,
});
const loaded = ref(false);
const playing = ref(false);
const playTime = ref(0);
const advancedOpen = ref(false);
const sliderValue = ref<Record<string, number>>({ horizontal: 0, vertical: 0, zoom: 0, pan: 0, tilt: 0, roll: 0 });
const activeBox = ref<'start' | 'end'>('start');
const dragState = ref<'start' | 'end' | null>(null);
const motionJob = ref<string | null>(null);
const motionAssetId = ref<string | null>(null);
const framesBusy = ref(false);
const bindAfter = ref(true);
const lastSaved = ref('');

// --- history (undo / redo) --------------------------------------------------
const past = ref<string[]>([]);
const future = ref<string[]>([]);
const MAX_HISTORY = 60;

const planJson = computed(() => JSON.stringify(plan.value));

function pushHistory(): void {
  past.value.push(planJson.value);
  if (past.value.length > MAX_HISTORY) past.value.shift();
  future.value = [];
}

function applySnapshot(json: string): void {
  const restored = normalizeCameraPlan(JSON.parse(json) as unknown);
  plan.value = restored;
  playing.value = false;
}

function undo(): void {
  const prev = past.value.pop();
  if (prev === undefined) return;
  future.value.push(planJson.value);
  applySnapshot(prev);
  scheduleSave();
}

function redo(): void {
  const next = future.value.pop();
  if (next === undefined) return;
  past.value.push(planJson.value);
  applySnapshot(next);
  scheduleSave();
}

function resetAll(): void {
  pushHistory();
  plan.value = { ...emptyCameraPlan(), sourceAssetId: plan.value.sourceAssetId, durationSeconds: plan.value.durationSeconds, aspectRatio: plan.value.aspectRatio };
  scheduleSave();
}

// --- loading / saving -------------------------------------------------------
async function loadPlan(): Promise<void> {
  try {
    const saved = await get<CameraMotionPlan | null>(`/api/shots/${props.shot.id}/camera-plan`);
    if (saved) {
      plan.value = normalizeCameraPlan(saved);
      // The plan's timeline stays a snapshot of the shot's settings; keep the
      // two in sync on load so a rendered reference clip matches the shot.
      plan.value.durationSeconds = plan.value.durationSeconds > 0 ? plan.value.durationSeconds : props.shot.durationSeconds;
    } else {
      plan.value = {
        ...emptyCameraPlan(),
        durationSeconds: props.shot.durationSeconds,
        aspectRatio: props.shot.aspectRatio,
      };
      pickDefaultSource();
    }
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  }
  loaded.value = true;
}

function pickDefaultSource(): void {
  const boundImages = props.bindings
    .filter((b) => b.type === 'image')
    .map((b) => b.assetId);
  const images = imagesOf(props.media);
  const first = boundImages[0] ?? images[0]?.id ?? null;
  if (first) plan.value.sourceAssetId = first;
}

function imagesOf(media: MediaAsset[]): MediaAsset[] {
  return media.filter((m) => m.kind === 'image');
}

const sourceImages = computed(() => imagesOf(props.media));
const sourceAsset = computed(() => sourceImages.value.find((m) => m.id === plan.value.sourceAssetId) ?? null);
const sourceUrl = computed(() => (plan.value.sourceAssetId ? mediaUrl(plan.value.sourceAssetId) : null));
const mediaLabel = (asset: MediaAsset | null): string => asset?.label || asset?.id || ''; // resolved below for select

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void persist(), 900);
}
async function persist(): Promise<void> {
  try {
    await put(`/api/shots/${props.shot.id}/camera-plan`, normalizeCameraPlan({ ...plan.value }));
    lastSaved.value = new Date().toLocaleTimeString();
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  }
}

// --- building moves ---------------------------------------------------------
/** Even-split the duration across the current step count (sequential windows). */
function tidyWindows(p: CameraMotionPlan): void {
  const n = p.steps.length;
  if (!n) return;
  p.steps.forEach((step, i) => {
    step.start = i / n;
    step.end = (i + 1) / n;
  });
}

function commitSliderMove(axis: string, value: number): void {
  if (value === 0) return;
  pushHistory();
  plan.value.steps.push({
    id: `move-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    axis: axis as never,
    amount: Math.min(1, Math.max(-1, value)),
    start: 0,
    end: 1,
    ease: 'smooth',
  });
  tidyWindows(plan.value);
  sliderValue.value = { horizontal: 0, vertical: 0, zoom: 0, pan: 0, tilt: 0, roll: 0 };
  scheduleSave();
}

function removeMove(index: number): void {
  pushHistory();
  plan.value.steps.splice(index, 1);
  tidyWindows(plan.value);
  scheduleSave();
}

// --- framing ----------------------------------------------------------------
function setActiveBox(box: 'start' | 'end'): void {
  activeBox.value = box;
}

function clampRect(r: FramingRect): FramingRect {
  const size = Math.min(1, Math.max(0.15, r.w));
  return {
    x: Math.min(Math.max(0, r.x), 1 - size),
    y: Math.min(Math.max(0, r.y), 1 - size),
    w: size,
    h: size,
  };
}

function beginRectDrag(box: 'start' | 'end', event: PointerEvent): void {
  activeBox.value = box;
  dragState.value = box;
  (event.currentTarget as SVGElement).setPointerCapture(event.pointerId);
}

function dragRect(event: PointerEvent): void {
  const box = dragState.value;
  const svg = stageSvg.value;
  if (!box || !svg) return;
  const rect = svg.getBoundingClientRect();
  const nx = (event.clientX - rect.left) / rect.width;
  const ny = (event.clientY - rect.top) / rect.height;
  const cur = (box === 'start' ? plan.value.startFraming : plan.value.endFraming) ?? { x: 0, y: 0, w: 1, h: 1 };
  const next = clampRect({ x: nx - cur.w / 2, y: ny - cur.w / 2, w: cur.w, h: cur.w });
  if (box === 'start') plan.value.startFraming = next;
  else plan.value.endFraming = next;
}

function endRectDrag(): void {
  if (!dragState.value) return;
  dragState.value = null;
  pushHistory();
  scheduleSave();
}

function applyZoomToBox(value: number): void {
  const box = activeBox.value;
  const cur = (box === 'start' ? plan.value.startFraming : plan.value.endFraming) ?? { x: 0, y: 0, w: 1, h: 1 };
  const delta = Number(value) / 100;
  const w = Math.min(1, Math.max(0.15, cur.w * (1 + delta)));
  const next = clampRect({ x: cur.x + (cur.w - w) / 2, y: cur.y + (cur.w - w) / 2, w, h: w });
  if (box === 'start') plan.value.startFraming = next;
  else plan.value.endFraming = next;
}

// --- live view --------------------------------------------------------------
const stageSvg = ref<SVGSVGElement | null>(null);

/** stage aspect from plan (keep the plan's AR in live geometry). */
const stageAspect = computed(() => {
  const [rw, rh] = plan.value.aspectRatio.split(':').map((v) => Number(v) || 1);
  const w = Math.max(1, rw ?? 16);
  const h = Math.max(1, rh ?? 9);
  return `${w}/${h}`;
});

/** While a slider is being dragged it only PREVIEWS; the move is committed on
 * release (the @change handler). The live plan stacks the active slider value
 * as an extra trailing move over the whole duration. */
const livePlan = computed(() => {
  const active = AXES.map((axis) => [axis, sliderValue.value[axis] ?? 0] as const).find(([, v]) => v !== 0);
  if (!active) return plan.value;
  const [axis, amount] = active;
  return {
    ...plan.value,
    frameMode: false,
    steps: [
      ...plan.value.steps,
      { id: 'preview', axis, amount, start: 0, end: 1, ease: 'linear' as const },
    ],
  };
});

const liveView = computed(() => viewAt(livePlan.value, playing.value || clipPlaying.value ? playTime.value : normTime.value));
const normTime = ref(0.5);
const clipPlaying = ref(false);

function setTime(t: number): void {
  playTime.value = Math.min(1, Math.max(0, t));
  clipPlaying.value = false;
}

// animation loop
let raf = 0;
let lastStamp = 0;
function tick(stamp: number): void {
  if (!playing.value && !clipPlaying.value) return;
  const dt = lastStamp ? (stamp - lastStamp) / 1000 : 0;
  lastStamp = stamp;
  playTime.value = (playTime.value + dt / plan.value.durationSeconds) % 1;
  raf = requestAnimationFrame(tick);
}
function togglePlay(): void {
  playing.value = !playing.value;
  if (playing.value) {
    clipPlaying.value = false;
    raf = requestAnimationFrame(tick);
  }
}
function playClip(): void {
  clipPlaying.value = true;
  playing.value = false;
  playTime.value = 0;
  raf = requestAnimationFrame(tick);
}

const warnings = computed(() => cameraPlanWarnings(plan.value));

// --- rendering --------------------------------------------------------------
async function renderMotion(): Promise<void> {
  if (!sourceAsset.value) {
    toasts.push({ kind: 'info', text: tr('shot.camera.warnNoSource') });
    return;
  }
  try {
    const res = await post<{ jobId: string; status: string }>(`/api/shots/${props.shot.id}/camera-plan/motion`);
    motionJob.value = res.jobId;
    toasts.push({ kind: 'info', text: `${tr('shot.camera.motionLabel')} …` });
    motionAssetId.value = null;
    pollMotion(res.jobId);
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  }
}

async function pollMotion(jobId: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const job = await get<{ status: string; result: { assetId?: string } | null; error: string | null }>(`/api/jobs/${jobId}`);
      if (job.status === 'done') {
        motionJob.value = null;
        motionAssetId.value = job.result?.assetId ?? null;
        toasts.push({ kind: 'ok', text: tr('shot.camera.motionDone') });
        emit('assetsAdded');
        return;
      }
      if (job.status === 'failed') {
        motionJob.value = null;
        throw new Error(job.error ?? 'render failed');
      }
    } catch (e) {
      motionJob.value = null;
      toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
      return;
    }
  }
}

async function renderFrames(): Promise<void> {
  if (!sourceAsset.value) {
    toasts.push({ kind: 'info', text: tr('shot.camera.warnNoSource') });
    return;
  }
  framesBusy.value = true;
  try {
    await post(`/api/shots/${props.shot.id}/camera-plan/frames`, { bind: bindAfter.value });
    toasts.push({ kind: 'ok', text: tr('shot.camera.framesDone', { bound: bindAfter.value ? tr('shot.camera.bound') : '' }) });
    emit('assetsAdded');
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  } finally {
    framesBusy.value = false;
  }
}

// --- keyboard ---------------------------------------------------------------
function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable;
}
function onKey(e: KeyboardEvent): void {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (isTyping(e)) return;
  const k = e.key.toLowerCase();
  if (k === 'z') {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
  }
}

onMounted(() => {
  void loadPlan();
  window.addEventListener('keydown', onKey);
});
onUnmounted(() => {
  cancelAnimationFrame(raf);
  window.removeEventListener('keydown', onKey);
  if (saveTimer) clearTimeout(saveTimer);
});

// helper formatter for move chips
function fmtTime(f: number): string {
  return `${(f * plan.value.durationSeconds).toFixed(1)}s`;
}

const AXES = ['horizontal', 'vertical', 'zoom', 'pan', 'tilt', 'roll'] as const;

// select options merge binding-derived images + library images
const sourceOptions = computed(() => {
  const set = new Map<string, MediaAsset>();
  for (const m of sourceImages.value) set.set(m.id, m);
  for (const b of props.bindings) {
    const m = sourceImages.value.find((x) => x.id === b.assetId);
    if (m) set.set(m.id, m);
  }
  return [...set.values()];
});
</script>

<template>
  <div class="col camera-planner">
    <div class="row wrap source-row">
      <label class="field source-field">
        <span class="muted">{{ tr('shot.camera.chooseSource') }}</span>
        <select v-model="plan.sourceAssetId" @change="pushHistory(); scheduleSave()">
          <option v-for="m in sourceOptions" :key="m.id" :value="m.id">{{ mediaLabel(m) }}</option>
        </select>
      </label>
      <div class="row">
        <button class="sm" :class="{ primary: !advancedOpen }" @click="plan.frameMode = false; pushHistory(); scheduleSave()">{{ tr('shot.camera.moveMode') }}</button>
        <button class="sm" :class="{ primary: advancedOpen }" @click="plan.frameMode = true; pushHistory(); scheduleSave()">{{ tr('shot.camera.framingMode') }}</button>
      </div>
      <div class="grow" />
      <button class="sm ghost" :title="tr('shot.camera.undo')" :disabled="!past.length" @click="undo">↩</button>
      <button class="sm ghost" :title="tr('shot.camera.redo')" :disabled="!future.length" @click="redo">↪</button>
      <button class="sm ghost" :title="tr('shot.camera.reset')" @click="resetAll">⟲</button>
    </div>

    <div v-if="!loaded" class="muted">{{ tr('common.loading') }}</div>

    <template v-else>
      <div v-if="warnings.length" class="panel warn-flag">
        <span class="badge warn no-dot">!</span>
        <span>{{ warnings.map((w) => w.message).join('；') }} — {{ tr('shot.camera.warnBounds') }}</span>
      </div>

      <div class="stage-row">
        <!-- Source + framing overlay -->
        <div class="stage-wrap">
          <div class="stage-box" :style="{ aspectRatio: stageAspect }">
            <svg
              ref="stageSvg"
              class="stage-svg"
              :viewBox="'0 0 1 1'"
              preserveAspectRatio="none"
              @pointermove="dragRect"
              @pointerup="endRectDrag"
            >
              <image
                v-if="sourceUrl"
                :href="sourceUrl"
                x="0" y="0" width="1" height="1"
                preserveAspectRatio="xMidYMid meet"
                class="stage-img"
              />
              <!-- move path ghosts -->
              <template v-if="!plan.frameMode">
                <rect class="ghost" v-for="i in 9" :key="i" v-bind="{ x: viewAt(plan, i / 10).rect.x, y: viewAt(plan, i / 10).rect.y, width: viewAt(plan, i / 10).rect.w, height: viewAt(plan, i / 10).rect.w }" />
              </template>
              <!-- framing boxes -->
              <template v-else>
                <rect
                  class="fm-box start"
                  :class="{ on: activeBox === 'start', drag: dragState === 'start' }"
                  v-bind="{ x: plan.startFraming.x, y: plan.startFraming.y, width: plan.startFraming.w, height: plan.startFraming.w }"
                  :data-box="'start'"
                  @pointerdown="beginRectDrag('start', $event)"
                />
                <rect
                  class="fm-box end"
                  :class="{ on: activeBox === 'end', drag: dragState === 'end' }"
                  v-bind="{ x: (plan.endFraming ?? plan.startFraming).x, y: (plan.endFraming ?? plan.startFraming).y, width: (plan.endFraming ?? plan.startFraming).w, height: (plan.endFraming ?? plan.startFraming).w }"
                  :data-box="'end'"
                  @pointerdown="beginRectDrag('end', $event)"
                />
                <text class="fm-tag" :x="plan.startFraming.x + plan.startFraming.w / 2" :y="plan.startFraming.y - 0.02" text-anchor="middle">START</text>
                <text class="fm-tag end" :x="(plan.endFraming ?? plan.startFraming).x + (plan.endFraming ?? plan.startFraming).w / 2" :y="(plan.endFraming ?? plan.startFraming).y - 0.02" text-anchor="middle">END</text>
              </template>
              <!-- live view -->
              <rect class="live" v-bind="{ x: liveView.rect.x, y: liveView.rect.y, width: liveView.rect.w, height: liveView.rect.w }" />
            </svg>
            <span class="stage-time mono">{{ fmtTime(playTime) }} / {{ plan.durationSeconds }}s</span>
          </div>
          <div class="muted hints">
            <template v-if="plan.frameMode">
              <button class="sm ghost" @click="setActiveBox('start')">Start</button>
              <button class="sm ghost" @click="setActiveBox('end')">End</button>
              <span class="muted">{{ tr('shot.camera.dragHint') }}</span>
            </template>
            <template v-else>
              <span class="muted">{{ tr('shot.camera.movesEmpty') }}</span>
            </template>
          </div>
        </div>

        <!-- Camera view preview + scrubbing -->
        <div class="camera-preview">
          <div class="preview-head spread">
            <span class="pb-title">{{ tr('shot.camera.framePreview') }}</span>
            <div class="row">
              <button class="sm" @click="togglePlay">{{ playing ? tr('shot.camera.pausePreview') : tr('shot.camera.playPreview') }}</button>
            </div>
          </div>
          <div class="preview-box" :style="{ aspectRatio: stageAspect }">
            <svg :viewBox="`${liveView.rect.x} ${liveView.rect.y} ${liveView.rect.w} ${liveView.rect.h}`" preserveAspectRatio="none">
              <image :href="sourceUrl || ''" :width="1 / liveView.rect.w" :height="1 / liveView.rect.h" preserveAspectRatio="xMidYMid meet" class="stage-img" />
            </svg>
          </div>
          <div class="row scrub">
            <input
              type="range" min="0" max="1" step="0.001"
              :value="playTime"
              @input="setTime(Number(($event.target as HTMLInputElement).value))"
            />
          </div>
        </div>
      </div>

      <!-- Controls -->
      <section class="panel controls-panel">
        <div class="panel-title">{{ tr('shot.camera.moveMode') }}</div>
        <div class="panel-body col">
          <template v-if="plan.frameMode">
            <div class="muted">{{ tr('shot.camera.framingMode') }}</div>
            <label class="ctl">
              <span class="ctl-label">Zoom ({{ activeBox }})</span>
              <input type="range" min="-60" max="60" step="1" :value="0" class="grow" @change="applyZoomToBox(Number(($event.target as HTMLInputElement).value)); pushHistory(); scheduleSave()" />
            </label>
            <label class="ctl">
              <span class="ctl-label">{{ tr('shot.camera.timeIndicator') }}</span>
              <input type="range" min="0" max="1" step="0.001" :value="playTime" class="grow" @input="setTime(Number(($event.target as HTMLInputElement).value))" />
            </label>
          </template>
          <template v-else>
            <div v-for="axis in AXES" :key="axis">
              <div v-if="axis !== 'roll' || advancedOpen" class="ctl slider-row">
                <span class="ctl-label">{{ tr(`shot.camera.axis.${axis}`) }}</span>
                <input
                  type="range" min="-100" max="100" step="5"
                  :value="Math.round((sliderValue[axis] ?? 0) * 100)"
                  class="grow"
                  @input="sliderValue[axis] = Number(($event.target as HTMLInputElement).value) / 100"
                  @change="commitSliderMove(axis, sliderValue[axis] ?? 0)"
                />
                <span class="mono val">{{ Math.round((sliderValue[axis] ?? 0) * 100) }}</span>
              </div>
            </div>
            <button class="sm ghost adv-toggle" @click="advancedOpen = !advancedOpen">▸ {{ tr('shot.camera.advancedRoll') }}</button>
            <div class="move-list">
              <span v-if="!plan.steps.length" class="muted">{{ tr('shot.camera.movesEmpty') }}</span>
              <div v-for="(step, i) in plan.steps" :key="step.id" class="move-chip">
                <span class="badge accent no-dot">{{ tr(`shot.camera.axis.${step.axis}`) }}</span>
                <span class="mono">{{ (step.amount > 0 ? '+' : '') + step.amount.toFixed(2) }}</span>
                <span class="mono muted">{{ fmtTime(step.start) }}–{{ fmtTime(step.end) }}</span>
                <button class="sm ghost" :title="tr('shot.camera.deleteMove')" @click="removeMove(i)">✕</button>
              </div>
            </div>
          </template>
        </div>
      </section>

      <!-- Render actions -->
      <section class="panel render-panel">
        <div class="panel-body row wrap render-actions">
          <button class="primary sm" :disabled="Boolean(motionJob) || !sourceAsset" @click="renderMotion">
            {{ motionJob ? (tr('shot.camera.motionLabel') + ' …') : tr('shot.camera.renderMotion') }}
          </button>
          <button class="sm" :disabled="framesBusy || !sourceAsset" @click="renderFrames">
            {{ framesBusy ? tr('common.loading') : tr('shot.camera.renderFrames') }}
          </button>
          <label class="row muted bind-tick">
            <input v-model="bindAfter" type="checkbox" />
            <span>{{ tr('shot.camera.renderFramesBind') }}</span>
          </label>
          <span v-if="lastSaved" class="muted">{{ tr('shot.camera.saved') }} · {{ lastSaved }}</span>
        </div>
        <div v-if="motionAssetId" class="panel-body">
          <video :src="mediaUrl(motionAssetId)" controls playsinline class="motion-mini" />
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.camera-planner { min-width: 0; }
.source-row { gap: 10px; align-items: end; }
.source-field { min-width: 220px; }
.stage-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(200px, 340px); gap: 12px; align-items: start; }
.stage-wrap { min-width: 0; }
.stage-box { position: relative; width: 100%; background: radial-gradient(120% 120% at 50% 0%, var(--bg-4), var(--bg-3)); border: 1px solid var(--line); border-radius: var(--radius-sm); overflow: hidden; }
.stage-svg { width: 100%; height: 100%; display: block; touch-action: none; }
.stage-img { opacity: 0.92; }
.ghost { fill: none; stroke: rgba(140, 140, 140, 0.22); stroke-width: 0.004; pointer-events: none; }
.live { fill: none; stroke: var(--accent); stroke-width: 0.008; pointer-events: none; }
.fm-box { fill: var(--accent-soft); stroke: var(--accent); stroke-width: 0.008; cursor: move; }
.fm-box.start { fill: rgba(46, 155, 103, 0.14); stroke: var(--ok); }
.fm-box.end { fill: rgba(78, 120, 168, 0.14); stroke: var(--info); }
.fm-box.drag { stroke-width: 0.012; }
.fm-tag { fill: var(--ok); font-size: 0.035px; font-weight: 800; pointer-events: none; }
.fm-tag.end { fill: var(--info); }
.stage-time { position: absolute; left: 8px; bottom: 6px; font-size: 11px; color: var(--text-2); background: rgba(0, 0, 0, 0.45); padding: 1px 8px; border-radius: 999px; }
.hints { margin-top: 6px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.camera-preview { min-width: 0; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg-subtle); padding: 10px; }
.pb-title { font-size: 11px; font-weight: 700; color: var(--text-2); text-transform: uppercase; letter-spacing: 0.08em; }
.preview-box { width: 100%; background: #000; border-radius: 4px; overflow: hidden; }
.preview-box svg { width: 100%; height: 100%; display: block; }
.scrub { margin-top: 8px; }
.scrub input { width: 100%; }
.controls-panel { min-width: 0; }
.slider-row { display: grid; grid-template-columns: 92px minmax(0, 1fr) 34px; gap: 8px; align-items: center; }
.val { font-size: 11px; color: var(--text-3); text-align: right; }
.adv-toggle { margin: 4px 0; }
.move-list { display: grid; gap: 4px; margin-top: 6px; }
.move-chip { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border: 1px solid var(--line-2); border-radius: 6px; background: var(--bg-subtle); font-size: 12px; }
.render-actions { gap: 10px; align-items: center; }
.bind-tick { gap: 4px; }
.motion-mini { width: 100%; max-width: 320px; border-radius: 6px; }
.warn-flag { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--border)); background: var(--warn-soft); padding: 8px 10px; }
</style>
