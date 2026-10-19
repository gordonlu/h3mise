// One-click deterministic lane arrangement. Layout is local-only, so clearing
// pinned positions never touches story/shot/take data. The toast can restore
// the previous layout in one click.

import { useStudioStore } from '../stores/studio';
import { useToastStore } from '../stores/toast';
import { t } from '../stores/locale';

export function useArrangeLayout() {
  const store = useStudioStore();
  const toasts = useToastStore();

  async function arrange(): Promise<void> {
    const storyId = store.graph?.storyId;
    if (!storyId) return;
    const previous = (store.layout?.nodes ?? []).map((node) => ({ ...node }));
    const mediaNodes = previous.map((node) => node.nodeId).filter((id) => id.startsWith('media:'));
    await store.resetLayout();
    // Defensive cleanup: reset should remove all rows, but explicitly drop
    // media rows so an older/stale layout can never keep references on the right.
    if (mediaNodes.length > 0) {
      await store.saveLayout({ storyId, nodes: [], removeNodeIds: mediaNodes });
    }
    store.fitAll();
    toasts.push({
      kind: 'ok',
      text: t('studio.view.arranged'),
      actionLabel: t('studio.undo'),
      timeout: 8000,
      action: () => {
        void (async () => {
          if (previous.length > 0) await store.saveLayout({ storyId, nodes: previous });
          await store.load();
        })();
      },
    });
  }

  return { arrange };
}
