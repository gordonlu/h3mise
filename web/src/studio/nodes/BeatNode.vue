<script setup lang="ts">
import { computed } from 'vue';
import type { NodeProps } from '@vue-flow/core';
import type { BeatNodeData, CanvasNode } from '@h3mise/shared';
import { t } from '../../stores/locale';
import BaseNode from './BaseNode.vue';
import { useNodeChrome } from './useNodeChrome';

const props = defineProps<NodeProps<{ node: CanvasNode }>>();
const { node, selected, lod } = useNodeChrome(props);
const data = computed(() => node.value.data as BeatNodeData);
</script>

<template>
  <BaseNode
    :node="node"
    :selected="selected"
    :lod="lod"
    icon="❖"
    :status="t('studio.beat.shots', { n: data.shotIds.length })"
  >
    <div class="hf-beat-meta">
      <span class="hf-chip">B{{ data.order }}</span>
      <span class="hf-chip">{{ data.durationSeconds }}s</span>
      <span class="hf-chip">{{ data.category }}</span>
    </div>
    <div v-if="data.location || data.timeOfDay || data.weather" class="hf-beat-sub">
      {{ [data.location, data.timeOfDay, data.weather].filter(Boolean).join(' · ') }}
    </div>
  </BaseNode>
</template>

<style scoped>
.hf-beat-meta { display: flex; flex-wrap: wrap; gap: 4px; }
.hf-beat-sub { margin-top: 6px; font-size: 11px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
