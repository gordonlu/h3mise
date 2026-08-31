// Render store: job list + queue drawer state, driven by SSE events.

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { get } from '../api/client';
import type { RenderJob } from '@h3mise/shared';

export const useRenderStore = defineStore('render', () => {
  const jobs = ref<RenderJob[]>([]);
  const drawerOpen = ref(false);
  const loaded = ref(false);

  async function refresh() {
    jobs.value = await get<RenderJob[]>('/api/render?scope=all');
    loaded.value = true;
  }

  function findJob(jobId: string, projectId?: string): RenderJob | undefined {
    return jobs.value.find((j) => j.id === jobId && (!projectId || j.projectId === projectId));
  }

  /** Handle a server event; returns true when jobs changed. */
  function onEvent(type: string, payload: Record<string, unknown>): boolean {
    const jobId = payload.jobId as string | undefined;
    if (!jobId) return false;
    const job = findJob(jobId, payload.projectId as string | undefined);
    switch (type) {
      case 'render.job.created':
      case 'render.job.queued':
      case 'render.job.running':
      case 'render.job.updated':
      case 'render.job.succeeded':
      case 'render.job.failed':
        void refresh();
        return true;
      default:
        return Boolean(job);
    }
  }

  return { jobs, drawerOpen, loaded, refresh, findJob, onEvent };
});
