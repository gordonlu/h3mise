<script setup lang="ts">
import { computed } from 'vue';
import type { AppEvent } from '@h3mise/shared';
import { useActivityStore } from '../../stores/activity';
import { useStudioNavigate } from '../../composables/useStudioNavigate';
import { t } from '../../stores/locale';

const activity = useActivityStore();
const { goShot } = useStudioNavigate();

function shotIdOf(event: AppEvent): string | null {
  return 'shotId' in event && typeof event.shotId === 'string' ? event.shotId : null;
}

function label(event: AppEvent): string {
  switch (event.type) {
    case 'render.job.created': return t('studio.activity.renderCreated', { shot: event.shotId });
    case 'render.job.queued': return t('studio.activity.renderQueued', { shot: event.shotId });
    case 'render.job.running': return t('studio.activity.renderRunning', { shot: event.shotId });
    case 'render.job.updated': return t('studio.activity.renderUpdated', { shot: event.shotId, status: event.status });
    case 'render.job.succeeded': return t('studio.activity.renderSucceeded', { shot: event.shotId });
    case 'render.job.failed': return t('studio.activity.renderFailed', { shot: event.shotId, msg: event.error });
    case 'take.created': return t('studio.activity.takeCreated', { shot: event.shotId });
    case 'take.selected': return t('studio.activity.takeSelected', { shot: event.shotId });
    case 'continuity.committed': return t('studio.activity.continuity', { shot: event.shotId });
    case 'shot.updated': return t('studio.activity.shotUpdated', { shot: event.shotId });
    case 'project.updated': return t('studio.activity.projectUpdated');
    case 'auto.updated': return t('studio.activity.autoUpdated', { status: event.status });
    case 'job.updated': return t('studio.activity.jobUpdated', { kind: event.kind, status: event.status });
    case 'ai.request.created': return t('studio.activity.aiCreated', { action: event.action });
    case 'ai.request.applied': return t('studio.activity.aiApplied', { action: event.action });
    case 'ai.request.failed': return t('studio.activity.aiFailed', { action: event.action, msg: event.error });
    case 'ai.request.cancelled': return t('studio.activity.aiCancelled', { action: event.action });
  }
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

function open(event: AppEvent): void {
  const shotId = shotIdOf(event);
  if (shotId) goShot(shotId);
}

const rows = computed(() => activity.entries);
</script>

<template>
  <div class="hf-dock-panel">
    <div class="hf-dock-actions">
      <span class="hf-muted">{{ t('studio.activity.hint') }}</span>
      <span class="hf-bottom-spacer" />
      <button class="hf-ghost" :disabled="rows.length === 0" @click="activity.clear()">{{ t('studio.activity.clear') }}</button>
    </div>
    <p v-if="rows.length === 0" class="hf-muted">{{ t('studio.activity.empty') }}</p>
    <button
      v-for="row in rows"
      :key="row.id"
      class="hf-activity-row"
      :class="{ 'can-locate': shotIdOf(row.event) }"
      @click="open(row.event)"
    >
      <span class="hf-activity-time">{{ time(row.at) }}</span>
      <span class="hf-activity-type">{{ row.event.type }}</span>
      <span class="hf-activity-text">{{ label(row.event) }}</span>
    </button>
  </div>
</template>

<style scoped>
.hf-activity-row {
  display: flex; align-items: baseline; gap: 8px; width: 100%; padding: 5px 0;
  border: none; border-bottom: 1px solid var(--line); background: none; color: var(--text-2);
  font-size: 12px; text-align: left;
}
.hf-activity-row.can-locate { cursor: pointer; }
.hf-activity-row.can-locate:hover { background: var(--bg-muted); color: var(--text); }
.hf-activity-time { flex: none; width: 72px; font-family: var(--mono); font-size: 10px; color: var(--text-3); }
.hf-activity-type { flex: none; width: 150px; font-family: var(--mono); font-size: 10px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hf-activity-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
