<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useRenderStore } from '../stores/render';
import { useProjectStore } from '../stores/project';
import { post } from '../api/client';
import { confirmDialog } from '../stores/confirm';
import { toast } from '../stores/toast';
import { t } from '../stores/locale';
import { H3_MODE_LABEL } from '@h3mise/shared';
import type { RenderJob } from '@h3mise/shared';

const render = useRenderStore();
const project = useProjectStore();
const router = useRouter();

const STATUS_KEY: Record<string, string> = {
  LOCAL_QUEUED: 'localQueued', UPLOADING: 'uploading', SUBMITTING: 'submitting', QUEUED: 'queued', RUNNING: 'running',
  SUCCEEDED: 'succeeded', DOWNLOADING: 'downloading', LOCAL_READY: 'localReady',
  FAILED: 'failed', CANCELLED: 'cancelled', EXPIRED: 'expired',
};

function statusLabel(status: string): string {
  return t(`queue.status.${STATUS_KEY[status] ?? 'unknown'}`, { status });
}

const STATUS_BADGE: Record<string, string> = {
  LOCAL_QUEUED: 'muted', UPLOADING: 'warn', SUBMITTING: 'warn', QUEUED: 'warn', RUNNING: 'warn', SUCCEEDED: 'ok', DOWNLOADING: 'info', LOCAL_READY: 'ok',
  FAILED: 'bad', CANCELLED: 'muted', EXPIRED: 'muted',
};

const ACTIVE = ['LOCAL_QUEUED', 'UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING'];
const active = computed(() => render.jobs.filter((j) => ACTIVE.includes(j.status)));
const done = computed(() => render.jobs.filter((j) => !ACTIVE.includes(j.status)).slice(0, 30));
const queueGroups = computed(() => [
  { key: 'active', label: t('queue.activeSection'), jobs: active.value },
  { key: 'done', label: t('queue.recent'), jobs: done.value },
].filter((group) => group.jobs.length > 0));

/** PRD §41 成本保护: 全部项目累计渲染消耗。CNY（consumeMoney）与 RH 币
 * （consumeCoins）分开累计——账户按任务只消耗其中一种。 */
const totals = computed(() => {
  let cny = 0;
  let coins = 0;
  let has = false;
  for (const j of render.jobs) {
    const c = j.cost as { credits?: number; coins?: number } | null;
    if (c?.credits) {
      cny += c.credits;
      has = true;
    }
    if (c?.coins) {
      coins += c.coins;
      has = true;
    }
  }
  return { cny, coins, has };
});

/** Elapsed-time ticker for in-flight jobs (1s resolution). */
const nowTick = ref(Date.now());
let ticker: number | undefined;
onMounted(() => {
  render.refresh();
  ticker = window.setInterval(() => (nowTick.value = Date.now()), 1000);
});
onUnmounted(() => window.clearInterval(ticker));

function formatSeconds(sec: number): string {
  const m = Math.floor(sec / 60);
  return m > 0 ? t('queue.durationMinutes', { m, s: String(sec % 60).padStart(2, '0') }) : t('queue.durationSeconds', { s: sec });
}

function elapsedText(job: RenderJob): string {
  const start = job.startedAt ?? job.submittedAt ?? job.createdAt;
  const end = active.value.includes(job)
    ? nowTick.value
    : new Date(job.finishedAt ?? job.updatedAt).getTime();
  const startMs = new Date(start).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(end)) return '—';
  return formatSeconds(Math.max(0, Math.floor((end - startMs) / 1000)));
}

const CANCELLABLE = ACTIVE;

/** Theater mode — a full-screen cinematic view of one job. Stores the key
 * (not the object) so SSE-driven refreshes keep the view current. */
const theaterKey = ref<string | null>(null);
const theaterJob = computed(() => render.jobs.find((j) => `${j.projectId}/${j.id}` === theaterKey.value) ?? null);

const STAGES = ['LOCAL_QUEUED', 'UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING', 'LOCAL_READY'] as const;
function stageState(job: RenderJob, stage: (typeof STAGES)[number]): 'done' | 'current' | 'todo' {
  const current = STAGES.indexOf(job.status as (typeof STAGES)[number]);
  if (current < 0) return job.status === 'SUCCEEDED' ? 'done' : 'todo';
  const target = STAGES.indexOf(stage);
  return target < current ? 'done' : target === current ? 'current' : 'todo';
}

// P1: RunningHub has no remote cancel for AI App tasks — cancelling only
// stops local polling; the remote task may still run and cost money.
const cancelWarnsRemote = (job: RenderJob) => job.provider !== 'mock' && ['QUEUED', 'RUNNING'].includes(job.status);

async function cancel(job: RenderJob) {
  if (cancelWarnsRemote(job)) {
    const ok = await confirmDialog({
      title: t('queue.cancel'),
      message: t('queue.cancelRemoteMessage'),
      confirmLabel: t('queue.cancelAnyway'),
      danger: true,
    });
    if (!ok) return;
  }
  try {
    await post(`/api/render/${job.id}/cancel?projectId=${encodeURIComponent(job.projectId)}`);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'err');
    return;
  }
  await render.refresh();
}

async function retry(job: RenderJob) {
  try {
    await post(`/api/render/${job.id}/retry?projectId=${encodeURIComponent(job.projectId)}`);
  } catch (e) {
    // e.g. "a render job for this exact intent is already active" (409)
    toast(e instanceof Error ? e.message : String(e), 'err');
    return;
  }
  await render.refresh();
}

function costText(job: RenderJob): string {
  if (!job.cost) return '';
  const c = job.cost as { credits?: number; coins?: number };
  const parts: string[] = [];
  if (c.credits) parts.push(`≈¥${Number(c.credits).toFixed(2)} CNY`);
  if (c.coins) parts.push(t('queue.coins', { n: c.coins }));
  return parts.join(' + ');
}

async function openShot(job: RenderJob) {
  if (job.projectId !== project.projectId) {
    if (!(await project.openProject(job.projectId))) return;
  }
  render.drawerOpen = false;
  await router.push(`/shots/${job.shotId}`);
}

onMounted(() => render.refresh());
</script>

<template>
  <div class="backdrop" @click.self="$emit('close')">
    <div class="drawer">
      <div class="drawer-head">
        <div class="head-copy">
          <h2>{{ t('queue.title') }}</h2>
          <span class="muted">{{ t('queue.summary', { active: active.length, done: done.length }) }}</span>
        </div>
        <button class="ghost close-btn" :aria-label="t('queue.title')" @click="$emit('close')">✕</button>
      </div>
      <div v-if="totals.has" class="cost-bar">
        <span v-if="totals.cny" class="badge warn">{{ t('queue.cumulativeCny', { amount: totals.cny.toFixed(2) }) }}</span>
        <span v-if="totals.coins" class="badge warn">{{ t('queue.cumulativeCoins', { amount: Number(totals.coins.toFixed(2)) }) }}</span>
        <span class="muted">{{ t('queue.usageNote') }}</span>
      </div>

      <div class="drawer-body">
        <div v-if="!render.jobs.length" class="muted">{{ t('queue.empty') }}</div>

        <section v-for="group in queueGroups" :key="group.key" class="queue-section">
          <div class="section-label">{{ group.label }} <span>{{ group.jobs.length }}</span></div>
          <article v-for="job in group.jobs" :key="`${job.projectId}/${job.id}`" class="job panel">
            <div class="job-head">
              <span :class="['badge', STATUS_BADGE[job.status]]">{{ statusLabel(job.status) }}</span>
              <span class="mono muted job-id" :title="job.id">{{ job.id }}</span>
            </div>
            <div class="job-meta muted">
              <button class="shot-link" @click="openShot(job)">{{ job.projectTitle || job.projectId }} · {{ job.shotTitle || job.shotId }}</button>
              <span class="badge no-dot mode-badge">{{ H3_MODE_LABEL[job.requestSnapshot?.mode ?? 't2va'] }}</span>
              <span v-if="job.status !== 'LOCAL_QUEUED'" class="badge no-dot elapsed">{{ active.includes(job) ? t('queue.elapsedRunning') : t('queue.elapsedTook') }} {{ elapsedText(job) }}</span>
              <span v-if="costText(job)" class="cost-text">{{ costText(job) }}</span>
            </div>
            <div v-if="job.providerTaskId" class="task-ref">
              <span>{{ t('queue.taskRef') }}</span>
              <code :title="job.providerTaskId">{{ job.providerTaskId }}</code>
            </div>
            <div v-if="job.error" class="error mono">{{ job.error.slice(0, 400) }}</div>
            <div v-if="['FAILED', 'CANCELLED'].includes(job.status)" class="job-actions">
              <button v-if="job.providerTaskId" class="sm" :title="t('queue.syncHint')" @click="retry(job)">{{ t('queue.syncCloud') }}</button>
              <button v-else class="sm" @click="retry(job)">{{ t('queue.resubmit') }}</button>
            </div>
            <div v-if="CANCELLABLE.includes(job.status)" class="job-actions">
              <button class="sm" @click="theaterKey = `${job.projectId}/${job.id}`">{{ t('queue.theater') }}</button>
              <button class="sm danger" @click="cancel(job)">{{ t('queue.cancel') }}</button>
            </div>
          </article>
        </section>
      </div>
    </div>

    <!-- Theater — full-screen view of one job; dark regardless of theme -->
    <div v-if="theaterJob" class="theater" @click.self="theaterKey = null">
      <div class="theater-card">
        <div class="theater-head">
          <span class="theater-status">{{ statusLabel(theaterJob.status) }}</span>
          <button class="ghost theater-close" :aria-label="t('common.close')" @click="theaterKey = null">✕</button>
        </div>
        <div class="theater-orb-wrap" :class="`is-${theaterJob.status}`">
          <span class="theater-orb" />
        </div>
        <h2 class="theater-title">{{ theaterJob.shotTitle || theaterJob.shotId }}</h2>
        <p class="theater-project">{{ theaterJob.projectTitle || theaterJob.projectId }}</p>
        <div class="theater-elapsed">
          <span class="counter">{{ elapsedText(theaterJob) }}</span>
          <span class="label">{{ active.includes(theaterJob) ? t('queue.elapsedRunning') : t('queue.elapsedTotal') }}</span>
        </div>
        <div class="theater-stages">
          <span v-for="stage in STAGES" :key="stage" class="stage" :class="stageState(theaterJob, stage)">
            <i />
            <em>{{ statusLabel(stage) }}</em>
          </span>
        </div>
        <div class="theater-stats">
          <div v-if="costText(theaterJob)" class="stat">
            <span class="k">{{ t('queue.costTotal') }}</span>
            <span class="v">{{ costText(theaterJob) }}</span>
          </div>
          <div v-if="theaterJob.providerTaskId" class="stat">
            <span class="k">{{ t('queue.taskRef') }}</span>
            <span class="v mono">{{ theaterJob.providerTaskId }}</span>
          </div>
          <div v-if="theaterJob.error" class="stat error-stat">
            <span class="k">{{ t('queue.error') }}</span>
            <span class="v">{{ theaterJob.error.slice(0, 300) }}</span>
          </div>
        </div>
        <div class="theater-actions">
          <button class="sm" @click="openShot(theaterJob)">{{ t('queue.openShot') }}</button>
          <button v-if="CANCELLABLE.includes(theaterJob.status)" class="sm danger" @click="cancel(theaterJob)">{{ t('queue.cancel') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5);
  display: flex; justify-content: flex-end; z-index: 50;
}
.drawer {
  width: 440px; max-width: calc(100vw - 48px); height: 100%; min-width: 0;
  background: var(--bg-2); border-left: 1px solid var(--line);
  display: flex; flex-direction: column;
}
.drawer-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--line); }
.head-copy { min-width: 0; }
.drawer-head h2 { margin: 0; font-size: 16px; }
.close-btn { flex: none; }
.cost-bar { padding: 8px 18px; border-bottom: 1px solid var(--line); display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; }
.cost-bar > * { max-width: 100%; }
.drawer-body { flex: 1; overflow: auto; padding: 14px 18px; display: flex; flex-direction: column; gap: 10px; }
.queue-section { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.section-label { display: flex; align-items: center; gap: 6px; color: var(--text-2); font-size: 12px; font-weight: 650; }
.section-label span { color: var(--text-3); font-weight: 500; }
.job { min-width: 0; padding: 12px; display: flex; flex-direction: column; gap: 9px; overflow: hidden; }
.job-head { min-width: 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.job-id { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.job-meta { min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.shot-link { min-width: 0; max-width: 100%; padding: 3px 8px; border-radius: 999px; font-size: 11px; color: var(--info); background: var(--info-soft); border-color: color-mix(in srgb, var(--info) 36%, transparent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mode-badge { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.cost-text { margin-left: auto; white-space: nowrap; }
.task-ref { min-width: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: center; gap: 8px; padding: 7px 9px; border-radius: 6px; background: var(--bg-subtle); color: var(--text-3); font-size: 11px; }
.task-ref code { min-width: 0; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
.error { min-width: 0; max-width: 100%; color: var(--bad); font-size: 11px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; background: rgba(217, 99, 92, 0.08); padding: 8px 9px; border-radius: 6px; }
.job-actions { display: flex; justify-content: flex-end; gap: 8px; }

/* --------------------------------------------------------------- theater */
.theater {
  position: fixed; inset: 0; z-index: 65;
  background: rgba(8, 9, 11, 0.86);
  backdrop-filter: blur(10px);
  display: flex; align-items: center; justify-content: center;
  animation: theater-in 0.2s;
}
.theater-card {
  width: 640px; max-width: calc(100vw - 48px);
  max-height: calc(100vh - 64px); overflow: auto;
  background: #0e1114; border: 1px solid #262d36; border-radius: 18px;
  padding: 24px 30px 22px; color: #eae7e0;
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6);
  text-align: center;
}
.theater-card button { background: #1f242d; border-color: #3d4653; color: #eae7e0; }
.theater-card button:hover { background: #2a313b; border-color: #4d5868; }
.theater-card button.danger { color: #e5736b; border-color: rgba(229, 115, 107, 0.5); background: none; }
.theater-head { display: flex; align-items: center; justify-content: space-between; }
.theater-status { font-size: 12px; font-weight: 700; letter-spacing: 0.08em; color: #ff9169; text-transform: uppercase; }
.theater-close { padding: 4px 10px; }
.theater-orb-wrap { padding: 18px 0 6px; }
.theater-orb {
  display: inline-block; width: 72px; height: 72px; border-radius: 50%;
  background: radial-gradient(circle at 50% 42%, rgba(255, 108, 55, 0.95), rgba(255, 108, 55, 0.10) 60%, transparent 72%);
  animation: pulse 1.6s ease-in-out infinite;
}
.theater-orb-wrap.is-LOCAL_READY .theater-orb,
.theater-orb-wrap.is-SUCCEEDED .theater-orb {
  animation: none;
  background: radial-gradient(circle at 50% 42%, rgba(76, 175, 125, 0.9), rgba(76, 175, 125, 0.10) 60%, transparent 72%);
}
.theater-orb-wrap.is-FAILED .theater-orb,
.theater-orb-wrap.is-CANCELLED .theater-orb,
.theater-orb-wrap.is-EXPIRED .theater-orb {
  animation: none;
  background: radial-gradient(circle at 50% 42%, rgba(229, 115, 107, 0.85), rgba(229, 115, 107, 0.10) 60%, transparent 72%);
}
.theater-title { margin: 6px 0 2px; font-size: 22px; font-weight: 680; letter-spacing: -0.02em; }
.theater-project { margin: 0 0 14px; color: #70767f; font-size: 12.5px; }
.theater-elapsed { display: flex; flex-direction: column; gap: 2px; margin-bottom: 18px; }
.theater-elapsed .counter { font-family: var(--mono); font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; }
.theater-elapsed .label { color: #70767f; font-size: 11px; }
.theater-stages { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin-bottom: 16px; }
.stage { display: flex; flex-direction: column; align-items: center; gap: 7px; min-width: 62px; color: #70767f; }
.stage i { width: 10px; height: 10px; border-radius: 50%; background: #2a313b; }
.stage.done i { background: #ff6c37; }
.stage.current i { background: #ff6c37; box-shadow: 0 0 0 5px rgba(255, 108, 55, 0.20); animation: pulse 1.3s ease-in-out infinite; }
.stage em { font-style: normal; font-size: 10.5px; }
.stage.done em { color: #a9aeb6; }
.stage.current em { color: #ff9169; font-weight: 650; }
.theater-stats { display: grid; gap: 7px; margin: 0 0 16px; }
.stat { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 10px; align-items: baseline; text-align: left; padding: 7px 11px; border-radius: 8px; background: #14171c; }
.stat .k { color: #70767f; font-size: 11px; }
.stat .v { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: #eae7e0; }
.error-stat .v { color: #e5736b; white-space: normal; }
.theater-actions { display: flex; justify-content: center; gap: 10px; }
@keyframes theater-in { from { opacity: 0; } }
</style>
