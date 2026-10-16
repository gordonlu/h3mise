// Quick-create menu: opened when a connection drag is released on empty
// canvas. Remembers the source handle so choosing an item can create a node and
// connect it in one step.

import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface QuickCreatePending {
  screen: { x: number; y: number };
  graph: { x: number; y: number };
  source: { nodeId: string; port: string };
}

export const useQuickCreateStore = defineStore('quickCreate', () => {
  const pending = ref<QuickCreatePending | null>(null);

  function open(screen: { x: number; y: number }, graph: { x: number; y: number }, source: { nodeId: string; port: string }): void {
    pending.value = { screen, graph, source };
  }

  function close(): void {
    pending.value = null;
  }

  return { pending, open, close };
});
