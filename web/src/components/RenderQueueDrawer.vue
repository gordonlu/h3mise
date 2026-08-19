<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useRenderStore } from '../stores/render';
import { post } from '../api/client';
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

async function cancel(job: RenderJob) {
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
              <span class="badge">{{ job.requestSnapshot?.mode?.toUpperCase() }}</span>
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
.drawer-body { flex: 1; overflow: auto; padding: 14px 18px; display: flex; flex-direction: column; gap: 10px; }
.job { padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.error { color: var(--bad); font-size: 11px; background: rgba(217, 99, 92, 0.08); padding: 6px; border-radius: 4px; }
</style>
