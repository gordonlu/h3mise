// AI inference status + action runner.
//
// When an external agent is attached, UI-initiated actions are deferred to it
// (a pending ai_request that the agent picks up); otherwise they run as a
// built-in background job. Callers await one promise either way.

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { get, post } from '../api/client';
import type { AiActionResponse, AiAgentStatus, AiRequestDetail, AiRequestSummary } from '@h3mise/shared';

interface AiStatus {
  configured: boolean;
  baseUrl: string | null;
  model: string | null;
  agent: AiAgentStatus;
}

export interface AiRunOptions {
  /** Called once when a request takes unusually long (built-in jobs only). */
  onLongWait?: () => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const useAiStore = defineStore('ai', () => {
  const status = ref<AiStatus | null>(null);
  const pendingRequests = ref<AiRequestSummary[]>([]);
  const busy = ref(0);

  const agentAttached = computed(() => status.value?.agent?.attached === true);
  const agentLabel = computed(() => status.value?.agent?.modelLabel ?? null);
  const configured = computed(() => status.value?.configured === true);
  const pendingCount = computed(() => pendingRequests.value.length);

  async function refresh(): Promise<void> {
    // Fetch independently: a failing pending-list call (e.g. an older server
    // without the delegation routes) must not hide the inference status that
    // the brain indicator and Copilot AI section depend on.
    try {
      status.value = await get<AiStatus>('/api/ai/status');
    } catch {
      status.value = null;
    }
    try {
      pendingRequests.value = await get<AiRequestSummary[]>('/api/ai/requests?status=pending');
    } catch {
      pendingRequests.value = [];
    }
  }

  async function cancelRequest(id: string): Promise<void> {
    await post(`/api/ai/requests/${id}/cancel`);
    await refresh();
  }

  async function detachAgent(): Promise<void> {
    await fetch('/api/ai/agent/session', { method: 'DELETE' });
    await refresh();
  }

  /** Run an AI action end to end: deferred request polling or built-in job
   * polling, transparently. Throws on failure/timeout. */
  async function runAction<T>(action: string, body: Record<string, unknown> = {}, options: AiRunOptions = {}): Promise<{ result: T; deferred: boolean }> {
    busy.value++;
    try {
      const res = await post<AiActionResponse>(`/api/ai/actions/${action}`, body);
      if (res.deferred) {
        for (let i = 0; i < 240; i++) {
          await sleep(1500);
          const request = await get<AiRequestDetail>(`/api/ai/requests/${res.requestId}`);
          if (request.status === 'applied') {
            void refresh();
            return { result: request.result as T, deferred: true };
          }
          if (request.status === 'failed' || request.status === 'stale' || request.status === 'cancelled') {
            void refresh();
            throw new Error(request.error ?? request.status);
          }
        }
        throw new Error('等待外部 Agent 超时');
      }
      let longWaitNotified = false;
      for (let i = 0; i < 180; i++) {
        await sleep(1500);
        const job = await get<{ status: string; result: unknown; error: string | null }>(`/api/jobs/${res.jobId}`);
        if (job.status === 'done') return { result: job.result as T, deferred: false };
        if (job.status === 'failed') throw new Error(job.error ?? 'AI job failed');
        if (!longWaitNotified && (i + 1) * 1.5 >= 30) {
          longWaitNotified = true;
          options.onLongWait?.();
        }
      }
      throw new Error('AI job timeout');
    } finally {
      busy.value = Math.max(0, busy.value - 1);
    }
  }

  return { status, pendingRequests, busy, agentAttached, agentLabel, configured, pendingCount, refresh, cancelRequest, detachAgent, runAction };
});
