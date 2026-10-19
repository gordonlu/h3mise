// Canvas node actions: the single main action per Shot node, mirroring the
// ShotWorkbench next-step logic. Free actions call existing endpoints; the
// render action is gated by usePaidAction.

import { useRouter } from 'vue-router';
import { H3_MODE_LABEL, type ShotNodeData } from '@h3mise/shared';
import { post } from '../api/client';
import { useStudioStore } from '../stores/studio';
import { useProjectStore } from '../stores/project';
import { useAiStore } from '../stores/ai';
import { useRenderStore } from '../stores/render';
import { useStudioUiStore } from '../stores/studioUi';
import { useToastStore } from '../stores/toast';
import { usePaidAction } from './usePaidAction';
import { t } from '../stores/locale';

export interface NodeAction {
  label: string;
  paid?: boolean;
  disabled?: boolean;
  run: () => Promise<void>;
}

export function useShotActions() {
  const store = useStudioStore();
  const project = useProjectStore();
  const ai = useAiStore();
  const render = useRenderStore();
  const ui = useStudioUiStore();
  const toasts = useToastStore();
  const router = useRouter();
  const paid = usePaidAction();

  function activeProvider() {
    const id = project.current?.config.default_provider ?? 'runninghub';
    return project.providers.find((provider) => provider.id === id) ?? null;
  }

  function mainAction(shotId: string, data: ShotNodeData): NodeAction {
    const provider = activeProvider();
    const providerId = provider?.id ?? 'runninghub';
    const mode = data.h3Mode ?? 't2va';

    if (data.activeJob) {
      return { label: t('studio.action.viewTask'), run: async () => { render.drawerOpen = true; } };
    }
    if (!data.hasPlan) {
      return {
        label: t('studio.action.plan'),
        run: async () => {
          await ai.runAction('plan_shot', { shotId, mode });
          await store.refreshGraph();
          toasts.push({ kind: 'ok', text: t('studio.action.planDone') });
        },
      };
    }
    if (!data.latestPromptVersionId) {
      return {
        label: t('studio.action.compile'),
        run: async () => {
          await post(`/api/shots/${shotId}/prompts/compile`, { mode });
          await store.refreshGraph();
        },
      };
    }
    if (!data.latestPreflight || data.latestPreflight.stale) {
      return {
        label: t('studio.action.preflight'),
        run: async () => {
          await post(`/api/shots/${shotId}/preflight`, {
            promptVersionId: data.latestPromptVersionId,
            providerId,
            megapixels: ui.megapixels,
          });
          await store.refreshGraph();
        },
      };
    }
    if (data.latestPreflight.blocked) {
      return { label: t('studio.action.blocked'), run: async () => { store.select(`shot:${shotId}`); } };
    }
    if (data.candidateCount > 0 && !data.selectedTakeId) {
      return { label: t('studio.action.select'), run: async () => { store.select(`shot:${shotId}`); } };
    }
    if (data.selectedTakeId) {
      return { label: t('studio.action.done'), disabled: true, run: async () => {} };
    }
    return {
      label: t('studio.action.render'),
      paid: true,
      run: async () => {
        const promptVersionId = data.latestPromptVersionId;
        if (!promptVersionId) return;
        await paid.confirm(
          {
            title: t('studio.action.renderTitle'),
            providerName: provider?.name ?? providerId,
            mock: providerId === 'mock',
            verification: provider?.verification?.status ?? null,
            target: shotId,
            mode: H3_MODE_LABEL[mode],
            durationSeconds: data.durationSeconds,
            aspectRatio: data.aspectRatio,
            megapixels: ui.megapixels,
            preflight: data.latestPreflight ? { blocked: data.latestPreflight.blocked, risk: data.latestPreflight.risk } : null,
            taskCount: 1,
          },
          async () => {
            const job = await post<{ id: string }>('/api/render', {
              shotId,
              promptVersionId,
              providerId,
              durationSeconds: data.durationSeconds,
              megapixels: ui.megapixels,
            });
            toasts.push({ kind: 'ok', text: t('studio.action.renderSubmitted', { id: job.id }) });
            await store.refreshGraph();
          },
        );
      },
    };
  }

  function openFullShot(shotId: string): void {
    void router.push(`/shots/${shotId}`);
  }

  return { mainAction, openFullShot };
}
