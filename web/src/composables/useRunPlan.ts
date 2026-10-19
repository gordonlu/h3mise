// "Run to here": walk a shot's frame-dependency chain upstream, classify each
// shot's stage, and (optionally) free-prepare all or paid-render the ready ones.

import { post } from '../api/client';
import { useStudioStore } from '../stores/studio';
import { useRunPlanStore, type RunPlanItem, type RunStage } from '../stores/runPlan';
import { useProjectStore } from '../stores/project';
import { useStudioUiStore } from '../stores/studioUi';
import { useToastStore } from '../stores/toast';
import { usePaidAction } from './usePaidAction';
import { t } from '../stores/locale';
import type { CanvasNode, ShotNodeData } from '@h3mise/shared';

export function useRunPlan() {
  const store = useStudioStore();
  const plan = useRunPlanStore();
  const project = useProjectStore();
  const ui = useStudioUiStore();
  const toasts = useToastStore();
  const paid = usePaidAction();

  function stageFor(node: CanvasNode): RunStage {
    const data = node.data as ShotNodeData;
    if (data.selectedTakeId) return 'done';
    if (data.activeJob) return 'rendering';
    if (data.candidateCount > 0) return 'needs_selection';
    if (!data.hasPlan || !data.latestPromptVersionId) return 'needs_prompt';
    if (!data.latestPreflight || data.latestPreflight.stale) return 'needs_preflight';
    if (!data.dependencyReady) return 'waiting_dependency';
    if (data.latestPreflight.blocked) return 'blocked';
    return 'ready';
  }

  function chainFor(targetShotId: string): CanvasNode[] {
    const nodes: CanvasNode[] = [];
    const seen = new Set<string>();
    let cursor: string | null = targetShotId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const node = store.nodeById.get(`shot:${cursor}`);
      if (!node) break;
      nodes.unshift(node);
      cursor = (node.data as ShotNodeData).dependsOnShotId;
    }
    return nodes;
  }

  function build(targetShotId: string): RunPlanItem[] {
    const items = chainFor(targetShotId)
      .filter((node) => stageFor(node) !== 'done')
      .map((node, index) => ({
        shotId: node.domainId,
        nodeId: node.id,
        title: node.title,
        order: index + 1,
        stage: stageFor(node),
        promptVersionId: (node.data as ShotNodeData).latestPromptVersionId,
      }));
    plan.setPlan({ targetId: targetShotId, items });
    return items;
  }

  function rebuild(): void {
    if (plan.plan) build(plan.plan.targetId);
  }

  async function prepareAll(): Promise<void> {
    const providerId = project.current?.config.default_provider ?? 'runninghub';
    await post('/api/render/batch/prepare', { providerId, megapixels: ui.megapixels });
    await store.refreshGraph();
    rebuild();
    toasts.push({ kind: 'ok', text: t('studio.runplan.prepared') });
  }

  async function renderAll(): Promise<void> {
    const ready = plan.renderable;
    if (ready.length === 0) return;
    const provider = project.providers.find((item) => item.id === (project.current?.config.default_provider ?? 'runninghub')) ?? null;
    const providerId = provider?.id ?? 'runninghub';
    await paid.confirm(
      {
        title: t('studio.runplan.renderTitle', { n: ready.length }),
        providerName: provider?.name ?? providerId,
        mock: providerId === 'mock',
        verification: provider?.verification?.status ?? null,
        target: ready.map((item) => item.title || item.shotId).join('、'),
        megapixels: ui.megapixels,
        taskCount: ready.length,
      },
      async () => {
        let submitted = 0;
        for (const item of ready) {
          if (!item.promptVersionId) continue;
          await post('/api/render', { shotId: item.shotId, promptVersionId: item.promptVersionId, providerId, megapixels: ui.megapixels });
          submitted++;
        }
        await store.refreshGraph();
        rebuild();
        toasts.push({ kind: 'ok', text: t('studio.runplan.submitted', { n: submitted }) });
      },
    );
  }

  return { build, rebuild, prepareAll, renderAll, stageFor };
}
