// Local layout undo/redo (positions, collapse). Domain mutations use the
// separate undo toast; this stack only reverses canvas layout.

import { ref } from 'vue';

export interface LayoutOp {
  undo: () => Promise<void> | void;
  redo: () => Promise<void> | void;
}

const MAX = 50;

export function useLayoutHistory() {
  const past = ref<LayoutOp[]>([]);
  const future = ref<LayoutOp[]>([]);

  function record(op: LayoutOp): void {
    past.value.push(op);
    if (past.value.length > MAX) past.value.shift();
    future.value = [];
  }

  async function undo(): Promise<void> {
    const op = past.value.pop();
    if (!op) return;
    await op.undo();
    future.value.push(op);
  }

  async function redo(): Promise<void> {
    const op = future.value.pop();
    if (!op) return;
    await op.redo();
    past.value.push(op);
  }

  return { record, undo, redo, canUndo: () => past.value.length > 0, canRedo: () => future.value.length > 0 };
}
