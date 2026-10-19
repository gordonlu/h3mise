// Keyboard port linking (P2 accessibility path). Focus an output port, press
// C, cycle the compatible input ports with the arrow keys, then Enter to run
// the same confirmed/undoable connection command as a drag.

import { nextTick } from 'vue';
import { useStudioStore } from '../stores/studio';
import { useConnect } from './useConnect';

/** Focus the Vue Flow handle DOM node for a (nodeId, portId) pair. */
export function focusKeyboardHandle(nodeId: string, port: string): boolean {
  const selector = `.vue-flow__handle[data-nodeid="${nodeId}"][data-handleid="${port}"]`;
  const element = [...document.querySelectorAll(selector)].find(
    (candidate): candidate is HTMLElement => candidate instanceof HTMLElement && candidate.getBoundingClientRect().width > 0,
  );
  if (!element) return false;
  element.focus();
  return document.activeElement === element;
}

export function useKeyboardConnect() {
  const store = useStudioStore();
  const connectApi = useConnect();

  function focusCurrent(): void {
    const state = store.keyboardConnect;
    if (!state) return;
    const target = state.targets[state.index];
    if (!target) return;
    const tryFocus = (attempt: number): void => {
      if (store.keyboardConnect?.index !== state.index) return;
      if (focusKeyboardHandle(target.nodeId, target.port)) return;
      if (attempt >= 2) return;
      // The target may be outside the rendered viewport. Center it first, then
      // retry after the 300ms viewport transition has rendered the node.
      store.focusNode(target.nodeId);
      setTimeout(() => tryFocus(attempt + 1), 450);
    };
    tryFocus(0);
  }

  async function move(delta: number): Promise<void> {
    store.moveKeyboardConnect(delta);
    await nextTick();
    focusCurrent();
  }

  async function confirm(): Promise<void> {
    const state = store.keyboardConnect;
    if (!state) return;
    const target = state.targets[state.index];
    if (!target) return;
    store.cancelKeyboardConnect();
    await connectApi.connect(state.sourceNodeId, state.sourcePort, target.nodeId, target.port);
  }

  function cancel(): void {
    store.cancelKeyboardConnect();
  }

  return { move, confirm, cancel, focusCurrent };
}
