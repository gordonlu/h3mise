<script setup lang="ts">
import { H3_MODE_LABEL, type RenderJob } from '@h3mise/shared';
import { t } from '../../stores/locale';
import { CANCELLABLE, STATUS_BADGE, costText, elapsedText, isActive, statusLabel } from './jobDisplay';

defineProps<{
  groups: Array<{ key: string; label: string; jobs: RenderJob[] }>;
  now: number;
}>();

const emit = defineEmits<{
  'open-shot': [job: RenderJob];
  retry: [job: RenderJob];
  cancel: [job: RenderJob];
  theater: [key: string];
}>();
</script>

<template>
  <section v-for="group in groups" :key="group.key" class="queue-section">
    <div class="section-label">{{ group.label }} <span>{{ group.jobs.length }}</span></div>
    <article v-for="job in group.jobs" :key="`${job.projectId}/${job.id}`" class="job panel">
      <div class="job-head">
        <span :class="['badge', STATUS_BADGE[job.status]]">{{ statusLabel(job.status) }}</span>
        <span class="mono muted job-id" :title="job.id">{{ job.id }}</span>
      </div>
      <div class="job-meta muted">
        <button class="shot-link" @click="emit('open-shot', job)">{{ job.projectTitle || job.projectId }} · {{ job.shotTitle || job.shotId }}</button>
        <span class="badge no-dot mode-badge">{{ H3_MODE_LABEL[job.requestSnapshot?.mode ?? 't2va'] }}</span>
        <span v-if="job.status !== 'LOCAL_QUEUED'" class="badge no-dot elapsed">{{ isActive(job) ? t('queue.elapsedRunning') : t('queue.elapsedTook') }} {{ elapsedText(job, now) }}</span>
        <span v-if="costText(job)" class="cost-text">{{ costText(job) }}</span>
      </div>
      <div v-if="job.providerTaskId" class="task-ref">
        <span>{{ t('queue.taskRef') }}</span>
        <code :title="job.providerTaskId">{{ job.providerTaskId }}</code>
      </div>
      <div v-if="job.error" class="error mono">{{ job.error.slice(0, 400) }}</div>
      <div v-if="['FAILED', 'CANCELLED'].includes(job.status)" class="job-actions">
        <button v-if="job.providerTaskId" class="sm" :title="t('queue.syncHint')" @click="emit('retry', job)">{{ t('queue.syncCloud') }}</button>
        <button v-else class="sm" @click="emit('retry', job)">{{ t('queue.resubmit') }}</button>
      </div>
      <div v-if="CANCELLABLE.includes(job.status)" class="job-actions">
        <button class="sm" @click="emit('theater', `${job.projectId}/${job.id}`)">{{ t('queue.theater') }}</button>
        <button class="sm danger" @click="emit('cancel', job)">{{ t('queue.cancel') }}</button>
      </div>
    </article>
  </section>
</template>

<style scoped>
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
