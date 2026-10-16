// SSE bridge for the Studio canvas. Render lifecycle events patch a live
// per-shot job map for instant feedback; milestone events schedule a debounced
// ETag graph refresh so domain edits (from any tab or the Agent) appear here.

import { onScopeDispose } from 'vue';
import type { AppEvent } from '@h3mise/shared';
import { subscribeEvents } from '../api/client';
import { useStudioStore } from '../stores/studio';

export function useGraphSync(): void {
  const store = useStudioStore();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void store.refreshGraph();
    }, 300);
  }

  const off = subscribeEvents((event: AppEvent) => {
    switch (event.type) {
      case 'render.job.created':
      case 'render.job.queued':
      case 'render.job.running':
        store.setLiveJob(event.shotId, { jobId: event.jobId, status: event.type });
        if (event.type === 'render.job.created') schedule();
        break;
      case 'render.job.updated':
        store.setLiveJob(event.shotId, { jobId: event.jobId, status: event.status });
        break;
      case 'render.job.succeeded':
      case 'render.job.failed':
        store.setLiveJob(event.shotId, null);
        schedule();
        break;
      case 'take.created':
      case 'take.selected':
      case 'shot.updated':
      case 'continuity.committed':
      case 'project.updated':
      case 'auto.updated':
        schedule();
        break;
      case 'job.updated':
        if (event.status === 'done' || event.status === 'failed') schedule();
        break;
      case 'ai.request.created':
      case 'ai.request.applied':
      case 'ai.request.failed':
      case 'ai.request.cancelled':
        schedule();
        break;
      default:
        break;
    }
  });

  onScopeDispose(() => {
    off();
    if (timer) clearTimeout(timer);
  });
}
