// Storyboard node actions: prepare / paid page generation / per-panel paid
// regeneration / approve. Paid calls are gated by usePaidAction.

import { get, post } from '../api/client';
import { useStudioStore } from '../stores/studio';
import { useToastStore } from '../stores/toast';
import { usePaidAction } from './usePaidAction';
import { t } from '../stores/locale';
import type { ProviderVerification, StoryboardNodeData } from '@h3mise/shared';

interface StoryboardProfileSummary {
  region?: string | null;
  estimatedCostCny?: number | null;
  verification?: { status?: string | null } | null;
}

export interface StoryboardAction {
  label: string;
  paid?: boolean;
  disabled?: boolean;
  run: () => Promise<void>;
}

export function useStoryboardActions() {
  const store = useStudioStore();
  const toasts = useToastStore();
  const paid = usePaidAction();

  async function summary(title: string, target: string) {
    let profile: StoryboardProfileSummary | null = null;
    try {
      profile = await get<StoryboardProfileSummary>('/api/providers/runninghub/storyboard-profile');
    } catch {
      profile = null;
    }
    return {
      title,
      providerName: 'Storyboard 生图',
      providerRegion: profile?.region ?? null,
      mock: false,
      verification: (profile?.verification?.status ?? null) as ProviderVerification['status'] | null,
      target,
      estimatedCost: profile?.estimatedCostCny != null ? `¥${profile.estimatedCostCny}` : null,
      taskCount: 1,
    };
  }

  function mainAction(storyboardId: string, data: StoryboardNodeData): StoryboardAction {
    const target = `Page ${data.pageNumber}/${data.totalPages}`;
    if (data.activeJobId) {
      return { label: t('studio.storyboard.generating'), disabled: true, run: async () => {} };
    }
    if (data.status === 'approved') {
      return { label: t('studio.storyboard.approved'), disabled: true, run: async () => {} };
    }
    if (data.status === 'ready' || data.status === 'generating') {
      return {
        label: t('studio.storyboard.approve'),
        run: async () => {
          await post(`/api/storyboard/${storyboardId}/approve`, {});
          await store.refreshGraph();
          toasts.push({ kind: 'ok', text: t('studio.storyboard.approvedToast') });
        },
      };
    }
    // draft / failed → paid page generation.
    return {
      label: t('studio.storyboard.generate'),
      paid: true,
      run: async () => {
        await paid.confirm(await summary(t('studio.storyboard.generateTitle'), target), async () => {
          await post(`/api/storyboard/${storyboardId}/generate`, { confirmed: true });
          await store.refreshGraph();
          toasts.push({ kind: 'info', text: t('studio.storyboard.submitted') });
        });
      },
    };
  }

  async function regeneratePanel(storyboardId: string, panelId: string, order: number): Promise<void> {
    await paid.confirm(await summary(t('studio.storyboard.generateTitle'), `Panel ${order}`), async () => {
      await post(`/api/storyboard/${storyboardId}/panels/${panelId}/regenerate`, { confirmed: true });
      await store.refreshGraph();
      toasts.push({ kind: 'info', text: t('studio.storyboard.submitted') });
    });
  }

  return { mainAction, regeneratePanel };
}
