<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { del, fileUrl, get, post, takeVideoUrl } from '../api/client';
import { useToastStore } from '../stores/toast';
import VideoPlayer from '../components/VideoPlayer.vue';
import type { TimelineClip } from '@h3mise/shared';

interface QuickShot {
  id: string;
  order: number;
  title: string;
  durationSeconds: number;
  takeCount: number;
  selectedTakeId: string | null;
  cover: string | null;
}

interface TimelineExport {
  id: string;
  relPath: string;
  durationSeconds: number;
  createdAt: string;
  url: string;
}

interface ExportJob {
  id: string;
  status: string;
  progress?: number | null;
  result?: { relPath?: string; url?: string };
  error?: string | null;
}

const toasts = useToastStore();
const shots = ref<QuickShot[]>([]);
const clips = ref<TimelineClip[]>([]);
const exports = ref<TimelineExport[]>([]);
const loading = ref(true);
const busy = ref('');
const error = ref('');
const activeTakeId = ref<string | null>(null);
const exportJob = ref<ExportJob | null>(null);

const selectedShots = computed(() => shots.value.filter((shot) => shot.selectedTakeId));
const waitingShots = computed(() => shots.value.filter((shot) => !shot.selectedTakeId));
const clipShot = computed(() => new Map(shots.value.map((shot) => [shot.id, shot])));
const allSelectedOnTimeline = computed(() => selectedShots.value.every((shot) => clips.value.some((clip) => clip.shotId === shot.id)));
const latestExport = computed(() => exports.value[0] ?? null);
const previewUrl = computed(() => activeTakeId.value ? takeVideoUrl(activeTakeId.value) : latestExport.value?.url ?? '');
const previewPoster = computed(() => {
  if (!activeTakeId.value) return undefined;
  const cover = shots.value.find((shot) => shot.selectedTakeId === activeTakeId.value)?.cover;
  return cover ? fileUrl(cover) : undefined;
});

const currentStep = computed(() => {
  if (waitingShots.value.length || !shots.value.length) return 1;
  if (!clips.value.length || !allSelectedOnTimeline.value) return 2;
  if (!latestExport.value) return 3;
  return 4;
});

async function load() {
  error.value = '';
  try {
    const [shotList, timeline, exportList] = await Promise.all([
      get<QuickShot[]>('/api/shots'),
      get<{ clips: TimelineClip[] }>('/api/timeline'),
      get<TimelineExport[]>('/api/timeline/exports'),
    ]);
    shots.value = shotList;
    clips.value = timeline.clips;
    exports.value = exportList;
    if (activeTakeId.value && !clips.value.some((clip) => clip.takeId === activeTakeId.value)) activeTakeId.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function prepareTimeline() {
  busy.value = 'prepare';
  try {
    const result = await post<{ added: number }>('/api/timeline/quick-build', {});
    await load();
    toasts.push({ kind: 'ok', text: result.added ? `已把 ${result.added} 个片段放入成片` : '所有已选片段都在成片里' });
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  } finally {
    busy.value = '';
  }
}

async function moveClip(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= clips.value.length) return;
  const ids = clips.value.map((clip) => clip.id);
  [ids[index], ids[target]] = [ids[target]!, ids[index]!];
  busy.value = 'order';
  try {
    await post('/api/timeline/clips/reorder', { ids });
    await load();
  } finally {
    busy.value = '';
  }
}

async function removeClip(clip: TimelineClip) {
  busy.value = clip.id;
  try {
    await del(`/api/timeline/clips/${clip.id}`);
    await load();
    toasts.push({ kind: 'info', text: '已从成片移除，可随时重新加入' });
  } finally {
    busy.value = '';
  }
}

async function exportVideo() {
  busy.value = 'export';
  try {
    const started = await post<{ jobId: string }>('/api/timeline/export', {});
    exportJob.value = { id: started.jobId, status: 'running', progress: 0 };
    toasts.push({ kind: 'info', text: '正在合成长视频，可以留在此页查看进度' });
    for (let i = 0; i < 600; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const job = await get<Omit<ExportJob, 'id'>>(`/api/jobs/${started.jobId}`);
      exportJob.value = { id: started.jobId, ...job };
      if (job.status === 'done') {
        activeTakeId.value = null;
        await load();
        toasts.push({ kind: 'ok', text: '长视频制作完成' });
        return;
      }
      if (job.status === 'failed') throw new Error(job.error ?? '导出失败');
    }
    throw new Error('导出等待超时，任务可能仍在后台运行');
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  } finally {
    busy.value = '';
  }
}

onMounted(load);
</script>

<template>
  <div class="quick-page">
    <header class="quick-head">
      <div>
        <div class="eyebrow">新手路径</div>
        <h1>快速剪辑</h1>
        <p>选好每个镜头喜欢的片段，排一下顺序，然后生成长视频。</p>
      </div>
      <router-link to="/timeline" class="pro-link">专业微调：裁切、转场、声音 →</router-link>
    </header>

    <div class="same-data-note">快速剪辑和专业制作使用同一份项目。你可以随时来回切换，修改不会丢失。</div>

    <div class="steps" aria-label="快速剪辑进度">
      <div :class="['step', { done: currentStep > 1, current: currentStep === 1 }]">
        <span>1</span><div><strong>选好片段</strong><small>{{ selectedShots.length }} / {{ shots.length }} 个镜头</small></div>
      </div>
      <div :class="['step', { done: currentStep > 2, current: currentStep === 2 }]">
        <span>2</span><div><strong>排列顺序</strong><small>{{ clips.length }} 个片段</small></div>
      </div>
      <div :class="['step', { done: currentStep > 3, current: currentStep === 3 }]">
        <span>3</span><div><strong>生成长视频</strong><small>{{ latestExport ? '已经完成' : '等待开始' }}</small></div>
      </div>
    </div>

    <div v-if="error" class="panel error-card">{{ error }}</div>
    <div v-if="loading" class="panel loading-card">正在读取项目…</div>

    <template v-else>
      <section class="quick-section">
        <div class="section-head">
          <div><span class="section-number">1</span><h2>每个镜头选一个喜欢的片段</h2></div>
          <span :class="['status-pill', waitingShots.length ? 'waiting' : 'ready']">{{ waitingShots.length ? `还有 ${waitingShots.length} 个没选` : '全部选好了' }}</span>
        </div>
        <div v-if="!shots.length" class="empty-card">
          <strong>项目里还没有镜头</strong>
          <p>先进入专业制作添加或生成镜头，完成后再回来快速剪辑。</p>
          <router-link to="/shots" class="button-link primary-link">去添加镜头</router-link>
        </div>
        <div v-else class="shot-grid">
          <article v-for="shot in shots" :key="shot.id" :class="['shot-card', { ready: shot.selectedTakeId }]">
            <div class="shot-cover">
              <img v-if="shot.cover" :src="fileUrl(shot.cover)" :alt="shot.title" />
              <span v-else>{{ String(shot.order).padStart(2, '0') }}</span>
              <i>{{ shot.selectedTakeId ? '✓ 已选好' : shot.takeCount ? '等你选择' : '还没生成' }}</i>
            </div>
            <div class="shot-copy">
              <strong>{{ shot.title || `镜头 ${shot.order}` }}</strong>
              <small>{{ shot.durationSeconds }} 秒</small>
              <router-link v-if="!shot.selectedTakeId" :to="`/shots/${shot.id}#takes`" class="button-link">
                {{ shot.takeCount ? '去选择喜欢的片段' : '去生成片段' }}
              </router-link>
              <button v-else class="sm" @click="activeTakeId = shot.selectedTakeId">播放看看</button>
            </div>
          </article>
        </div>
      </section>

      <section class="quick-section">
        <div class="section-head">
          <div><span class="section-number">2</span><h2>把片段放进长视频</h2></div>
          <button class="primary" :disabled="busy !== '' || !selectedShots.length" @click="prepareTimeline">
            {{ busy === 'prepare' ? '正在准备…' : clips.length ? '补齐缺少的片段' : '自动按镜头顺序排列' }}
          </button>
        </div>
        <p class="section-help">这里只调整先后顺序。想裁掉一小段、添加转场或调声音，可以随时进入专业微调。</p>
        <div v-if="clips.length" class="clip-list">
          <article v-for="(clip, index) in clips" :key="clip.id" class="clip-row">
            <span class="clip-index">{{ index + 1 }}</span>
            <button class="clip-play" @click="activeTakeId = clip.takeId">▶</button>
            <div class="clip-name"><strong>{{ clipShot.get(clip.shotId)?.title ?? clip.shotId }}</strong><small>点击播放检查</small></div>
            <div class="clip-actions">
              <button class="sm" :disabled="index === 0 || busy !== ''" @click="moveClip(index, -1)">往前</button>
              <button class="sm" :disabled="index === clips.length - 1 || busy !== ''" @click="moveClip(index, 1)">往后</button>
              <button class="sm danger" :disabled="busy !== ''" @click="removeClip(clip)">移除</button>
            </div>
          </article>
        </div>
        <div v-else class="empty-card compact">选好片段后，点击“自动按镜头顺序排列”。</div>
      </section>

      <section v-if="previewUrl" class="quick-section preview-section">
        <div class="section-head">
          <div><span class="section-number">▶</span><h2>{{ activeTakeId ? '检查这个片段' : '最新长视频' }}</h2></div>
          <button v-if="activeTakeId" class="sm" @click="activeTakeId = null">关闭片段预览</button>
        </div>
        <VideoPlayer :src="previewUrl" :poster="previewPoster" preload="auto" :max-height="520" />
      </section>

      <section class="quick-section finish-section">
        <div class="section-head">
          <div><span class="section-number">3</span><h2>生成长视频</h2></div>
          <span v-if="latestExport" class="status-pill ready">✓ 已有成片</span>
        </div>
        <p class="section-help">这一步只合并本地片段，不会创建新的 AI 视频，也不会产生 RunningHub 费用。</p>
        <div v-if="exportJob?.status === 'running'" class="export-progress">
          <div><strong>正在制作…</strong><span>{{ Math.round((exportJob.progress ?? 0) * 100) }}%</span></div>
          <div class="progress-track"><i :style="{ width: `${Math.round((exportJob.progress ?? 0) * 100)}%` }" /></div>
        </div>
        <div class="finish-actions">
          <button class="primary big-action" :disabled="!clips.length || busy !== ''" @click="exportVideo">
            {{ busy === 'export' ? '正在制作长视频…' : latestExport ? '重新生成长视频' : '生成长视频' }}
          </button>
          <router-link to="/timeline" class="button-link">进入专业微调</router-link>
        </div>
        <div v-if="latestExport" class="latest-path">最近成片：<span class="mono">{{ latestExport.relPath }}</span></div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.quick-page { max-width: 1120px; margin: 0 auto; padding: 30px 32px 60px; display: flex; flex-direction: column; gap: 18px; }
.quick-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; }
.eyebrow { color: var(--accent-text); font-size: 11px; font-weight: 800; letter-spacing: .14em; }
h1 { margin: 3px 0 5px; font: 700 30px/1.15 var(--serif); }
.quick-head p, .section-help { margin: 0; color: var(--text-2); }
.pro-link { padding: 9px 13px; border: 1px solid var(--line); border-radius: var(--radius-sm); white-space: nowrap; }
.same-data-note { padding: 10px 14px; border-radius: var(--radius-sm); background: var(--accent-soft); border: 1px solid var(--accent-line); color: var(--accent-text); font-size: 13px; }
.steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.step { display: flex; align-items: center; gap: 10px; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--text-3); background: var(--bg-2); }
.step > span, .section-number { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: var(--inset); font: 700 12px var(--mono); flex: none; }
.step div { display: grid; gap: 2px; }.step small { font-size: 11px; }.step.current { border-color: var(--accent); color: var(--text); }.step.current > span, .step.done > span { color: white; background: var(--accent); }.step.done { color: var(--text-2); }
.quick-section { padding: 18px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-2); box-shadow: var(--shadow-1); }
.section-head, .section-head > div, .finish-actions, .export-progress > div:first-child { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.section-head > div { justify-content: flex-start; }.section-head h2 { margin: 0; font-size: 17px; }.section-help { margin: 9px 0 14px; font-size: 12.5px; }
.section-number { color: white; background: var(--accent); }
.status-pill { padding: 4px 9px; border-radius: 999px; font-size: 11.5px; font-weight: 700; }.status-pill.ready { color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); }.status-pill.waiting { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.shot-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 11px; margin-top: 14px; }
.shot-card { overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg); }.shot-card.ready { border-color: color-mix(in srgb, var(--ok) 40%, var(--line)); }
.shot-cover { height: 106px; position: relative; display: grid; place-items: center; background: var(--inset); color: var(--text-3); font: 700 18px var(--mono); overflow: hidden; }.shot-cover img { width: 100%; height: 100%; object-fit: cover; }.shot-cover i { position: absolute; right: 7px; top: 7px; padding: 3px 7px; border-radius: 999px; background: rgba(0,0,0,.7); color: white; font: normal 10px sans-serif; }
.shot-copy { padding: 10px; display: grid; gap: 7px; }.shot-copy small, .clip-name small { color: var(--text-3); }
.button-link { display: inline-flex; align-items: center; justify-content: center; padding: 7px 10px; border: 1px solid var(--line); border-radius: var(--radius-sm); font-size: 12px; }.primary-link { color: white; background: var(--accent); border-color: var(--accent); }
.clip-list { display: grid; gap: 7px; }.clip-row { display: flex; align-items: center; gap: 10px; padding: 9px; border: 1px solid var(--line); border-radius: var(--radius-sm); }.clip-index { width: 24px; color: var(--text-3); font: 700 12px var(--mono); text-align: center; }.clip-play { width: 34px; height: 34px; padding: 0; border-radius: 50%; }.clip-name { flex: 1; display: grid; gap: 2px; }.clip-actions { display: flex; gap: 5px; }
.empty-card { margin-top: 14px; padding: 24px; border: 1px dashed var(--line-2); border-radius: var(--radius-sm); text-align: center; }.empty-card p { color: var(--text-2); }.empty-card.compact { padding: 16px; color: var(--text-3); }
.preview-section { border-color: var(--accent-line); }.preview-section .player { margin-top: 14px; }
.finish-section { border-color: var(--accent-line); background: linear-gradient(135deg, var(--bg-2), var(--accent-soft)); }.finish-actions { justify-content: flex-start; margin-top: 14px; }.big-action { min-width: 190px; padding: 11px 18px; font-size: 14px; }.latest-path { margin-top: 12px; color: var(--text-2); font-size: 12px; }
.export-progress { margin-top: 14px; }.progress-track { height: 7px; overflow: hidden; margin-top: 7px; border-radius: 999px; background: var(--inset); }.progress-track i { display: block; height: 100%; background: var(--accent); transition: width .3s; }
.error-card { color: var(--bad); border-color: var(--bad); }.loading-card { padding: 30px; text-align: center; color: var(--text-2); }
@media (max-width: 760px) { .quick-page { padding: 20px 14px 40px; }.quick-head { align-items: flex-start; flex-direction: column; }.steps { grid-template-columns: 1fr; }.clip-actions { flex-wrap: wrap; justify-content: flex-end; }.clip-row { align-items: flex-start; }.section-head { align-items: flex-start; }.finish-actions { align-items: stretch; flex-direction: column; } }
</style>
