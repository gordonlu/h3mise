<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { get, post, patch, del, takeVideoUrl, fileUrl, subscribeEvents } from '../api/client';
import { useToastStore } from '../stores/toast';
import type { TimelineClip } from '@h3mise/shared';
import VideoPlayer from '../components/VideoPlayer.vue';
import EmptyState from '../components/EmptyState.vue';

interface ShotWithTake {
  shotId: string;
  shotTitle: string;
  takeId: string;
  duration: number;
  poster: string | null;
}

const toasts = useToastStore();
const clips = ref<TimelineClip[]>([]);
const shotsWithTakes = ref<ShotWithTake[]>([]);
const exportJob = ref<{ id: string; status: string; progress?: number | null; result?: { relPath?: string; url?: string }; error?: string | null } | null>(null);
const playUrl = ref('');
const activeClipId = ref<string | null>(null);
const trimPlayer = ref<InstanceType<typeof VideoPlayer> | null>(null);
const dragId = ref<string | null>(null);
const dropTargetId = ref<string | null>(null);

const PX_PER_SEC = 14;
const MIN_CLIP_PX = 72;

/** Accurate take durations for trim-out fallback (PRD: no phantom 5s guess). */
const takeDuration = computed(() => {
  const m = new Map<string, number>();
  for (const s of shotsWithTakes.value) m.set(s.takeId, s.duration);
  return m;
});

const takePoster = computed(() => {
  const m = new Map<string, string | null>();
  for (const s of shotsWithTakes.value) m.set(s.takeId, s.poster);
  return m;
});

function clipDuration(c: TimelineClip): number {
  const full = takeDuration.value.get(c.takeId) ?? 0;
  return Math.max(0.1, (c.trimOut ?? full) - c.trimIn);
}

function clipWidth(c: TimelineClip): number {
  return Math.max(MIN_CLIP_PX, clipDuration(c) * PX_PER_SEC);
}

const totalSeconds = computed(() => clips.value.reduce((acc, c) => acc + clipDuration(c), 0));
const activeClip = computed(() => clips.value.find((c) => c.id === activeClipId.value) ?? null);

async function load() {
  const tl = await get<{ id: string; clips: TimelineClip[] }>('/api/timeline');
  clips.value = tl.clips;
  const shots = await get<Array<{ id: string; title: string }>>('/api/shots');
  const takes = await Promise.all(
    shots.map(async (s) => {
      const det = await get<{ takes: Array<{ id: string; duration: number; status: string; posterPath: string | null }> }>(`/api/shots/${s.id}`);
      const sel = det.takes.find((t) => t.status === 'selected');
      return sel ? { shotId: s.id, shotTitle: s.title, takeId: sel.id, duration: sel.duration, poster: sel.posterPath } : null;
    }),
  );
  shotsWithTakes.value = takes.filter((t): t is ShotWithTake => t !== null);
}

async function addClip(shotId: string, takeId: string) {
  try {
    await post('/api/timeline/clips', { shotId, takeId });
    await load();
    toasts.push({ kind: 'ok', text: '已加入时间线' });
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  }
}

async function updateClip(id: string, patchData: Partial<TimelineClip>) {
  await patch(`/api/timeline/clips/${id}`, patchData);
  await load();
}

async function removeClip(id: string) {
  await del(`/api/timeline/clips/${id}`);
  if (activeClipId.value === id) activeClipId.value = null;
  await load();
}

// --- drag reorder -------------------------------------------------------------
function onDragStart(c: TimelineClip) {
  dragId.value = c.id;
}

function onDragOver(e: DragEvent, c: TimelineClip) {
  e.preventDefault();
  dropTargetId.value = c.id;
}

async function onDropClip(e: DragEvent, target: TimelineClip) {
  e.preventDefault();
  const from = dragId.value;
  dropTargetId.value = null;
  dragId.value = null;
  if (!from || from === target.id) return;
  const ids = clips.value.map((c) => c.id);
  const fromIdx = ids.indexOf(from);
  const toIdx = ids.indexOf(target.id);
  ids.splice(fromIdx, 1);
  ids.splice(toIdx, 0, from);
  await post('/api/timeline/clips/reorder', { ids });
  await load();
}

// --- trim via player ----------------------------------------------------------
function markTrim(which: 'in' | 'out') {
  const c = activeClip.value;
  const t = trimPlayer.value?.currentTime();
  if (!c || t == null) return;
  const full = takeDuration.value.get(c.takeId) ?? 0;
  if (which === 'in') {
    const clamped = Math.max(0, Math.min(t, (c.trimOut ?? full) - 0.1));
    void updateClip(c.id, { trimIn: Math.round(clamped * 10) / 10 });
  } else {
    const clamped = Math.min(full, Math.max(t, c.trimIn + 0.1));
    void updateClip(c.id, { trimOut: Math.round(clamped * 10) / 10 });
  }
}

async function exportTimeline() {
  exportJob.value = { id: '', status: 'running' };
  const res = await post<{ jobId: string }>('/api/timeline/export', {});
  exportJob.value = { id: res.jobId, status: 'running', result: undefined, error: null };
  toasts.push({ kind: 'info', text: `导出任务 ${res.jobId} 已启动（后台运行）` });
  void pollExport(res.jobId);
}

async function pollExport(jobId: string) {
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const job = await get<{ status: string; progress?: number | null; result?: { relPath?: string; url?: string }; error?: string | null }>(`/api/jobs/${jobId}`);
    exportJob.value = { id: jobId, ...job };
    if (job.status === 'done') {
      playUrl.value = job.result?.url ?? '';
      toasts.push({ kind: 'ok', text: `导出完成：${job.result?.relPath}` });
      return;
    }
    if (job.status === 'failed') {
      toasts.push({ kind: 'err', text: `导出失败：${job.error}` });
      return;
    }
  }
}

let off: (() => void) | null = null;
onMounted(async () => {
  await load();
  off = subscribeEvents((e) => {
    if (e.type === 'take.selected' || e.type === 'project.updated') void load();
  });
});
onUnmounted(() => off?.());
</script>

<template>
  <div class="page">
    <div class="spread">
      <h1>Timeline <span class="muted">{{ clips.length }} clips · {{ totalSeconds.toFixed(1) }}s</span></h1>
      <button class="primary" :disabled="!clips.length || exportJob?.status === 'running'" @click="exportTimeline">
        {{ exportJob?.status === 'running' ? '导出中…' : 'Export（ffmpeg）' }}
      </button>
    </div>

    <div v-if="exportJob && exportJob.status === 'running'" class="panel progress-panel">
      <div class="panel-title">导出中… {{ exportJob.progress != null ? Math.round(exportJob.progress * 100) + '%' : '' }}</div>
      <div class="progress-track">
        <div class="progress-fill" :style="{ width: `${Math.round((exportJob.progress ?? 0) * 100)}%` }"></div>
      </div>
    </div>

    <!-- visual strip -->
    <div class="panel strip-panel filmstrip">
      <div class="strip" v-if="clips.length">
        <div
          v-for="(c, i) in clips"
          :key="c.id"
          class="strip-clip"
          :class="{ active: activeClipId === c.id, 'drop-target': dropTargetId === c.id }"
          :style="{ width: `${clipWidth(c)}px` }"
          draggable="true"
          @dragstart="onDragStart(c)"
          @dragover="onDragOver($event, c)"
          @drop="onDropClip($event, c)"
          @click="activeClipId = c.id"
        >
          <img v-if="takePoster.get(c.takeId)" :src="fileUrl(takePoster.get(c.takeId)!)" class="strip-poster" :alt="c.takeId" draggable="false" />
          <div class="strip-shade" />
          <div class="strip-meta">
            <span class="strip-idx mono">{{ String(i + 1).padStart(2, '0') }}</span>
            <span class="strip-dur mono">{{ clipDuration(c).toFixed(1) }}s</span>
          </div>
          <div v-if="c.transition !== 'cut' && c.transition !== 'none' && i > 0" class="strip-trans" :title="`转场：${c.transition}`">◧</div>
        </div>
        <div class="strip-end mono muted">{{ totalSeconds.toFixed(1) }}s</div>
      </div>
      <EmptyState
        v-else
        icon="▤"
        title="时间线为空"
        desc="只接受 Selected Take（PRD §33）。先在 Shot 里选片，再从下方把镜头加入时间线。"
      />
    </div>

    <!-- trim editor for active clip -->
    <div v-if="activeClip" class="panel trim-panel">
      <div class="panel-title spread">
        <span>修剪 Clip <span class="mono">{{ activeClip.takeId }}</span>（shot {{ activeClip.shotId }}）</span>
        <button class="sm ghost" @click="activeClipId = null">关闭</button>
      </div>
      <div class="panel-body trim-body">
        <div class="trim-player">
          <VideoPlayer ref="trimPlayer" :src="takeVideoUrl(activeClip.takeId)" :max-height="300" />
        </div>
        <div class="col trim-controls">
          <div class="row">
            <button class="sm" title="把当前播放位置设为入点" @click="markTrim('in')">⇤ 设为入点</button>
            <button class="sm" title="把当前播放位置设为出点" @click="markTrim('out')">设为出点 ⇥</button>
          </div>
          <div class="row trim-io">
            <label class="muted">in</label>
            <input type="number" step="0.1" min="0" :value="activeClip.trimIn" class="trim-input" @change="updateClip(activeClip.id, { trimIn: Number(($event.target as HTMLInputElement).value) })" />
            <label class="muted">out</label>
            <input type="number" step="0.1" min="0" :value="activeClip.trimOut ?? undefined" class="trim-input" placeholder="尾" @change="updateClip(activeClip.id, { trimOut: Number(($event.target as HTMLInputElement).value) || null })" />
          </div>
          <div class="row">
            <label class="muted">转场</label>
            <select :value="activeClip.transition" @change="updateClip(activeClip.id, { transition: ($event.target as HTMLSelectElement).value as never })">
              <option value="cut">cut（硬切）</option>
              <option value="fade">fade（淡入淡出）</option>
              <option value="dissolve">dissolve（叠化）</option>
            </select>
          </div>
          <div class="muted">片段时长 {{ clipDuration(activeClip).toFixed(1) }}s · 原始 {{ (takeDuration.get(activeClip.takeId) ?? 0).toFixed(1) }}s</div>
          <button class="sm danger" @click="removeClip(activeClip.id)">从时间线移除</button>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-title">添加 Clip（只接受 Selected Take）</div>
      <div class="panel-body col">
        <div v-for="s in shotsWithTakes" :key="s.takeId" class="row add-row">
          <div class="add-thumb">
            <img v-if="s.poster" :src="fileUrl(s.poster)" :alt="s.shotTitle" />
            <span v-else class="muted">▧</span>
          </div>
          <span class="grow">{{ s.shotTitle }} · <span class="mono muted">{{ s.takeId }}</span> ({{ s.duration.toFixed(1) }}s)</span>
          <button class="sm" :disabled="clips.some((c) => c.takeId === s.takeId)" @click="addClip(s.shotId, s.takeId)">
            {{ clips.some((c) => c.takeId === s.takeId) ? '已在时间线' : '＋ 添加' }}
          </button>
        </div>
        <div v-if="!shotsWithTakes.length" class="muted">还没有 Selected Take。先到 Shot 里 Select。</div>
      </div>
    </div>

    <div v-if="playUrl" class="panel export-panel">
      <div class="panel-title">导出预览</div>
      <div class="panel-body">
        <VideoPlayer :src="playUrl" :label="playUrl" :max-height="480" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 24px 32px; max-width: 1280px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
h1 { font-size: 22px; margin: 0; font-family: var(--serif); }
.strip-panel { overflow-x: auto; }
.strip { display: flex; align-items: stretch; gap: 3px; padding: 20px 16px; min-height: 110px; }
.strip-clip {
  position: relative;
  flex: none;
  border-radius: 6px;
  overflow: hidden;
  background: var(--inset);
  border: 2px solid var(--line);
  cursor: grab;
  transition: border-color 0.15s, transform 0.15s;
}
.strip-clip:hover { transform: translateY(-2px); }
.strip-clip.active { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
.strip-clip.drop-target { border-color: var(--info); }
.strip-poster { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.strip-shade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,0.05) 40%, rgba(0,0,0,0.55)); }
.strip-meta { position: absolute; left: 6px; right: 6px; bottom: 5px; display: flex; justify-content: space-between; color: #fff; font-size: 10.5px; text-shadow: 0 1px 3px rgba(0,0,0,0.7); }
.strip-trans { position: absolute; top: 5px; left: 5px; color: #fff; font-size: 11px; text-shadow: 0 1px 3px rgba(0,0,0,0.7); }
.strip-end { align-self: center; padding-left: 8px; }
.trim-panel { border-color: var(--accent); }
.trim-body { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; }
@media (max-width: 900px) { .trim-body { grid-template-columns: 1fr; } }
.trim-controls { gap: 10px; align-content: start; }
.trim-io { gap: 6px; }
.trim-input { width: 72px; }
.add-row { padding: 5px 0; border-bottom: 1px dashed var(--line); }
.add-row:last-child { border-bottom: none; }
.add-thumb { width: 56px; height: 34px; border-radius: 5px; overflow: hidden; background: var(--inset); display: flex; align-items: center; justify-content: center; flex: none; }
.add-thumb img { width: 100%; height: 100%; object-fit: cover; }
.progress-panel { }
.progress-track { height: 6px; background: var(--inset); border-radius: 3px; margin: 10px 14px 14px; overflow: hidden; }
.progress-fill { height: 100%; background: linear-gradient(90deg, var(--accent-2), var(--accent-bright)); transition: width 0.4s; }
</style>
