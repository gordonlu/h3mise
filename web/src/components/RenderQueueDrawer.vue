<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useRenderStore } from '../stores/render';
import { post } from '../api/client';
import { confirmDialog } from '../stores/confirm';
import { toast } from '../stores/toast';
import { H3_MODE_LABEL } from '@h3mise/shared';
import type { RenderJob } from '@h3mise/shared';

const render = useRenderStore();
const router = useRouter();

const STATUS_LABEL: Record<string, string> = {
  UPLOADING: '上传中', SUBMITTING: '提交中', QUEUED: '排队中', RUNNING: '生成中',
  SUCCEEDED: '成功', DOWNLOADING: '下载中', LOCAL_READY: '本地就绪',
  FAILED: '失败', CANCELLED: '已取消', EXPIRED: '过期',
};

const STATUS_BADGE: Record<string, string> = {
  UPLOADING: 'warn', SUBMITTING: 'warn', QUEUED: 'warn', RUNNING: 'warn', SUCCEEDED: 'ok', DOWNLOADING: 'info', LOCAL_READY: 'ok',
  FAILED: 'bad', CANCELLED: 'muted', EXPIRED: 'muted',
};

const active = computed(() => render.jobs.filter((j) => ['UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING'].includes(j.status)));
const done = computed(() => render.jobs.filter((j) => !['UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING'].includes(j.status)).slice(0, 30));
const queueGroups = computed(() => [
  { key: 'active', label: '进行中', jobs: active.value },
  { key: 'done', label: '最近完成', jobs: done.value },
].filter((group) => group.jobs.length > 0));

/** PRD §41 成本保护: 项目累计渲染消耗。CNY（consumeMoney）与 RH 币
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

function elapsedText(job: { startedAt: string | null; createdAt: string }): string {
  const start = job.startedAt ?? job.createdAt;
  const sec = Math.max(0, Math.floor((nowTick.value - new Date(start).getTime()) / 1000));
  const m = Math.floor(sec / 60);
  return m > 0 ? `${m}分${String(sec % 60).padStart(2, '0')}秒` : `${sec}秒`;
}

const CANCELLABLE = ['UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING'];

// P1: RunningHub has no remote cancel for AI App tasks — cancelling only
// stops local polling; the remote task may still run and cost money.
const cancelWarnsRemote = (job: RenderJob) => job.provider !== 'mock' && ['QUEUED', 'RUNNING'].includes(job.status);

async function cancel(job: RenderJob) {
  if (cancelWarnsRemote(job)) {
    const ok = await confirmDialog({
      title: '取消任务',
      message: 'RunningHub 无法远程取消任务。取消后本地将停止跟踪，但云端任务可能继续运行并产生费用。仍要取消吗？',
      confirmLabel: '仍要取消',
      danger: true,
    });
    if (!ok) return;
  }
  try {
    await post(`/api/render/${job.id}/cancel`);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), 'err');
    return;
  }
  await render.refresh();
}

async function retry(job: RenderJob) {
  try {
    await post(`/api/render/${job.id}/retry`);
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
  if (c.coins) parts.push(`${c.coins} RH币`);
  return parts.join(' + ');
}

onMounted(() => render.refresh());
</script>

<template>
  <div class="backdrop" @click.self="$emit('close')">
    <div class="drawer">
      <div class="drawer-head">
        <div class="head-copy">
          <h2>渲染队列</h2>
          <span class="muted">{{ active.length }} 个进行中 · {{ done.length }} 个已结束</span>
        </div>
        <button class="ghost close-btn" aria-label="关闭渲染队列" @click="$emit('close')">✕</button>
      </div>
      <div v-if="totals.has" class="cost-bar">
        <span v-if="totals.cny" class="badge warn">累计消耗 ≈¥{{ totals.cny.toFixed(2) }} CNY</span>
        <span v-if="totals.coins" class="badge warn">累计消耗 {{ Number(totals.coins.toFixed(2)) }} RH币</span>
        <span class="muted">（RunningHub usage 回传）</span>
      </div>

      <div class="drawer-body">
        <div v-if="!render.jobs.length" class="muted">队列为空。</div>

        <section v-for="group in queueGroups" :key="group.key" class="queue-section">
          <div class="section-label">{{ group.label }} <span>{{ group.jobs.length }}</span></div>
          <article v-for="job in group.jobs" :key="job.id" class="job panel">
            <div class="job-head">
              <span :class="['badge', STATUS_BADGE[job.status]]">{{ STATUS_LABEL[job.status] }}</span>
              <span class="mono muted job-id" :title="job.id">{{ job.id }}</span>
            </div>
            <div class="job-meta muted">
              <button class="shot-link" @click="router.push(`/shots/${job.shotId}`)">镜头 {{ job.shotId }}</button>
              <span class="badge no-dot mode-badge">{{ H3_MODE_LABEL[job.requestSnapshot?.mode ?? 't2va'] }}</span>
              <span v-if="active.includes(job)" class="badge no-dot elapsed">⏱ {{ elapsedText(job) }}</span>
              <span v-if="costText(job)" class="cost-text">{{ costText(job) }}</span>
            </div>
            <div v-if="job.providerTaskId" class="task-ref">
              <span>服务任务</span>
              <code :title="job.providerTaskId">{{ job.providerTaskId }}</code>
            </div>
            <div v-if="job.error" class="error mono">{{ job.error.slice(0, 400) }}</div>
            <div v-if="['FAILED', 'CANCELLED'].includes(job.status)" class="job-actions">
              <button v-if="job.providerTaskId" class="sm" title="重新查询原 RunningHub 任务，不会创建新的付费任务" @click="retry(job)">同步云端结果</button>
              <button v-else class="sm" @click="retry(job)">重新提交</button>
            </div>
            <div v-if="['UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING'].includes(job.status)" class="job-actions">
              <button class="sm danger" @click="cancel(job)">取消任务</button>
            </div>
          </article>
        </section>
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
</style>
