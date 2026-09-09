<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { CameraMotionPlan, FramingRect, MediaAsset, ReferenceBinding, Shot } from '@h3mise/shared';
import { cameraPlanWarnings, viewAt, normalizeCameraPlan, emptyCameraPlan, describeCameraPlan } from '@h3mise/shared';
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

const cameraSummary = computed(() => describeCameraPlan(plan.value, props.shot.durationSeconds));
function preset(kind: 'static' | 'push' | 'pull' | 'left' | 'right') {
  plan.value.frameMode = true;
  plan.value.steps = [];
  const wide = { x: 0, y: 0, w: 1, h: 1 };
  const tight = { x: .18, y: .18, w: .64, h: .64 };
  plan.value.startFraming = kind === 'pull' ? tight : ['left', 'right'].includes(kind) ? { x: kind === 'left' ? .3 : 0, y: .15, w: .7, h: .7 } : wide;
  plan.value.endFraming = kind === 'push' ? tight : ['left', 'right'].includes(kind) ? { x: kind === 'left' ? 0 : .3, y: .15, w: .7, h: .7 } : wide;
  pushHistory(); scheduleSave();
}

// Plan state
const plan = ref<CameraMotionPlan>({
  ...emptyCameraPlan(),
  durationSeconds: props.shot.durationSeconds,
  aspectRatio: props.shot.aspectRatio,
});
const loaded = ref(false);

// Preview
const playing = ref(false);
const playTime = ref(0);
const stageSvg = ref<SVGSVGElement | null>(null);

// Framing mode
const activeBox = ref<'start' | 'end'>('start');
const dragState = ref<'start' | 'end' | null>(null);
const dragStart = ref<{ mx: number; my: number; fx: number; fy: number } | null>(null);

// Move mode
const AXES = ['horizontal', 'vertical', 'zoom', 'pan', 'tilt', 'roll'] as const;
const advancedOpen = ref(false);
const sliderValue = ref<Record<string, number>>({ horizontal: 0, vertical: 0, zoom: 0, pan: 0, tilt: 0, roll: 0 });

// Render
const motionJob = ref<string | null>(null);
const motionAssetId = ref<string | null>(null);
const framesBusy = ref(false);
const bindAfter = ref(true);
const lastSaved = ref('');

// History
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
  plan.value = normalizeCameraPlan(JSON.parse(json) as unknown);
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

// Loading / saving
async function loadPlan(): Promise<void> {
  try {
    const saved = await get<CameraMotionPlan | null>(`/api/shots/${props.shot.id}/camera-plan`);
    if (saved) {
      plan.value = normalizeCameraPlan(saved);
      plan.value.durationSeconds = plan.value.durationSeconds > 0 ? plan.value.durationSeconds : props.shot.durationSeconds;
    } else {
      plan.value = { ...emptyCameraPlan(), durationSeconds: props.shot.durationSeconds, aspectRatio: props.shot.aspectRatio };
      pickDefaultSource();
    }
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  }
  loaded.value = true;
}

function pickDefaultSource(): void {
  const boundImages = props.bindings.filter((b) => b.type === 'image').map((b) => b.assetId);
  const images = sourceImages.value;
  const first = boundImages[0] ?? images[0]?.id ?? null;
  if (first) plan.value.sourceAssetId = first;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void persist().catch(() => {}), 900);
}
async function persist(): Promise<void> {
  try {
    await put(`/api/shots/${props.shot.id}/camera-plan`, normalizeCameraPlan({ ...plan.value }));
    lastSaved.value = new Date().toLocaleTimeString();
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

// Source images
const sourceImages = computed(() => props.media.filter((m) => m.kind === 'image'));
const sourceAsset = computed(() => sourceImages.value.find((m) => m.id === plan.value.sourceAssetId) ?? null);
const sourceUrl = computed(() => (plan.value.sourceAssetId ? mediaUrl(plan.value.sourceAssetId) : null));
const mediaLabel = (asset: MediaAsset | null): string => asset?.label || asset?.id || '';

// Stage aspect
const stageAspect = computed(() => {
  const [rw, rh] = plan.value.aspectRatio.split(':').map((v) => Number(v) || 1);
  return `${Math.max(1, rw ?? 16)}/${Math.max(1, rh ?? 9)}`;
});

// Framing helpers
function clampRect(r: FramingRect): FramingRect {
  const size = Math.min(1, Math.max(0.15, r.w));
  return { x: Math.min(Math.max(0, r.x), 1 - size), y: Math.min(Math.max(0, r.y), 1 - size), w: size, h: size };
}

function svgXY(e: PointerEvent): { nx: number; ny: number } | null {
  const svg = stageSvg.value;
  if (!svg) return null;
  const rect = svg.getBoundingClientRect();
  return { nx: (e.clientX - rect.left) / rect.width, ny: (e.clientY - rect.top) / rect.height };
}

function beginRectDrag(box: 'start' | 'end', e: PointerEvent): void {
  activeBox.value = box;
  dragState.value = box;
  const cur = (box === 'start' ? plan.value.startFraming : plan.value.endFraming) ?? { x: 0, y: 0, w: 1, h: 1 };
  dragStart.value = { mx: e.clientX, my: e.clientY, fx: cur.x, fy: cur.y };
  (e.currentTarget as SVGElement).setPointerCapture(e.pointerId);
  e.preventDefault();
}

function dragRect(e: PointerEvent): void {
  const box = dragState.value;
  const start = dragStart.value;
  const svg = stageSvg.value;
  if (!box || !start || !svg) return;
  const rect = svg.getBoundingClientRect();
  const dx = (e.clientX - start.mx) / rect.width;
  const dy = (e.clientY - start.my) / rect.height;
  const cur = (box === 'start' ? plan.value.startFraming : plan.value.endFraming) ?? { x: 0, y: 0, w: 1, h: 1 };
  const next = clampRect({ x: start.fx + dx, y: start.fy + dy, w: cur.w, h: cur.w });
  if (box === 'start') plan.value.startFraming = next;
  else plan.value.endFraming = next;
}

function endRectDrag(): void {
  if (!dragState.value) return;
  dragState.value = null;
  dragStart.value = null;
  pushHistory();
  scheduleSave();
}

// Framing box resize via pointer wheel on the SVG
function onStageWheel(e: WheelEvent): void {
  if (!plan.value.frameMode) return;
  e.preventDefault();
  const box = activeBox.value;
  const cur = (box === 'start' ? plan.value.startFraming : plan.value.endFraming) ?? { x: 0, y: 0, w: 1, h: 1 };
  const delta = -e.deltaY * 0.001;
  const w = Math.min(1, Math.max(0.15, cur.w + delta));
  const next = clampRect({ x: cur.x + (cur.w - w) / 2, y: cur.y + (cur.w - w) / 2, w, h: w });
  if (box === 'start') plan.value.startFraming = next;
  else plan.value.endFraming = next;
  pushHistory();
  scheduleSave();
}

// Moves
function tidyWindows(p: CameraMotionPlan): void {
  const n = p.steps.length;
  if (!n) return;
  p.steps.forEach((step, i) => { step.start = i / n; step.end = (i + 1) / n; });
}

function commitSliderMove(axis: string, value: number): void {
  if (value === 0) return;
  pushHistory();
  plan.value.steps.push({
    id: `move-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
    axis: axis as never,
    amount: Math.min(1, Math.max(-1, value)),
    start: 0, end: 1, ease: 'smooth',
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

// Live view — NON-REACTIVE. Updated via rAF + direct DOM manipulation.
// This avoids Vue reactivity entirely, so preview updates never trigger
// a template re-render or the flickering that comes with it.
const liveRectEl = ref<SVGRectElement | null>(null);
const liveRect = { x: 0.25, y: 0.25, w: 0.5 };
let previewRaf = 0;
function applyLiveView(): void {
  const el = liveRectEl.value;
  if (!el) return;
  el.setAttribute('x', String(liveRect.x));
  el.setAttribute('y', String(liveRect.y));
  el.setAttribute('width', String(liveRect.w));
  el.setAttribute('height', String(liveRect.w));
}
function schedulePreview(): void {
  if (previewRaf) return;
  previewRaf = requestAnimationFrame(() => {
    previewRaf = 0;
    const t = playing.value ? playTime.value : 0.5;
    const active = AXES.map((axis) => [axis, sliderValue.value[axis] ?? 0] as const).find(([, v]) => v !== 0);
    const effective = active
      ? { ...plan.value, frameMode: false, steps: [...plan.value.steps, { id: '_preview', axis: active[0], amount: active[1], start: 0, end: 1, ease: 'linear' as const }] }
      : plan.value;
    const v = viewAt(effective, t);
    liveRect.x = v.rect.x;
    liveRect.y = v.rect.y;
    liveRect.w = v.rect.w;
    applyLiveView();
  });
}

// Play
let raf = 0;
let lastStamp = 0;
function tick(stamp: number): void {
  if (!playing.value) return;
  const dt = lastStamp ? (stamp - lastStamp) / 1000 : 0;
  lastStamp = stamp;
  playTime.value = (playTime.value + dt / plan.value.durationSeconds) % 1;
  schedulePreview();
  raf = requestAnimationFrame(tick);
}
function togglePlay(): void {
  playing.value = !playing.value;
  if (playing.value) { lastStamp = 0; raf = requestAnimationFrame(tick); }
}

// Warnings
const warnings = computed(() => cameraPlanWarnings(plan.value));

// Rendering
async function renderMotion(): Promise<void> {
  if (!sourceAsset.value) { toasts.push({ kind: 'info', text: tr('shot.camera.warnNoSource') }); return; }
  try {
    if (saveTimer) clearTimeout(saveTimer);
    await persist();
    const res = await post<{ jobId: string; status: string }>(`/api/shots/${props.shot.id}/camera-plan/motion`, { provider: 'local' });
    motionJob.value = res.jobId;
    toasts.push({ kind: 'info', text: `${tr('shot.camera.motionLabel')} …` });
    motionAssetId.value = null;
    pollMotion(res.jobId);
  } catch (e) { toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) }); }
}

async function pollMotion(jobId: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const job = await get<{ status: string; result: { assetId?: string } | null; error: string | null }>(`/api/jobs/${jobId}`);
      if (job.status === 'done') { motionJob.value = null; motionAssetId.value = job.result?.assetId ?? null; toasts.push({ kind: 'ok', text: tr('shot.camera.motionDone') }); emit('assetsAdded'); return; }
      if (job.status === 'failed') { motionJob.value = null; throw new Error(job.error ?? 'render failed'); }
    } catch (e) { motionJob.value = null; toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) }); return; }
  }
}

async function renderFrames(): Promise<void> {
  if (!sourceAsset.value) { toasts.push({ kind: 'info', text: tr('shot.camera.warnNoSource') }); return; }
  framesBusy.value = true;
  try {
    if (saveTimer) clearTimeout(saveTimer);
    await persist();
    await post(`/api/shots/${props.shot.id}/camera-plan/frames`, { bind: bindAfter.value });
    toasts.push({ kind: 'ok', text: tr('shot.camera.framesDone', { bound: bindAfter.value ? tr('shot.camera.bound') : '' }) });
    emit('assetsAdded');
  } catch (e) { toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) }); }
  finally { framesBusy.value = false; }
}

// Keyboard
function isTyping(e: KeyboardEvent): boolean { const el = e.target as HTMLElement; return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable; }
function onKey(e: KeyboardEvent): void {
  if (isTyping(e)) return;
  if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((e.metaKey || e.ctrlKey) && e.key === 'z' && e.shiftKey) { e.preventDefault(); redo(); }
  else if ((e.metaKey || e.ctrlKey) && e.key === 'y') { e.preventDefault(); redo(); }
}

// Init
onMounted(async () => {
  void loadPlan();
  window.addEventListener('keydown', onKey);
});
onUnmounted(() => {
  cancelAnimationFrame(raf);
  cancelAnimationFrame(previewRaf);
  window.removeEventListener('keydown', onKey);
  if (saveTimer) clearTimeout(saveTimer);
});

function fmtTime(f: number): string { return `${(f * plan.value.durationSeconds).toFixed(1)}s`; }
</script>

<template>
  <div class="camera-planner">
    <div class="camera-purpose"><strong>设计取景变化 → 预演 → 用于生成</strong><p>这里预演的是二维裁切，不包含三维环绕、视差或景深。真实运镜意图请在导演计划中描述。</p><ol><li>保存计划后，重新编译 Prompt，将取景方向与节奏写入生成指令。</li><li>导出首尾帧可用于首尾帧生成；原有绑定会保留。</li><li>本地视频用于检查节奏；仅当 Provider 支持视频输入时，才可作为相机参考。</li></ol></div>
    <div class="cp-render-row"><button class="sm" @click="preset('static')">固定</button><button class="sm" @click="preset('push')">收紧取景</button><button class="sm" @click="preset('pull')">展开取景</button><button class="sm" @click="preset('left')">向左取景</button><button class="sm" @click="preset('right')">向右取景</button></div>
    <!-- Source + mode -->
    <div class="cp-header">
      <label class="field source-field">
        <span class="field-label">{{ tr('shot.camera.chooseSource') }}</span>
        <select v-model="plan.sourceAssetId" @change="pushHistory(); scheduleSave()">
          <option v-for="m in sourceImages" :key="m.id" :value="m.id">{{ mediaLabel(m) }}</option>
        </select>
      </label>
      <div class="mode-toggle">
        <button class="sm" :class="{ primary: !plan.frameMode }" @click="plan.frameMode = false; pushHistory(); scheduleSave()">{{ tr('shot.camera.moveMode') }}</button>
        <button class="sm" :class="{ primary: plan.frameMode }" @click="plan.frameMode = true; pushHistory(); scheduleSave()">{{ tr('shot.camera.framingMode') }}</button>
      </div>
      <div class="cp-spacer" />
      <button class="icon-btn" :disabled="!past.length" :title="tr('shot.camera.undo')" @click="undo">↩</button>
      <button class="icon-btn" :disabled="!future.length" :title="tr('shot.camera.redo')" @click="redo">↪</button>
      <button class="icon-btn" :title="tr('shot.camera.reset')" @click="resetAll">⟲</button>
    </div>

    <div v-if="!loaded" class="muted cp-loading">{{ tr('common.loading') }}</div>

    <template v-else>
      <div v-if="warnings.length" class="cp-warn">
        <span class="badge warn no-dot">!</span>
        <span>{{ warnings.map((w) => w.message).join('；') }}</span>
      </div>

      <!-- Canvas -->
      <div class="cp-canvas-wrap">
        <div class="cp-canvas" :style="{ aspectRatio: stageAspect }">
          <svg
            ref="stageSvg"
            class="cp-svg"
            :viewBox="'0 0 1 1'"
            preserveAspectRatio="none"
            @pointermove="dragRect"
            @pointerup="endRectDrag"
            @wheel.prevent="onStageWheel"
          >
            <image v-if="sourceUrl" :href="sourceUrl" x="0" y="0" width="1" height="1" preserveAspectRatio="xMidYMid meet" class="cp-img" />
            <!-- Move ghosts -->
            <template v-if="!plan.frameMode">
              <rect v-for="i in 9" :key="i" class="cp-ghost" :x="viewAt(plan, i / 10).rect.x" :y="viewAt(plan, i / 10).rect.y" :width="viewAt(plan, i / 10).rect.w" :height="viewAt(plan, i / 10).rect.w" />
            </template>
            <!-- Framing boxes -->
            <template v-else>
              <rect class="cp-fbox start" :class="{ on: activeBox === 'start', drag: dragState === 'start' }"
                :x="plan.startFraming.x" :y="plan.startFraming.y" :width="plan.startFraming.w" :height="plan.startFraming.w"
                @pointerdown="beginRectDrag('start', $event)" />
              <rect class="cp-fbox end" :class="{ on: activeBox === 'end', drag: dragState === 'end' }"
                :x="(plan.endFraming ?? plan.startFraming).x" :y="(plan.endFraming ?? plan.startFraming).y"
                :width="(plan.endFraming ?? plan.startFraming).w" :height="(plan.endFraming ?? plan.startFraming).w"
                @pointerdown="beginRectDrag('end', $event)" />
              <text class="cp-fbox-label start" :x="plan.startFraming.x + plan.startFraming.w / 2" :y="plan.startFraming.y - 0.015" text-anchor="middle">S</text>
              <text class="cp-fbox-label end" :x="(plan.endFraming ?? plan.startFraming).x + (plan.endFraming ?? plan.startFraming).w / 2"
                :y="(plan.endFraming ?? plan.startFraming).y - 0.015" text-anchor="middle">E</text>
            </template>
            <!-- Live view outline — ref, NOT reactive -->
            <rect ref="liveRectEl" class="cp-live" x="0.25" y="0.25" width="0.5" height="0.5" />
          </svg>
          <span class="cp-time">{{ fmtTime(playTime) }} / {{ plan.durationSeconds }}s</span>
        </div>
        <!-- Preview bar -->
        <div class="cp-preview-bar">
          <button class="icon-btn" @click="togglePlay">{{ playing ? '⏸' : '▶' }}</button>
          <input type="range" min="0" max="1" step="0.002" :value="playTime" @input="playTime = Number(($event.target as HTMLInputElement).value); schedulePreview()" class="cp-scrub" />
        </div>
        <!-- Framing hints -->
        <div v-if="plan.frameMode" class="cp-hints">
          <button class="sm" :class="{ primary: activeBox === 'start' }" @click="activeBox = 'start'">{{ tr('shot.camera.startBox') }}</button>
          <button class="sm" :class="{ primary: activeBox === 'end' }" @click="activeBox = 'end'">{{ tr('shot.camera.endBox') }}</button>
          <span class="muted">{{ tr('shot.camera.dragHint') }}</span>
        </div>
      </div>

      <!-- Controls panel -->
      <div class="cp-controls">
        <div class="cp-ctl-title">{{ plan.frameMode ? tr('shot.camera.framingMode') : tr('shot.camera.moveMode') }}</div>

        <!-- Framing mode controls -->
        <template v-if="plan.frameMode">
          <label class="cp-ctl-row">
            <span class="cp-ctl-label">{{ tr('shot.camera.boxSize') }} ({{ activeBox === 'start' ? tr('shot.camera.startBox') : tr('shot.camera.endBox') }})</span>
            <input type="range" min="15" max="100" step="1"
              :value="Math.round(((activeBox === 'start' ? plan.startFraming : (plan.endFraming ?? plan.startFraming)).w) * 100)"
              class="cp-ctl-slider"
              @change="(e: Event) => {
                const v = Number((e.target as HTMLInputElement).value) / 100;
                const box = activeBox;
                const cur = (box === 'start' ? plan.startFraming : (plan.endFraming ?? plan.startFraming));
                const next = clampRect({ x: cur.x + (cur.w - v) / 2, y: cur.y + (cur.w - v) / 2, w: v, h: v });
                if (box === 'start') plan.startFraming = next;
                else plan.endFraming = next;
                pushHistory(); scheduleSave();
              }" />
            <span class="cp-ctl-val">{{ Math.round(((activeBox === 'start' ? plan.startFraming : (plan.endFraming ?? plan.startFraming)).w) * 100) }}%</span>
          </label>
        </template>

        <!-- Move mode controls -->
        <template v-else>
          <div v-for="axis in AXES" :key="axis">
            <div v-if="axis !== 'roll' || advancedOpen" class="cp-ctl-row">
              <span class="cp-ctl-label">{{ tr(`shot.camera.axis.${axis}`) }}</span>
              <input type="range" min="-100" max="100" step="5"
                :value="Math.round((sliderValue[axis] ?? 0) * 100)"
                class="cp-ctl-slider"
                @input="sliderValue[axis] = Number(($event.target as HTMLInputElement).value) / 100; schedulePreview()"
                @change="commitSliderMove(axis, sliderValue[axis] ?? 0)" />
              <span class="cp-ctl-val">{{ Math.round((sliderValue[axis] ?? 0) * 100) }}</span>
            </div>
          </div>
          <button class="sm ghost cp-adv-toggle" @click="advancedOpen = !advancedOpen">▸ {{ tr('shot.camera.advancedRoll') }}</button>
        </template>

        <!-- Move list (always visible in move mode) -->
        <template v-if="!plan.frameMode">
          <div v-if="!plan.steps.length" class="muted cp-moves-empty">{{ tr('shot.camera.movesEmpty') }}</div>
          <div v-for="(step, i) in plan.steps" :key="step.id" class="cp-move">
            <span class="badge accent no-dot">{{ tr(`shot.camera.axis.${step.axis}`) }}</span>
            <span class="mono">{{ (step.amount > 0 ? '+' : '') + step.amount.toFixed(2) }}</span>
            <span class="muted">{{ fmtTime(step.start) }}–{{ fmtTime(step.end) }}</span>
            <button class="icon-btn sm" :title="tr('shot.camera.deleteMove')" @click="removeMove(i)">✕</button>
          </div>
        </template>
      </div>

      <!-- Render -->
      <div class="cp-render">
        <div class="cp-render-header">{{ tr('shot.camera.renderActions') }}</div>
        <p class="camera-summary">生成指令：{{ cameraSummary }}</p>
        <div class="cp-render-row">
          <button class="primary sm" :disabled="Boolean(motionJob) || !sourceAsset" @click="renderMotion">
            {{ motionJob ? (tr('shot.camera.motionLabel') + ' …') : tr('shot.camera.renderMotion') }}
          </button>
          <button class="sm" :disabled="framesBusy || !sourceAsset" @click="renderFrames">
            {{ framesBusy ? tr('common.loading') : tr('shot.camera.renderFrames') }}
          </button>
          <label class="cp-bind">
            <input v-model="bindAfter" type="checkbox" />
            <span>{{ tr('shot.camera.renderFramesBind') }}</span>
          </label>
        </div>
        <span v-if="lastSaved" class="muted">{{ tr('shot.camera.saved') }} · {{ lastSaved }}</span>
        <video v-if="motionAssetId" :src="mediaUrl(motionAssetId)" controls playsinline class="cp-motion-video" />
        <router-link v-if="motionAssetId" :to="{ path: `/assets/${motionAssetId}/breakdown`, query: { shotId: shot.id } }">打开参考准备并绑定到此 Shot →</router-link>
      </div>
    </template>
  </div>
</template>

<style scoped>
.camera-planner { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.camera-purpose{padding:14px 16px;background:var(--accent-soft);border-radius:8px;font-size:12px;line-height:1.65}.camera-purpose p{margin:6px 0;color:var(--text-2)}.camera-purpose ol{margin:8px 0 0;padding-left:18px;color:var(--text-2)}.camera-summary{font-size:12px;margin:0;line-height:1.6}

/* Header */
.cp-header { display: flex; align-items: end; gap: 8px; flex-wrap: wrap; }
.source-field { min-width: 180px; flex: 0 0 auto; }
.source-field select { width: 100%; }
.mode-toggle { display: flex; gap: 4px; }
.cp-spacer { flex: 1; }
.icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 1px solid var(--line-2); border-radius: var(--radius-sm); background: var(--bg-2); color: var(--text); cursor: pointer; font-size: 14px; }
.icon-btn:hover:not(:disabled) { background: var(--accent-soft); border-color: var(--accent-line); }
.icon-btn:disabled { opacity: 0.35; cursor: default; }

/* Canvas */
.cp-canvas-wrap { display: flex; flex-direction: column; gap: 6px; }
.cp-canvas { position: relative; width: 100%; background: radial-gradient(120% 120% at 50% 0%, var(--bg-4), var(--bg-3)); border: 1px solid var(--line); border-radius: var(--radius-sm); overflow: hidden; }
.cp-svg { width: 100%; height: 100%; display: block; touch-action: none; }
.cp-img { opacity: 0.92; }
.cp-ghost { fill: none; stroke: rgba(140, 140, 140, 0.22); stroke-width: 0.004; pointer-events: none; }
.cp-live { fill: none; stroke: var(--accent); stroke-width: 0.008; pointer-events: none; }
.cp-fbox { fill: rgba(46, 155, 103, 0.12); stroke: var(--ok); stroke-width: 0.008; cursor: move; }
.cp-fbox.end { fill: rgba(78, 120, 168, 0.12); stroke: var(--info); }
.cp-fbox.on { stroke-width: 0.012; }
.cp-fbox.drag { stroke-width: 0.014; filter: drop-shadow(0 0 4px rgba(46, 155, 103, 0.4)); }
.cp-fbox.end.drag { filter: drop-shadow(0 0 4px rgba(78, 120, 168, 0.4)); }
.cp-fbox-label { font-size: 0.04px; font-weight: 800; pointer-events: none; }
.cp-fbox-label.start { fill: var(--ok); }
.cp-fbox-label.end { fill: var(--info); }
.cp-time { position: absolute; left: 8px; bottom: 6px; font-size: 11px; color: var(--text-2); background: rgba(0, 0, 0, 0.5); padding: 2px 8px; border-radius: 999px; }

/* Preview bar */
.cp-preview-bar { display: flex; align-items: center; gap: 8px; }
.cp-scrub { flex: 1; min-width: 0; }
.cp-hints { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }

/* Controls */
.cp-controls { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 10px 12px; background: var(--bg-subtle); }
.cp-ctl-title { font-size: 11px; font-weight: 700; color: var(--text-2); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px; }
.cp-ctl-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
.cp-ctl-label { font-size: 12px; color: var(--text-2); min-width: 80px; flex-shrink: 0; }
.cp-ctl-slider { flex: 1; min-width: 0; }
.cp-ctl-val { font-size: 11px; color: var(--text-3); min-width: 32px; text-align: right; font-family: monospace; }
.cp-adv-toggle { margin: 4px 0; }
.cp-moves-empty { font-size: 12px; margin: 6px 0; }
.cp-move { display: flex; align-items: center; gap: 8px; padding: 4px 8px; border: 1px solid var(--line-2); border-radius: 6px; background: var(--bg-subtle); font-size: 12px; margin: 3px 0; }

/* Render */
.cp-render { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 10px 12px; background: var(--bg-subtle); display: flex; flex-direction: column; gap: 8px; }
.cp-render-header { font-size: 11px; font-weight: 700; color: var(--text-2); text-transform: uppercase; letter-spacing: 0.08em; }
.cp-render-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cp-bind { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text-3); }
.cp-motion-video { width: 100%; max-width: 320px; border-radius: 6px; margin-top: 4px; }

/* Warn */
.cp-warn { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 40%, var(--border)); background: var(--warn-soft); padding: 8px 10px; border-radius: var(--radius-sm); }
.cp-loading { padding: 16px; text-align: center; }
</style>
