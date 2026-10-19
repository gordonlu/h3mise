<script setup lang="ts">
import { computed } from 'vue';
import type { NodeProps } from '@vue-flow/core';
import type { CanvasNode, StoryNodeData } from '@h3mise/shared';
import { t } from '../../stores/locale';
import BaseNode from './BaseNode.vue';
import { useNodeChrome } from './useNodeChrome';

const props = defineProps<NodeProps<{ node: CanvasNode }>>();
const { node, selected, lod } = useNodeChrome(props);
const data = computed(() => node.value.data as StoryNodeData);
const covered = computed(() => data.value.beatDurationSeconds * data.value.beatCount);
const progress = computed(() =>
  data.value.plannedDurationSeconds > 0
    ? Math.min(1, covered.value / data.value.plannedDurationSeconds)
    : 0,
);
</script>

<template>
  <BaseNode
    :node="node"
    :selected="selected"
    :lod="lod"
    icon="story"
    :status="t('studio.story.beats', { n: data.beatCount })"
  >
    <div class="hf-story-line">{{ data.synopsis || t('studio.unnamed') }}</div>
    <div class="hf-story-meta">
      <span>{{ data.plannedDurationSeconds }}s</span>
      <span>{{ covered }}s</span>
    </div>
    <div class="hf-progress"><span :style="{ width: `${Math.round(progress * 100)}%` }" /></div>
  </BaseNode>
</template>

<style scoped>
.hf-story-line { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.4; color: var(--text-2); }
.hf-story-meta { display: flex; gap: 8px; margin-top: 8px; font-size: 11px; color: var(--text-3); }
.hf-progress { margin-top: 6px; height: 5px; border-radius: 3px; background: var(--bg-muted); overflow: hidden; }
.hf-progress span { display: block; height: 100%; background: var(--accent); }
</style>
