<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { get, post, patch, del, takeVideoUrl, subscribeEvents } from '../api/client';
import type { TimelineClip } from '@h3mise/shared';
import VideoPlayer from '../components/VideoPlayer.vue';

interface ShotWithTake {
  shotId: string;
  shotTitle: string;
  takeId: string;
  duration: number;
}

const clips = ref<TimelineClip[]>([]);
const shotsWithTakes = ref<ShotWithTake[]>([]);
const exportJob = ref<{ id: string; status: string; result?: { relPath?: string; url?: string }; error?: string | null } | null>(null);
const notice = ref('');
const playUrl = ref('');

async function load() {
  const tl = await get<{ id: string; clips: TimelineClip[] }>('/api/timeline');
  clips.value = tl.clips;
  const shots = await get<Array<{ id: string; title: string }>>('/api/shots');
  const takes = await Promise.all(
    shots.map(async (s) => {
      const det = await get<{ takes: Array<{ id: string; duration: number; status: string }> }>(`/api/shots/${s.id}`);
      const sel = det.takes.find((t) => t.status === 'selected');
      return sel ? { shotId: s.id, shotTitle: s.title, takeId: sel.id, duration: sel.duration } : null;
    }),
  );
  shotsWithTakes.value = takes.filter((t): t is ShotWithTake => t !== null);
}

async function addClip(shotId: string, takeId: string) {
  try {
    await post('/api/timeline/clips', { shotId, takeId });
    await load();
  } catch (e) {
    notice.value = e instanceof Error ? e.message : String(e);
  }
}

async function updateClip(id: string, patchData: Partial<TimelineClip>) {
  await patch(`/api/timeline/clips/${id}`, patchData);
  await load();
}

async function removeClip(id: string) {
  await del(`/api/timeline/clips/${id}`);
  await load();
}

async function moveClip(id: string, dir: -1 | 1) {
  const idx = clips.value.findIndex((c) => c.id === id);
  const target = idx + dir;
  if (target < 0 || target >= clips.value.length) return;
  const next = [...clips.value];
  [next[idx], next[target]] = [next[target]!, next[idx]!];
  await post('/api/timeline/clips/reorder', { ids: next.map((c) => c.id) });
  await load();
}

async function exportTimeline() {
  exportJob.value = { id: '', status: 'running' };
  const res = await post<{ jobId: string }>('/api/timeline/export', {});
  exportJob.value = { id: res.jobId, status: 'running', result: undefined, error: null };
  notice.value = `导出任务 ${res.jobId} 已启动（后台运行）`;
  void pollExport(res.jobId);
}

async function pollExport(jobId: string) {
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const job = await get<{ status: string; result?: { relPath?: string; url?: string }; error?: string | null }>(`/api/jobs/${jobId}`);
    exportJob.value = { id: jobId, ...job };
    if (job.status === 'done') {
      playUrl.value = job.result?.url ?? '';
      notice.value = `导出完成：${job.result?.relPath}`;
      return;
    }
    if (job.status === 'failed') {
      notice.value = `导出失败：${job.error}`;
      return;
    }
  }
}

const totalSeconds = computed(() => clips.value.reduce((acc, c) => acc + ((c.trimOut ?? c.trimIn + 5) - c.trimIn), 0));

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
      <div class="row">
        <button class="primary" :disabled="!clips.length || exportJob?.status === 'running'" @click="exportTimeline">
          {{ exportJob?.status === 'running' ? '导出中…' : 'Export（ffmpeg）' }}
        </button>
      </div>
    </div>
    <p v-if="notice" class="badge info">{{ notice }}</p>

    <div class="grid top">
      <div class="panel">
        <div class="panel-title">添加 Clip（只接受 Selected Take）</div>
        <div class="panel-body col">
          <div v-for="s in shotsWithTakes" :key="s.takeId" class="row add-row">
            <span class="grow">{{ s.shotTitle }} · {{ s.takeId }} ({{ s.duration.toFixed(1) }}s)</span>
            <button class="sm" :disabled="clips.some((c) => c.takeId === s.takeId)" @click="addClip(s.shotId, s.takeId)">
              {{ clips.some((c) => c.takeId === s.takeId) ? '已在时间线' : '＋ 添加' }}
            </button>
          </div>
          <div v-if="!shotsWithTakes.length" class="muted">还没有 Selected Take。先到 Shot 里 Select。</div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">时间线（Selected Takes 按序拼接）</div>
        <div class="panel-body col">
          <div v-for="(c, i) in clips" :key="c.id" class="clip panel">
            <div class="spread">
              <div class="row">
                <span class="mono muted">{{ String(i + 1).padStart(2, '0') }}</span>
                <span class="mono">{{ c.takeId }}</span>
                <span class="muted">shot {{ c.shotId }}</span>
              </div>
              <div class="row">
                <button class="sm ghost" @click="moveClip(c.id, -1)">↑</button>
                <button class="sm ghost" @click="moveClip(c.id, 1)">↓</button>
                <button class="sm danger" @click="removeClip(c.id)">删</button>
              </div>
            </div>
            <div class="row trim">
              <label class="muted">in</label>
              <input type="number" step="0.1" min="0" :value="c.trimIn" class="trim-input" @change="updateClip(c.id, { trimIn: Number(($event.target as HTMLInputElement).value) })" />
              <label class="muted">out</label>
              <input type="number" step="0.1" min="0" :value="c.trimOut ?? undefined" class="trim-input" placeholder="尾" @change="updateClip(c.id, { trimOut: Number(($event.target as HTMLInputElement).value) || null })" />
              <label class="muted">转场</label>
              <select :value="c.transition" @change="updateClip(c.id, { transition: ($event.target as HTMLSelectElement).value as never })">
                <option value="cut">cut</option>
                <option value="fade">fade</option>
                <option value="dissolve">dissolve</option>
              </select>
            </div>
          </div>
          <div v-if="!clips.length" class="muted">时间线为空。</div>
        </div>
      </div>
    </div>

    <div v-if="playUrl" class="panel export-panel">
      <div class="panel-title">导出预览</div>
      <div class="panel-body">
        <VideoPlayer :src="playUrl" :label="playUrl" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 24px 32px; max-width: 1200px; margin: 0 auto; }
h1 { font-size: 21px; margin: 0; }
.grid.top { grid-template-columns: 1fr 1.4fr; align-items: start; margin-top: 16px; }
.add-row { padding: 6px 0; }
.clip { padding: 8px 10px; }
.trim { gap: 6px; }
.trim-input { width: 64px; }
.export-panel { margin-top: 16px; }
</style>
