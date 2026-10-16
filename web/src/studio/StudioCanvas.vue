<script setup lang="ts">
import { markRaw, watch } from 'vue';
import { VueFlow, useVueFlow, type Edge, type Node, type NodeDragEvent, type NodeMouseEvent, type ViewportTransform } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { MiniMap } from '@vue-flow/minimap';
import { Controls } from '@vue-flow/controls';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import '@vue-flow/controls/dist/style.css';
import '@vue-flow/minimap/dist/style.css';
import './studio.css';
import { useStudioStore } from '../stores/studio';
import { useLayoutPersist } from '../composables/useLayoutPersist';
import { useGraphSync } from '../composables/useGraphSync';
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
import TypedEdge from './edges/TypedEdge.vue';

const store = useStudioStore();
const { viewport } = useVueFlow();
const persist = useLayoutPersist();
useGraphSync();

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
};

const edgeTypes = { typed: markRaw(TypedEdge) };

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
}

function onDragStop(event: NodeDragEvent): void {
  for (const node of event.nodes) {
    const record = store.setNodePosition(node.id, node.position.x, node.position.y, true);
    persist.queueNode(record);
  }
}

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
</script>

<template>
  <VueFlow
    class="hf-vueflow"
    :nodes="(store.flowNodes as unknown as Node[])"
    :edges="(store.flowEdges as unknown as Edge[])"
    :node-types="nodeTypes"
    :edge-types="edgeTypes"
    :only-render-visible-elements="true"
    :min-zoom="0.15"
    :max-zoom="2"
    :nodes-draggable="true"
    :nodes-connectable="false"
    :edges-updatable="false"
    :delete-key-code="null"
    :zoom-on-double-click="false"
    :fit-view-on-init="true"
    :pan-on-scroll="false"
    selection-key-code="Shift"
    @node-click="onNodeClick"
    @node-drag-stop="onDragStop"
    @viewport-change-end="onViewport"
    @pane-click="store.clearSelection()"
  >
    <Background :gap="24" :size="1.4" pattern-color="var(--line)" />
    <MiniMap pannable zoomable :node-color="() => 'var(--line-3)'" />
    <Controls />
  </VueFlow>
</template>
