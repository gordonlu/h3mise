// In-page Studio navigation. Locating a node updates selection, opens the
// inspector, and asks the canvas to center it without reloading the graph.
// Classic links fall back to the router when they have no Studio equivalent.

import { useRouter } from 'vue-router';
import { useStudioStore } from '../stores/studio';
import { useStudioUiStore } from '../stores/studioUi';
import { toStudioLink, type StudioTarget } from '../studio/links';

export function useStudioNavigate() {
  const router = useRouter();
  const store = useStudioStore();
  const ui = useStudioUiStore();

  function revealNodeLane(nodeId: string): void {
    const node = store.nodeById.get(nodeId);
    if (!node || !store.hiddenLanes.includes(node.lane)) return;
    store.setHiddenLanes(store.hiddenLanes.filter((lane) => lane !== node.lane));
    void store.saveView();
  }

  function go(target: StudioTarget): void {
    if (target.dock) ui.openLeft(target.dock);
    if (target.bottom) ui.openBottom(target.bottom);
    if (target.node) {
      revealNodeLane(target.node);
      store.select(target.node);
      ui.inspectorOpen = true;
      if (target.tab) ui.requestSection(target.tab);
      store.focusNode(target.node);
    } else if (target.lane) {
      if (store.hiddenLanes.includes(target.lane)) {
        store.setHiddenLanes(store.hiddenLanes.filter((lane) => lane !== target.lane));
        void store.saveView();
      }
      store.focusLane(target.lane);
    }
  }

  function goShot(shotId: string, section?: string): void {
    go({ node: `shot:${shotId}`, tab: section });
  }

  /** Follow a classic page link (e.g. a production issue) inside Studio. */
  function goLegacy(to: string, category?: string): void {
    const target = toStudioLink(to, store.graph?.storyId ?? null, category);
    if (target) go(target);
    else void router.push(to);
  }

  return { go, goShot, goLegacy };
}
