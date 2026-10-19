<script setup lang="ts">
import { computed } from 'vue';
import type { NodeProps } from '@vue-flow/core';
import type { CanvasNode, TakesNodeData } from '@h3mise/shared';
import { fileUrl, takeVideoUrl } from '../../api/client';
import { t } from '../../stores/locale';
import BaseNode from './BaseNode.vue';
import HoverPreview from './HoverPreview.vue';
import { useNodeChrome } from './useNodeChrome';

const props = defineProps<NodeProps<{ node: CanvasNode }>>();
const { node, selected, lod } = useNodeChrome(props);
const data = computed(() => node.value.data as TakesNodeData);
const shown = computed(() => data.value.takes.slice(0, 4));
const candidateCount = computed(() => data.value.takes.filter((take) => take.status === 'candidate').length);
const status = computed(() =>
  data.value.takes.length === 0
    ? t('studio.takes.empty')
    : candidateCount.value > 0
      ? t('studio.takes.candidate', { n: candidateCount.value })
      : `${data.value.takes.length} Take`,
);
</script>

<template>
  <BaseNode :node="node" :selected="selected" :lod="lod" icon="takes" :status="status">
    <div class="hf-take-row">
      <div v-for="take in shown" :key="take.id" class="hf-take" :class="`t-${take.status}`">
        <HoverPreview
          :thumb="take.posterPath ? fileUrl(take.posterPath) : null"
          :video="takeVideoUrl(take.id)"
          :enabled="lod !== 'overview'"
          media-class="hf-take-media"
        />
      </div>
      <div v-if="data.takes.length > 4" class="hf-take-more">+{{ data.takes.length - 4 }}</div>
    </div>
  </BaseNode>
</template>

<style scoped>
.hf-take-row { display: flex; gap: 4px; align-items: center; }
.hf-take { width: 52px; height: 38px; border-radius: 5px; overflow: hidden; background: var(--bg-muted); border: 2px solid transparent; position: relative; }
.hf-take .hf-hover { height: 100%; }
.hf-take-media { width: 100%; height: 100%; object-fit: cover; display: block; }
.hf-take.t-selected { border-color: var(--ok); }
.hf-take.t-rejected { opacity: 0.45; }
.hf-take-more { font-size: 11px; color: var(--text-3); }
</style>
