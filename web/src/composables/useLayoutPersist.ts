// Debounced layout persistence. Dragging a node pins it and queues a per-node
// upsert; a burst becomes one PUT. The last pending write is also flushed with
// `keepalive` on unload so a quick navigation never loses the final position.

import { onScopeDispose } from 'vue';
import type { CanvasNodeId, CanvasNodeLayout, CanvasViewState } from '@h3mise/shared';
import { useStudioStore } from '../stores/studio';

export function useLayoutPersist() {
  const store = useStudioStore();
  const pending = new Map<CanvasNodeId, CanvasNodeLayout>();
  const removeIds = new Set<CanvasNodeId>();
  let pendingView: CanvasViewState | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, 400);
  }

  function queueNode(node: CanvasNodeLayout): void {
    pending.set(node.nodeId, node);
    removeIds.delete(node.nodeId);
    schedule();
  }

  function queueRemove(id: CanvasNodeId): void {
    pending.delete(id);
    removeIds.add(id);
    schedule();
  }

  function queueView(view: CanvasViewState): void {
    pendingView = view;
    schedule();
  }

  function hasPending(): boolean {
    return pending.size > 0 || removeIds.size > 0 || pendingView !== undefined;
  }

  function takeBody() {
    const storyId = store.graph?.storyId;
    if (!storyId) return null;
    // Viewport writes merge the latest lane/edge state at flush time so a
    // slower viewport PUT never restores stale lane visibility.
    const view = pendingView
      ? {
          ...(store.layout?.view ?? pendingView),
          viewport: pendingView.viewport,
          layoutMode: pendingView.layoutMode,
        }
      : undefined;
    const body = {
      storyId,
      nodes: [...pending.values()],
      removeNodeIds: [...removeIds],
      ...(view ? { view } : {}),
    };
    pending.clear();
    removeIds.clear();
    pendingView = undefined;
    return body;
  }

  async function flush(): Promise<void> {
    if (!hasPending()) return;
    const body = takeBody();
    if (!body) return;
    try {
      await store.saveLayout(body);
    } catch {
      /* next change retries; a dropped layout write is never fatal */
    }
  }

  function flushBeacon(): void {
    if (!hasPending()) return;
    const body = takeBody();
    if (!body) return;
    void fetch('/api/canvas/layout', {
      method: 'PUT',
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  if (typeof window !== 'undefined') window.addEventListener('beforeunload', flushBeacon);
  onScopeDispose(() => {
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', flushBeacon);
    void flush();
  });

  return { queueNode, queueRemove, queueView, flush };
}
