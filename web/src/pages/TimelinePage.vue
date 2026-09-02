<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { get, post, patch, del, takeVideoUrl, fileUrl, subscribeEvents } from '../api/client';
import { useToastStore } from '../stores/toast';
import { t } from '../stores/locale';
import type { FilmCheckResult, TimelineClip } from '@h3mise/shared';
import VideoPlayer from '../components/VideoPlayer.vue';
import EmptyState from '../components/EmptyState.vue';

interface ShotWithTake {
  shotId: string;
  shotTitle: string;
  takeId: string;
  duration: number;
  poster: string | null;
}

interface TimelineExport {
  id: string;
  relPath: string;
  durationSeconds: number;
  createdAt: string;
  url: string;
}

const toasts = useToastStore();
const clips = ref<TimelineClip[]>([]);
const shotsWithTakes = ref<ShotWithTake[]>([]);
const exportJob = ref<{ id: string; status: string; progress?: number | null; result?: { relPath?: string; url?: string }; error?: string | null } | null>(null);
const playUrl = ref('');
const exports = ref<TimelineExport[]>([]);
const activeClipId = ref<string | null>(null);
const trimPlayer = ref<InstanceType<typeof VideoPlayer> | null>(null);
const dragId = ref<string | null>(null);
const dropTargetId = ref<string | null>(null);
const filmCheck = ref<FilmCheckResult | null>(null);

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
const activeClipIndex = computed(() => clips.value.findIndex((c) => c.id === activeClipId.value));

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
  exports.value = await get<TimelineExport[]>('/api/timeline/exports');
  playUrl.value = exports.value[0]?.url ?? '';
  filmCheck.value = await get<FilmCheckResult>('/api/film-check');
}

async function addClip(shotId: string, takeId: string) {
  try {
    await post('/api/timeline/clips', { shotId, takeId });
    await load();
    toasts.push({ kind: 'ok', text: t('workflow.timeline.addedToTimeline') });
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  }
}

async function updateClip(id: string, patchData: Partial<TimelineClip>) {
  await patch(`/api/timeline/clips/${id}`, patchData);
  await load();
}

function changeTransition(c: TimelineClip, transition: TimelineClip['transition']) {
  const transitionDuration = transition === 'cut' || transition === 'none'
    ? 0
    : (c.transitionDuration > 0 ? c.transitionDuration : 0.5);
  void updateClip(c.id, { transition, transitionDuration });
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
  try {
    filmCheck.value = await get<FilmCheckResult>('/api/film-check');
    if (!filmCheck.value.canExport) {
      toasts.push({ kind: 'err', text: t('workflow.timeline.finalCheckFailedMessage', { message: filmCheck.value.errors[0]?.message ?? t('workflow.timeline.seeIssueList') }) });
      return;
    }
    exportJob.value = { id: '', status: 'running' };
    const res = await post<{ jobId: string }>('/api/timeline/export', {});
    exportJob.value = { id: res.jobId, status: 'running', result: undefined, error: null };
    toasts.push({ kind: 'info', text: t('workflow.timeline.exportJobValueStartedInTheBackground', { v0: res.jobId }) });
    void pollExport(res.jobId);
  } catch (error) {
    exportJob.value = null;
    toasts.push({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
  }
}

async function pollExport(jobId: string) {
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const job = await get<{ status: string; progress?: number | null; result?: { relPath?: string; url?: string }; error?: string | null }>(`/api/jobs/${jobId}`);
    exportJob.value = { id: jobId, ...job };
    if (job.status === 'done') {
      playUrl.value = job.result?.url ?? '';
      await load();
      toasts.push({ kind: 'ok', text: t('workflow.timeline.exportCompleteValue', { v0: job.result?.relPath }) });
      return;
    }
    if (job.status === 'failed') {
      toasts.push({ kind: 'err', text: t('workflow.timeline.exportFailedValue', { v0: job.error }) });
      return;
    }
  }
}

let off: (() => void) | null = null;
onMounted(async () => {
  await load();
  // Make the editing controls discoverable on first visit. Previously they
  // only appeared after clicking an unlabeled thumbnail in the filmstrip.
  if (clips.value.length) activeClipId.value = clips.value[0]!.id;
  off = subscribeEvents((e) => {
    if (e.type === 'take.selected' || e.type === 'project.updated') void load();
  });
});
onUnmounted(() => off?.());
</script>

<template>
  <div class="page">
    <div class="spread">
      <h1>{{ t('pages.timeline.title') }} <span class="muted">{{ t('pages.timeline.clipsCount', { n: clips.length, s: totalSeconds.toFixed(1) }) }}</span></h1>
      <button class="primary" :disabled="!clips.length || filmCheck?.canExport === false || exportJob?.status === 'running'" @click="exportTimeline">
        {{ exportJob?.status === 'running' ? t('pages.timeline.exporting') : t('pages.timeline.export') }}
      </button>
    </div>

    <div v-if="filmCheck && (filmCheck.errors.length || filmCheck.warnings.length)" class="panel film-check" :class="{ blocked: !filmCheck.canExport }">
      <div class="panel-title">{{ t('workflow.timeline.finalCheck') }} · {{ filmCheck.canExport ? t('workflow.timeline.readyToExport') : t('workflow.timeline.valueIssuesNeedAttention', { v0: filmCheck.errors.length }) }}</div>
      <p v-for="issue in [...filmCheck.errors, ...filmCheck.warnings]" :key="issue.code + issue.message">{{ issue.severity === 'error' ? t('workflow.timeline.blocker') : t('workflow.timeline.notice') }}：{{ issue.message }}</p>
    </div>

    <div v-if="exportJob && exportJob.status === 'running'" class="panel progress-panel">
      <div class="panel-title">{{ t('workflow.timeline.exporting') }} {{ exportJob.progress != null ? Math.round(exportJob.progress * 100) + '%' : '' }}</div>
      <div class="progress-track">
        <div class="progress-fill" :style="{ width: `${Math.round((exportJob.progress ?? 0) * 100)}%` }"></div>
      </div>
    </div>

    <!-- visual strip -->
    <div class="panel strip-panel filmstrip">
      <div v-if="clips.length" class="strip-guide">
        <div>
          <strong>{{ t('workflow.timeline.selectAClipToTrimOrChange') }}</strong>
          <span>{{ t('workflow.timeline.dragClipsToReorderThem') }}</span>
        </div>
        <span class="muted">{{ t('workflow.timeline.selectedClipValue', { v0: activeClipIndex + 1 }) }}</span>
      </div>
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
          <div v-if="c.transition !== 'cut' && c.transition !== 'none' && i > 0" class="strip-trans" :title="t('workflow.timeline.transitionValue', { v0: c.transition })">◧</div>
          <button
            type="button"
            class="strip-edit"
            :class="{ current: activeClipId === c.id }"
            :aria-label="t('workflow.timeline.trimAndTransitionClipValue', { v0: i + 1 })"
            :title="t('workflow.timeline.openTrimAndTransition')"
            @click.stop="activeClipId = c.id"
          >
            <span aria-hidden="true">✂</span>
            {{ activeClipId === c.id ? t('workflow.timeline.editing') : t('workflow.timeline.edit') }}
          </button>
        </div>
        <div class="strip-end mono muted">{{ totalSeconds.toFixed(1) }}s</div>
      </div>
      <EmptyState
        v-else
        icon="▤"
        :title="t('workflow.timeline.timelineIsEmpty')"
        :desc="t('workflow.timeline.onlySelectedTakesCanBeUsedSelect')"
      />
    </div>

    <!-- trim editor for active clip -->
    <div v-if="activeClip" class="panel trim-panel">
      <div class="panel-title spread">
        <span>{{ t('workflow.timeline.trimTransitionClipValue', { v0: activeClipIndex + 1 }) }}</span>
        <button class="sm ghost" @click="activeClipId = null">{{ t('common.close') }}</button>
      </div>
      <div class="panel-body trim-body">
        <div class="trim-player">
          <VideoPlayer
            ref="trimPlayer"
            :src="takeVideoUrl(activeClip.takeId)"
            :poster="takePoster.get(activeClip.takeId) ? fileUrl(takePoster.get(activeClip.takeId)!) : undefined"
            preload="auto"
            :max-height="300"
          />
        </div>
        <div class="col trim-controls">
          <div class="control-help">
            {{ t('workflow.timeline.playTheVideoAndMarkInAnd') }}
          </div>
          <div class="row">
            <button class="sm" :title="t('workflow.timeline.setTheCurrentPlayheadAsIn')" @click="markTrim('in')">⇤ {{ t('workflow.timeline.setIn') }}</button>
            <button class="sm" :title="t('workflow.timeline.setTheCurrentPlayheadAsOut')" @click="markTrim('out')">{{ t('workflow.timeline.setOut') }} ⇥</button>
          </div>
          <div class="row trim-io">
            <label class="muted">in</label>
            <input type="number" step="0.1" min="0" :value="activeClip.trimIn" class="trim-input" placeholder="0" @change="updateClip(activeClip.id, { trimIn: Number(($event.target as HTMLInputElement).value) })" />
            <label class="muted">out</label>
            <input type="number" step="0.1" min="0" :value="activeClip.trimOut ?? undefined" class="trim-input" :placeholder="t('workflow.timeline.end')" @change="updateClip(activeClip.id, { trimOut: Number(($event.target as HTMLInputElement).value) || null })" />
          </div>
          <div v-if="activeClipIndex > 0" class="row">
            <label class="muted">{{ t('workflow.timeline.transitionFromPreviousClip') }}</label>
            <select :value="activeClip.transition" @change="changeTransition(activeClip, ($event.target as HTMLSelectElement).value as TimelineClip['transition'])">
              <option value="cut">cut ({{ t('workflow.timeline.hardCut') }})</option>
              <option value="fade">fade ({{ t('workflow.timeline.fade') }})</option>
              <option value="dissolve">dissolve ({{ t('workflow.timeline.dissolve') }})</option>
            </select>
          </div>
          <div v-else class="first-clip-note">{{ t('workflow.timeline.thisIsTheFirstClipSoNo') }}</div>
          <label v-if="activeClipIndex > 0 && (activeClip.transition === 'fade' || activeClip.transition === 'dissolve')" class="row muted">
            {{ t('workflow.timeline.transitionDuration') }}
            <input
              type="number"
              class="trim-input"
              min="0.1"
              step="0.1"
              :value="activeClip.transitionDuration"
              @change="updateClip(activeClip.id, { transitionDuration: Number(($event.target as HTMLInputElement).value) })"
            /> {{ t('workflow.timeline.sec') }}
          </label>
          <div class="audio-controls">
            <div class="audio-title">{{ t('workflow.timeline.audio') }}</div>
            <label class="audio-option">
              <input
                type="checkbox"
                :checked="activeClip.audio.normalize"
                :disabled="activeClip.audio.mute"
                @change="updateClip(activeClip.id, { audio: { ...activeClip.audio, normalize: ($event.target as HTMLInputElement).checked } })"
              />
              <span><strong>{{ t('workflow.timeline.normalizeClipLoudnessRecommended') }}</strong><small>{{ t('workflow.timeline.normalizeTo16LUFSForDialogueOn') }}</small></span>
            </label>
            <label class="audio-option compact">
              <input
                type="checkbox"
                :checked="activeClip.audio.mute"
                @change="updateClip(activeClip.id, { audio: { ...activeClip.audio, mute: ($event.target as HTMLInputElement).checked } })"
              />
              {{ t('workflow.timeline.muteThisClip') }}
            </label>
            <label class="row muted">
              {{ t('workflow.timeline.manualVolume') }}
              <input
                type="range"
                min="0"
                max="2"
                step="0.05"
                :disabled="activeClip.audio.mute"
                :value="activeClip.audio.volume"
                @change="updateClip(activeClip.id, { audio: { ...activeClip.audio, volume: Number(($event.target as HTMLInputElement).value) } })"
              />
              <span class="mono volume-value">{{ Math.round(activeClip.audio.volume * 100) }}%</span>
            </label>
          </div>
          <div class="muted">{{ t('workflow.timeline.clipDuration') }} {{ clipDuration(activeClip).toFixed(1) }}s · {{ t('workflow.timeline.original') }} {{ (takeDuration.get(activeClip.takeId) ?? 0).toFixed(1) }}s</div>
          <button class="sm danger" @click="removeClip(activeClip.id)">{{ t('workflow.timeline.removeFromTimeline') }}</button>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-title">{{ t('workflow.timeline.addClipSelectedTakesOnly') }}</div>
      <div class="panel-body col">
        <div v-for="s in shotsWithTakes" :key="s.takeId" class="row add-row">
          <div class="add-thumb">
            <img v-if="s.poster" :src="fileUrl(s.poster)" :alt="s.shotTitle" />
            <span v-else class="muted">▧</span>
          </div>
          <span class="grow">{{ s.shotTitle }} · <span class="mono muted">{{ s.takeId }}</span> ({{ s.duration.toFixed(1) }}s)</span>
          <button class="sm" :disabled="clips.some((c) => c.takeId === s.takeId)" @click="addClip(s.shotId, s.takeId)">
            {{ clips.some((c) => c.takeId === s.takeId) ? t('workflow.timeline.onTimeline') : t('workflow.timeline.add') }}
          </button>
        </div>
        <div v-if="!shotsWithTakes.length" class="muted">{{ t('workflow.timeline.noSelectedTakesYetSelectOneIn') }}</div>
      </div>
    </div>

    <div v-if="playUrl" class="panel export-panel">
      <div class="panel-title">{{ t('workflow.timeline.exportPreview') }} <span v-if="exports[0]" class="muted mono">{{ exports[0].relPath }}</span></div>
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
.strip-guide { position: sticky; left: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px 0; }
.strip-guide > div { display: grid; gap: 2px; }
.strip-guide strong { font-size: 13px; }
.strip-guide span { color: var(--text-3); font-size: 11.5px; }
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
.strip-edit { position: absolute; top: 7px; right: 7px; display: inline-flex; align-items: center; gap: 4px; padding: 4px 7px; border: 1px solid rgba(255,255,255,.38); border-radius: 999px; background: rgba(25,22,20,.62); color: rgba(255,255,255,.92); box-shadow: 0 2px 8px rgba(0,0,0,.18); backdrop-filter: blur(6px); font-size: 10.5px; font-weight: 600; line-height: 1; white-space: nowrap; }
.strip-edit:hover, .strip-edit:focus-visible { background: rgba(25,22,20,.88); border-color: rgba(255,255,255,.72); transform: translateY(-1px); }
.strip-edit.current { background: var(--accent); border-color: var(--accent); color: #fff; box-shadow: 0 3px 10px rgba(209,89,45,.3); }
.strip-end { align-self: center; padding-left: 8px; }
.trim-panel { border-color: var(--accent); }
.trim-body { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; }
@media (max-width: 900px) { .trim-body { grid-template-columns: 1fr; } }
.trim-controls { gap: 10px; align-content: start; }
.control-help, .first-clip-note { padding: 9px 11px; border-radius: 6px; background: var(--bg-subtle); color: var(--text-2); font-size: 12px; line-height: 1.55; }
.first-clip-note { color: var(--text-3); }
.audio-controls { display: grid; gap: 9px; padding: 11px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg-subtle); }
.audio-title { font-size: 12px; font-weight: 700; }
.audio-option { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--text-2); }
.audio-option input { margin-top: 2px; }
.audio-option span { display: grid; gap: 2px; }
.audio-option small { color: var(--text-3); line-height: 1.45; }
.audio-option.compact { align-items: center; }
.volume-value { min-width: 42px; text-align: right; }
.trim-io { gap: 6px; }
.trim-input { width: 72px; }
.add-row { padding: 5px 0; border-bottom: 1px dashed var(--line); }
.add-row:last-child { border-bottom: none; }
.add-thumb { width: 56px; height: 34px; border-radius: 5px; overflow: hidden; background: var(--inset); display: flex; align-items: center; justify-content: center; flex: none; }
.add-thumb img { width: 100%; height: 100%; object-fit: cover; }
.progress-panel { }
.progress-track { height: 6px; background: var(--inset); border-radius: 3px; margin: 10px 14px 14px; overflow: hidden; }
.progress-fill { height: 100%; background: linear-gradient(90deg, var(--accent-2), var(--accent-bright)); transition: width 0.4s; }
.film-check { padding: 13px 16px; border-color: var(--warn); }.film-check.blocked { border-color: var(--bad); background: var(--bad-soft); }.film-check p { margin: 6px 0 0; color: var(--text-2); font-size: 12px; }
</style>
