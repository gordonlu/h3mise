<script setup lang="ts">
import { computed } from 'vue';
import type { NodeProps } from '@vue-flow/core';
import type { AnnotationNodeData, CanvasNode } from '@h3mise/shared';
import BaseNode from './BaseNode.vue';
import { useNodeChrome } from './useNodeChrome';

const props = defineProps<NodeProps<{ node: CanvasNode }>>();
const { node, selected, lod } = useNodeChrome(props);
const data = computed(() => node.value.data as AnnotationNodeData);
</script>

<template>
  <BaseNode :node="node" :selected="selected" :lod="lod" icon="note" status="">
    <div class="hf-note-text">{{ data.text || '…' }}</div>
  </BaseNode>
</template>

<style scoped>
.hf-note-text { font-size: 12px; line-height: 1.45; white-space: pre-wrap; color: inherit; }
</style>
