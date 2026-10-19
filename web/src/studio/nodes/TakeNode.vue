<script setup lang="ts">
import { computed } from 'vue';
import type { NodeProps } from '@vue-flow/core';
import type { CanvasNode, TakeNodeData } from '@h3mise/shared';
import { fileUrl } from '../../api/client';
import { t } from '../../stores/locale';
import BaseNode from './BaseNode.vue';
import { useNodeChrome } from './useNodeChrome';

const props = defineProps<NodeProps<{ node: CanvasNode }>>();
const { node, selected, lod } = useNodeChrome(props);
const data = computed(() => node.value.data as TakeNodeData);
const cover = computed(() => (data.value.posterPath ? fileUrl(data.value.posterPath) : null));
</script>

<template>
  <BaseNode :node="node" :selected="selected" :lod="lod" icon="take" :status="t('studio.take.selected')">
    <img v-if="cover" class="hf-thumb-sm" :src="cover" loading="lazy" decoding="async" :alt="node.title" />
    <div v-else class="hf-thumb-sm hf-take-empty" />
    <div class="hf-chips">
      <span class="hf-chip">{{ t('studio.media.duration', { n: Math.round(data.duration) }) }}</span>
      <span v-if="data.rating != null" class="hf-chip">★ {{ data.rating }}</span>
    </div>
  </BaseNode>
</template>

<style scoped>
.hf-take-empty { border: 1px dashed var(--line-2); }
</style>
