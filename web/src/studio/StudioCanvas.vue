<script setup lang="ts">
import { computed, markRaw, onMounted, onUnmounted, watch } from 'vue';
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
import { useStudioStore } from '../stores/studio';
import { t } from '../stores/locale';
import { useLayoutPersist } from '../composables/useLayoutPersist';
import { useLayoutHistory } from '../composables/useLayoutHistory';
import { useGraphSync } from '../composables/useGraphSync';
import { useConnect } from '../composables/useConnect';
import { CREATE_MIME, useCanvasCreate, type CreateDescriptor } from '../composables/useCanvasCreate';
import { useRunPlanStore } from '../stores/runPlan';
import { useNoteEditorStore } from '../stores/noteEditor';
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
const { viewport, project } = useVueFlow();
const persist = useLayoutPersist();
const history = useLayoutHistory();
useGraphSync();
const { create } = useCanvasCreate();
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
    const next = zoom < 0.45 ? 'overview' : zoom > 0.9 ? 'detail' : 'card';
    if (store.lod !== next) store.setLod(next);
  },
);

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

function isValidConnection(connection: Connection): boolean {
  return connectApi.isValid(connection.source, connection.sourceHandle, connection.target, connection.targetHandle);
}

function onConnect(connection: Connection): void {
  void connectApi.connect(connection.source, connection.sourceHandle, connection.target, connection.targetHandle);
}

function onEdgeClick(event: EdgeMouseEvent): void {
  store.selectEdge(event.edge.id);
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) void history.redo();
    else void history.undo();
    return;
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && store.selectedEdgeId) {
    event.preventDefault();
    void connectApi.disconnect(store.selectedEdgeId);
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown));
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

function onDrop(event: DragEvent): void {
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
