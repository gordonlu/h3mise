// Run-plan state: the "run to here" dependency chain and the node context menu.
// Presentation only — no domain data lives here.

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { AutoProducePlan } from '@h3mise/shared';

export type RunStage =
  | 'done'
  | 'needs_selection'
  | 'rendering'
  | 'needs_prompt'
  | 'needs_preflight'
  | 'waiting_dependency'
  | 'ready'
  | 'blocked';

export interface RunPlanItem {
  shotId: string;
  nodeId: string;
  title: string;
  order: number;
  stage: RunStage;
  promptVersionId: string | null;
}

export interface RunPlan {
  targetId: string;
  items: RunPlanItem[];
}

export const useRunPlanStore = defineStore('runPlan', () => {
  const plan = ref<RunPlan | null>(null);
  const autoPlan = ref<AutoProducePlan | null>(null);
  const contextMenu = ref<{ x: number; y: number; nodeId: string } | null>(null);

  const orderByNode = computed<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const item of plan.value?.items ?? []) map[item.nodeId] = item.order;
    return map;
  });

  const renderable = computed(() => plan.value?.items.filter((item) => item.stage === 'ready') ?? []);

  /** One-click auto-produce: order of the shots that will render. */
  const autoOrderByNode = computed<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    let index = 0;
    for (const shot of autoPlan.value?.shots ?? []) {
      if (!shot.willRender) continue;
      index += 1;
      map[`shot:${shot.shotId}`] = index;
    }
    return map;
  });

  const ghostBeats = computed(() => autoPlan.value?.storyPreparation.uncoveredBeatIds ?? []);

  function setPlan(next: RunPlan | null): void {
    plan.value = next;
    if (next) autoPlan.value = null;
  }

  function setAutoPlan(next: AutoProducePlan | null): void {
    autoPlan.value = next;
    if (next) plan.value = null;
  }

  function openMenu(x: number, y: number, nodeId: string): void {
    contextMenu.value = { x, y, nodeId };
  }

  function closeMenu(): void {
    contextMenu.value = null;
  }

  return { plan, autoPlan, contextMenu, orderByNode, autoOrderByNode, ghostBeats, renderable, setPlan, setAutoPlan, openMenu, closeMenu };
});
