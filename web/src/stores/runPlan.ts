// Run-plan state: the "run to here" dependency chain and the node context menu.
// Presentation only — no domain data lives here.

import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

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
  const contextMenu = ref<{ x: number; y: number; nodeId: string } | null>(null);

  const orderByNode = computed<Record<string, number>>(() => {
    const map: Record<string, number> = {};
    for (const item of plan.value?.items ?? []) map[item.nodeId] = item.order;
    return map;
  });

  const renderable = computed(() => plan.value?.items.filter((item) => item.stage === 'ready') ?? []);

  function setPlan(next: RunPlan | null): void {
    plan.value = next;
  }

  function openMenu(x: number, y: number, nodeId: string): void {
    contextMenu.value = { x, y, nodeId };
  }

  function closeMenu(): void {
    contextMenu.value = null;
  }

  return { plan, contextMenu, orderByNode, renderable, setPlan, openMenu, closeMenu };
});
