<script setup lang="ts">
import { computed, markRaw, nextTick, onMounted, onUnmounted, watch } from 'vue';
import {
  VueFlow,
  useVueFlow,
  type Connection,
  type Edge,
  type EdgeMouseEvent,
  type Node,
  type NodeDragEvent,
  type NodeMouseEvent,
  type ViewportTransform,
} from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { MiniMap } from '@vue-flow/minimap';
import { Controls } from '@vue-flow/controls';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/controls/dist/style.css';
import '@vue-flow/minimap/dist/style.css';
import './studio.css';
import type { CanvasLane, CanvasNode, MediaAsset, ShotNodeData } from '@h3mise/shared';
import { post } from '../api/client';
import { useStudioStore, type StudioFocusRequest } from '../stores/studio';
import { useStudioUiStore } from '../stores/studioUi';
import { usePaidActionStore } from '../stores/paidAction';
import { useToastStore } from '../stores/toast';
import { useConfirmStore } from '../stores/confirm';
import { useRolePickerStore } from '../stores/rolePicker';
import { t } from '../stores/locale';
import { useLayoutPersist } from '../composables/useLayoutPersist';
import { useLayoutHistory } from '../composables/useLayoutHistory';
import { useGraphSync } from '../composables/useGraphSync';
import { useConnect } from '../composables/useConnect';
import { useStudioShortcuts } from '../composables/useStudioShortcuts';
import { useShotActions } from '../composables/useShotActions';
import { useDuplicateShot } from '../composables/useDuplicateShot';
import { CREATE_MIME, useCanvasCreate, type CreateDescriptor } from '../composables/useCanvasCreate';
import { useRunPlanStore } from '../stores/runPlan';
import { useNoteEditorStore } from '../stores/noteEditor';
import { useQuickCreateStore } from '../stores/quickCreate';
import StoryNode from './nodes/StoryNode.vue';
import BeatNode from './nodes/BeatNode.vue';
import SequenceNode from './nodes/SequenceNode.vue';
import StoryboardNode from './nodes/StoryboardNode.vue';
import EntityNode from './nodes/EntityNode.vue';
import CharacterStateNode from './nodes/CharacterStateNode.vue';
import MediaNode from './nodes/MediaNode.vue';
import ShotNode from './nodes/ShotNode.vue';
import TakesNode from './nodes/TakesNode.vue';
import TimelineNode from './nodes/TimelineNode.vue';
import ExportNode from './nodes/ExportNode.vue';
import NoteNode from './nodes/NoteNode.vue';
import FrameNode from './nodes/FrameNode.vue';
import GhostNode from './nodes/GhostNode.vue';
import TypedEdge from './edges/TypedEdge.vue';

const store = useStudioStore();
const ui = useStudioUiStore();
const paid = usePaidActionStore();
const toasts = useToastStore();
const confirm = useConfirmStore();
const rolePicker = useRolePickerStore();
const { viewport, project, connectionStartHandle, fitView, zoomIn, zoomOut } = useVueFlow();
const persist = useLayoutPersist();
const history = useLayoutHistory();
useGraphSync();
const { create } = useCanvasCreate();
const { mainAction } = useShotActions();
const { duplicateSelected } = useDuplicateShot();
const runPlan = useRunPlanStore();
const noteEditor = useNoteEditorStore();

const nodeTypes = {
  story: markRaw(StoryNode),
  beat: markRaw(BeatNode),
  sequence: markRaw(SequenceNode),
  storyboard: markRaw(StoryboardNode),
  entity: markRaw(EntityNode),
  character_state: markRaw(CharacterStateNode),
  media: markRaw(MediaNode),
  shot: markRaw(ShotNode),
  takes: markRaw(TakesNode),
  timeline: markRaw(TimelineNode),
  export: markRaw(ExportNode),
  note: markRaw(NoteNode),
  frame: markRaw(FrameNode),
  ghost: markRaw(GhostNode),
};

const edgeTypes = { typed: markRaw(TypedEdge) };

const ghostNodes = computed(() =>
  runPlan.ghostBeats.map((beatId) => {
    const position = store.positions.get(`beat:${beatId}`) ?? { x: 0, y: 0 };
    return {
      id: `ghost:${beatId}`,
      type: 'ghost',
      position: { x: position.x + 320, y: position.y },
      data: { label: t('studio.auto.ghostLabel') },
      draggable: false,
      selectable: false,
    };
  }),
);
const canvasNodes = computed(() => [...store.flowNodes, ...ghostNodes.value] as unknown as Node[]);

watch(
  () => viewport.value.zoom,
  (zoom) => {
    // 0.05 hysteresis around 0.45 / 0.9 keeps LOD from flapping at the edge.
    const current = store.lod;
    let next = current;
    if (current === 'overview' && zoom >= 0.5) next = 'card';
    else if (current === 'card' && zoom < 0.4) next = 'overview';
    else if (current === 'card' && zoom > 0.95) next = 'detail';
    else if (current === 'detail' && zoom <= 0.85) next = 'card';
    if (next !== current) store.setLod(next);
  },
);

function laneNodeIds(lane: CanvasLane): string[] {
  return store.flowNodes
    .filter((item) => {
      const node = (item.data as { node?: CanvasNode }).node;
      return node?.lane === lane && !item.hidden;
    })
    .map((item) => item.id);
}

watch(
  () => store.focusRequest,
  (request) => void applyFocus(request),
  { deep: true, flush: 'post' },
);

async function applyFocus(request: StudioFocusRequest | null): Promise<void> {
  if (!request) return;
  await nextTick();
  if (request.kind === 'node') {
    if (!store.flowNodes.some((item) => item.id === request.value)) return;
    await fitView({ nodes: [request.value], padding: 0.45, duration: 300, maxZoom: 1.15 });
  } else if (request.kind === 'lane') {
    const ids = laneNodeIds(request.value);
    if (ids.length > 0) await fitView({ nodes: ids, padding: 0.2, duration: 300, maxZoom: 0.9 });
  } else if (request.kind === 'selection') {
    if (store.selection.length > 0) {
      await fitView({ nodes: [...store.selection], padding: 0.3, duration: 300, maxZoom: 1.15 });
    }
  } else {
    await fitView({ padding: 0.15, duration: 300 });
  }
}

function runSelected(): void {
  const node = store.selectedNode;
  if (!node || node.kind !== 'shot') return;
  const action = mainAction(node.domainId, node.data as ShotNodeData);
  if (!action.disabled) void action.run();
}

function escapeStudio(): void {
  if (paid.pending || confirm.pending) return;
  if (rolePicker.pending) {
    rolePicker.answer(null);
    return;
  }
  if (noteEditor.pending) {
    noteEditor.close();
    return;
  }
  if (quickCreate.pending) {
    quickCreate.close();
    return;
  }
  if (runPlan.contextMenu) {
    runPlan.closeMenu();
    return;
  }
  if (runPlan.plan || runPlan.autoPlan) {
    runPlan.setPlan(null);
    runPlan.setAutoPlan(null);
    return;
  }
  if (store.selectedEdgeId) {
    store.selectEdge(null);
    return;
  }
  store.clearSelection();
}

useStudioShortcuts({
  toggleLeftDock: ui.toggleLeft,
  toggleInspector: ui.toggleInspector,
  toggleBottomDock: ui.toggleBottom,
  zoomIn: () => void zoomIn({ duration: 120 }),
  zoomOut: () => void zoomOut({ duration: 120 }),
  fitAll: store.fitAll,
  fitSelection: store.fitSelection,
  escape: escapeStudio,
  runSelected,
});

function onNodeClick(event: NodeMouseEvent): void {
  const additive = event.event instanceof MouseEvent && (event.event.metaKey || event.event.ctrlKey);
  store.select(event.node.id, additive);
  runPlan.closeMenu();
}

function onNodeContext(event: NodeMouseEvent): void {
  const point = event.event as MouseEvent;
  runPlan.openMenu(point.clientX, point.clientY, event.node.id);
}

function onPaneClick(): void {
  store.clearSelection();
  runPlan.closeMenu();
}

function onNodeDblClick(event: NodeMouseEvent): void {
  const id = event.node.id;
  if (!id.startsWith('note:') && !id.startsWith('frame:')) return;
  const annotation = (store.layout?.annotations ?? []).find((item) => `${item.kind}:${item.id}` === id);
  if (annotation) void noteEditor.ask(annotation);
}

function onDragStop(event: NodeDragEvent): void {
  const before = event.nodes.map((node) => ({
    id: node.id,
    prev: { ...(store.positions.get(node.id) ?? { x: node.position.x, y: node.position.y }) },
    next: { x: node.position.x, y: node.position.y },
  }));
  for (const entry of before) {
    const record = store.setNodePosition(entry.id, entry.next.x, entry.next.y, true);
    persist.queueNode(record);
  }
  history.record({
    undo: async () => {
      for (const entry of before) persist.queueNode(store.setNodePosition(entry.id, entry.prev.x, entry.prev.y, true));
    },
    redo: async () => {
      for (const entry of before) persist.queueNode(store.setNodePosition(entry.id, entry.next.x, entry.next.y, true));
    },
  });
}

const connectApi = useConnect();
const quickCreate = useQuickCreateStore();
let connectedThisDrag = false;

function isValidConnection(connection: Connection): boolean {
  return connectApi.isValid(connection.source, connection.sourceHandle, connection.target, connection.targetHandle);
}

function onConnect(connection: Connection): void {
  connectedThisDrag = true;
  void connectApi.connect(connection.source, connection.sourceHandle, connection.target, connection.targetHandle);
}

function onConnectEnd(event: MouseEvent | TouchEvent | undefined): void {
  if (connectedThisDrag) {
    connectedThisDrag = false;
    return;
  }
  const start = connectionStartHandle.value;
  if (!start?.nodeId || !start.id) return;
  const point = event as MouseEvent | undefined;
  if (!point || typeof point.clientX !== 'number') return;
  quickCreate.open(
    { x: point.clientX, y: point.clientY },
    project({ x: point.clientX, y: point.clientY }),
    { nodeId: start.nodeId, port: String(start.id) },
  );
}

function onEdgeClick(event: EdgeMouseEvent): void {
  store.selectEdge(event.edge.id);
}

function onKeydown(event: KeyboardEvent): void {
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
  ) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) void history.redo();
    else void history.undo();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
    event.preventDefault();
    void duplicateSelected();
    return;
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && store.selectedEdgeId) {
    event.preventDefault();
    void connectApi.disconnect(store.selectedEdgeId);
  }
}
onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  await nextTick();
  if (store.focusRequest) await applyFocus(store.focusRequest);
});
onUnmounted(() => window.removeEventListener('keydown', onKeydown));

function onViewport(viewportTransform: ViewportTransform): void {
  const base = store.layout?.view;
  if (!base) return;
  const view = {
    ...base,
    viewport: { x: viewportTransform.x, y: viewportTransform.y, zoom: viewportTransform.zoom },
  };
  store.setView(view);
  persist.queueView(view);
}

function handleAt(clientX: number, clientY: number): { nodeId: string; port: string } | null {
  const element = document.elementFromPoint(clientX, clientY)?.closest('.vue-flow__handle') as HTMLElement | null;
  const nodeId = element?.getAttribute('data-nodeid');
  const port = element?.getAttribute('data-handleid');
  return nodeId && port ? { nodeId, port } : null;
}

async function importFiles(files: File[], position: { x: number; y: number }, target: { nodeId: string; port: string } | null): Promise<void> {
  const storyId = store.graph?.storyId;
  if (!storyId) return;
  for (const [index, file] of files.entries()) {
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/') && !file.type.startsWith('audio/')) {
      toasts.push({ kind: 'err', text: t('studio.create.unsupported', { name: file.name }) });
      continue;
    }
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('label', file.name);
      const asset = await post<MediaAsset>('/api/assets/media/upload', form);
      const nodeId = `media:${asset.id}`;
      await store.saveLayout({
        storyId,
        nodes: [{
          nodeId,
          x: position.x + index * 26,
          y: position.y + index * 26,
          collapsed: false,
          pinned: true,
          userPlaced: true,
        }],
      });
      await store.refreshGraph();
      const port = asset.kind === 'image' ? 'image' : asset.kind === 'video' ? 'video' : 'audio';
      if (target?.nodeId.startsWith('shot:')) {
        await connectApi.connect(nodeId, port, target.nodeId, target.port);
      } else {
        store.select(nodeId);
        store.focusNode(nodeId);
      }
      toasts.push({ kind: 'ok', text: t('studio.create.imported', { name: file.name }) });
    } catch (error) {
      toasts.push({ kind: 'err', text: t('studio.create.importFailed', { name: file.name, msg: error instanceof Error ? error.message : String(error) }) });
    }
  }
}

function onDrop(event: DragEvent): void {
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length > 0) {
    event.preventDefault();
    const position = project({ x: event.clientX, y: event.clientY });
    void importFiles(files, position, handleAt(event.clientX, event.clientY));
    return;
  }
  const raw = event.dataTransfer?.getData(CREATE_MIME);
  if (!raw) return;
  event.preventDefault();
  let descriptor: CreateDescriptor;
  try {
    descriptor = JSON.parse(raw) as CreateDescriptor;
  } catch {
    return;
  }
  const position = project({ x: event.clientX, y: event.clientY });
  void create(descriptor, position);
}
</script>

<template>
  <div class="hf-canvas-drop" @dragover.prevent @drop="onDrop">
    <VueFlow
    class="hf-vueflow"
    :nodes="canvasNodes"
    :edges="(store.flowEdges as unknown as Edge[])"
    :node-types="nodeTypes"
    :edge-types="edgeTypes"
    :only-render-visible-elements="true"
    :min-zoom="0.15"
    :max-zoom="2"
    :nodes-draggable="true"
    :nodes-connectable="true"
    :edges-updatable="false"
    :delete-key-code="null"
    :zoom-on-double-click="false"
    :fit-view-on-init="true"
    :pan-on-scroll="false"
    selection-key-code="Shift"
    :is-valid-connection="isValidConnection"
    @node-click="onNodeClick"
    @node-double-click="onNodeDblClick"
    @node-context-menu="onNodeContext"
    @node-drag-stop="onDragStop"
    @connect="onConnect"
    @connect-end="onConnectEnd"
    @edge-click="onEdgeClick"
    @viewport-change-end="onViewport"
    @pane-click="onPaneClick"
  >
    <Background :gap="24" :size="1.4" pattern-color="var(--line)" />
    <MiniMap pannable zoomable :node-color="() => 'var(--line-3)'" />
    <Controls />
  </VueFlow>
  </div>
</template>
