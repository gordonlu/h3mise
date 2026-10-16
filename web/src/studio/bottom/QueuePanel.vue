<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { useRenderStore } from '../../stores/render';
import { useProjectStore } from '../../stores/project';
import { post } from '../../api/client';
import { t } from '../../stores/locale';

const render = useRenderStore();
const project = useProjectStore();
const route = useRoute();

const ACTIVE = new Set(['LOCAL_QUEUED', 'UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING']);
const jobs = computed(() => render.jobs.filter((job) => job.projectId === project.projectId));
const active = computed(() => jobs.value.filter((job) => ACTIVE.has(job.status)));
const recent = computed(() => jobs.value.filter((job) => !ACTIVE.has(job.status)).slice(0, 6));

async function cancel(jobId: string): Promise<void> {
  await post(`/api/render/${jobId}/cancel`);
  await render.refresh();
}

function locateShot(shotId: string): void {
  void route; // grouping by project already; keep navigation explicit via shot page
  window.location.hash = `#${shotId}`;
}

onMounted(() => { if (!render.loaded) void render.refresh(); });
</script>

<template>
  <div class="hf-dock-panel">
    <p v-if="jobs.length === 0" class="hf-muted">{{ t('studio.bottom.noJobs') }}</p>
    <template v-else>
      <div v-for="job in active" :key="job.id" class="hf-job">
        <span class="hf-dot s-rendering" />
        <span class="hf-job-title">{{ job.shotTitle || job.shotId }}</span>
        <span class="hf-chip">{{ job.status }}</span>
        <span class="hf-job-spacer" />
        <button class="hf-ghost" @click="cancel(job.id)">{{ t('common.cancel') }}</button>
      </div>
      <div v-for="job in recent" :key="job.id" class="hf-job">
        <span class="hf-dot" :class="job.status === 'LOCAL_READY' || job.status === 'SUCCEEDED' ? 's-done' : (job.status === 'FAILED' ? 's-review' : '')" />
        <span class="hf-job-title">{{ job.shotTitle || job.shotId }}</span>
        <span class="hf-chip">{{ job.status }}</span>
        <span class="hf-job-spacer" />
        <span v-if="job.cost?.credits" class="hf-chip">¥{{ job.cost.credits }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.hf-job { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--line); font-size: 12px; }
.hf-job-title { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hf-job-spacer { flex: 1; }
</style>
