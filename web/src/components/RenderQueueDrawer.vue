<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useRenderStore } from '../stores/render';
import { post } from '../api/client';
import { confirmDialog } from '../stores/confirm';
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

/** PRD §41 成本保护: 项目累计渲染消耗（RunningHub usage 回传时累加）。 */
const totalCost = computed(() => {
  let credits = 0;
  let hasCost = false;
  for (const j of render.jobs) {
    const c = j.cost as { credits?: number } | null;
    if (c?.credits !== undefined && c.credits !== null) {
      credits += c.credits;
      hasCost = true;
    }
  }
  return hasCost ? credits : null;
});

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
  await post(`/api/render/${job.id}/cancel`);
  await render.refresh();
}

async function retry(job: RenderJob) {
  await post(`/api/render/${job.id}/retry`);
  await render.refresh();
}

function costText(job: RenderJob): string {
  if (!job.cost) return '';
  const c = job.cost as { credits?: number; unit?: string };
  return `¥${c.credits ?? 0}${c.unit ? ` ${c.unit}` : ''}`;
}

onMounted(() => render.refresh());
</script>

<template>
  <div class="backdrop" @click.self="$emit('close')">
    <div class="drawer">
      <div class="drawer-head">
        <h2>Render Queue <span class="muted">{{ active.length }} 活跃</span></h2>
        <button class="ghost" @click="$emit('close')">✕</button>
      </div>
      <div v-if="totalCost !== null" class="cost-bar">
        <span class="badge warn">项目累计消耗 ≈ {{ totalCost.toFixed(totalCost % 1 ? 2 : 0) }} <span v-if="totalCost % 1">CNY</span><span v-else>credits</span></span>
        <span class="muted">（RunningHub usage 回传）</span>
      </div>

      <div class="drawer-body">
        <div v-if="!render.jobs.length" class="muted">队列为空。</div>

        <template v-for="group in [active, done]" :key="group === active ? 'a' : 'b'">
          <div v-for="job in group" :key="job.id" class="job panel">
            <div class="spread">
              <span :class="['badge', STATUS_BADGE[job.status]]">{{ STATUS_LABEL[job.status] }}</span>
              <span class="mono muted">{{ job.id }}</span>
            </div>
            <div class="row wrap muted">
              <span class="badge" @click="router.push(`/shots/${job.shotId}`)" style="cursor: pointer">Shot {{ job.shotId }}</span>
              <span class="badge">{{ H3_MODE_LABEL[job.requestSnapshot?.mode ?? 't2va'] }}</span>
              <span v-if="job.providerTaskId" class="mono" :title="job.providerTaskId">{{ job.providerTaskId.slice(0, 16) }}…</span>
              <span v-if="costText(job)">{{ costText(job) }}</span>
            </div>
            <div v-if="job.error" class="error mono">{{ job.error.slice(0, 400) }}</div>
            <div v-if="['FAILED', 'CANCELLED'].includes(job.status)" class="row">
              <button v-if="job.status === 'FAILED'" class="sm" @click="retry(job)">Retry</button>
              <button v-else class="sm" @click="retry(job)">重新提交</button>
            </div>
            <div v-if="['UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING'].includes(job.status)" class="row">
              <button class="sm danger" @click="cancel(job)">Cancel</button>
            </div>
          </div>
        </template>
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
  width: 420px; max-width: 90vw; height: 100%;
  background: var(--bg-2); border-left: 1px solid var(--line);
  display: flex; flex-direction: column;
}
.drawer-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--line); }
.drawer-head h2 { margin: 0; font-size: 16px; }
.cost-bar { padding: 8px 18px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 8px; }
.drawer-body { flex: 1; overflow: auto; padding: 14px 18px; display: flex; flex-direction: column; gap: 10px; }
.job { padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.error { color: var(--bad); font-size: 11px; background: rgba(217, 99, 92, 0.08); padding: 6px; border-radius: 4px; }
</style>
