<script setup lang="ts">
import { computed } from 'vue';
import type { NodeProps } from '@vue-flow/core';
import type { CanvasNode, StoryboardNodeData } from '@h3mise/shared';
import { mediaUrl } from '../../api/client';
import { t } from '../../stores/locale';
import BaseNode from './BaseNode.vue';
import { useNodeChrome } from './useNodeChrome';

const props = defineProps<NodeProps<{ node: CanvasNode }>>();
const { node, selected, lod } = useNodeChrome(props);
const data = computed(() => node.value.data as StoryboardNodeData);
</script>

<template>
  <BaseNode
    :node="node"
    :selected="selected"
    :lod="lod"
    icon="▥"
    :status="t('studio.storyboard.meta', { n: data.panelCount, status: data.status })"
  >
    <div class="hf-board-grid" :style="{ gridTemplateColumns: `repeat(${Math.min(3, data.panelCount)}, 1fr)` }">
      <div v-for="panel in data.panels" :key="panel.id" class="hf-board-cell">
        <img v-if="panel.assetId" :src="mediaUrl(panel.assetId)" loading="lazy" decoding="async" alt="" />
        <span v-else>{{ panel.order }}</span>
      </div>
    </div>
  </BaseNode>
</template>

<style scoped>
.hf-board-grid { display: grid; gap: 3px; }
.hf-board-cell { aspect-ratio: 16 / 10; border-radius: 4px; background: var(--bg-muted); display: grid; place-items: center; font-size: 10px; color: var(--text-3); overflow: hidden; }
.hf-board-cell img { width: 100%; height: 100%; object-fit: cover; }
</style>
