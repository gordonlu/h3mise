<script setup lang="ts">
import { computed } from 'vue';
import type { NodeProps } from '@vue-flow/core';
import type { CanvasNode, CharacterStateNodeData } from '@h3mise/shared';
import { mediaUrl } from '../../api/client';
import BaseNode from './BaseNode.vue';
import { useNodeChrome } from './useNodeChrome';

const props = defineProps<NodeProps<{ node: CanvasNode }>>();
const { node, selected, lod } = useNodeChrome(props);
const data = computed(() => node.value.data as CharacterStateNodeData);
</script>

<template>
  <BaseNode :node="node" :selected="selected" :lod="lod" icon="✦" status="">
    <img
      v-if="data.effectiveImageAssetId"
      class="hf-thumb-sm"
      :src="mediaUrl(data.effectiveImageAssetId)"
      loading="lazy"
      decoding="async"
      :alt="node.title"
    />
    <div v-else class="hf-thumb-sm hf-state-empty" />
  </BaseNode>
</template>

<style scoped>
.hf-state-empty { border: 1px dashed var(--line-2); }
</style>
