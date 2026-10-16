// One-click auto-produce: fetch the plan, visualize it, and start it (paid
// provider gated by usePaidAction).

import type { AutoProducePlan } from '@h3mise/shared';
import { get, post } from '../api/client';
import { useStudioStore } from '../stores/studio';
import { useRunPlanStore } from '../stores/runPlan';
import { useToastStore } from '../stores/toast';
import { usePaidAction } from './usePaidAction';
import { t } from '../stores/locale';

export function useAutoProduce() {
  const store = useStudioStore();
  const runPlan = useRunPlanStore();
  const toasts = useToastStore();
  const paid = usePaidAction();

  async function open(): Promise<void> {
    const plan = await get<AutoProducePlan>('/api/auto-produce/plan');
    runPlan.setAutoPlan(plan);
  }

  async function start(): Promise<void> {
    const plan = runPlan.autoPlan;
    if (!plan) return;
    const provider = plan.providers.find((item) => item.id === plan.settings.providerId) ?? null;
    const run = async () => {
      await post('/api/auto-produce/start', {
        providerId: plan.settings.providerId,
        aspectRatio: plan.settings.aspectRatio,
        megapixels: plan.settings.megapixels,
        skipCompleted: true,
        confirmRealProvider: plan.settings.providerId !== 'mock',
      });
      runPlan.setAutoPlan(null);
      await store.load();
      toasts.push({ kind: 'ok', text: t('studio.auto.started') });
    };
    if (plan.settings.providerId === 'mock') {
      await run();
      return;
    }
    await paid.confirm(
      {
        title: t('studio.auto.confirmTitle'),
        providerName: provider?.name ?? plan.settings.providerId,
        mock: false,
        taskCount: plan.renderCount,
        megapixels: plan.settings.megapixels,
      },
      run,
    );
  }

  return { open, start };
}
