<script setup lang="ts">
import { computed } from 'vue';
import type { NodeProps } from '@vue-flow/core';
import type { CanvasNode } from '@h3mise/shared';
import BaseNode from './BaseNode.vue';
import { useNodeChrome } from './useNodeChrome';

const props = defineProps<NodeProps<{ node: CanvasNode }>>();
const { node, selected, lod } = useNodeChrome(props);
const order = computed(() => (node.value.data as { order: number }).order);
</script>

<template>
  <BaseNode :node="node" :selected="selected" :lod="lod" icon="▦" :status="order ? `#${order}` : ''">
    <div />
  </BaseNode>
</template>
