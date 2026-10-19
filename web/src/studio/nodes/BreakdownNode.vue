<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import type { NodeProps } from '@vue-flow/core';
import type { BreakdownNodeData, CanvasNode } from '@h3mise/shared';
import { fileUrl, mediaUrl } from '../../api/client';
import { t } from '../../stores/locale';
import BaseNode from './BaseNode.vue';
import { useNodeChrome } from './useNodeChrome';

const props = defineProps<NodeProps<{ node: CanvasNode }>>();
const { node, selected, lod } = useNodeChrome(props);
const router = useRouter();
const data = computed(() => node.value.data as BreakdownNodeData);
const thumb = computed(() => {
  if (data.value.posterPath) return fileUrl(data.value.posterPath);
  return data.value.mediaKind === 'audio' ? null : mediaUrl(data.value.mediaId);
});
const kindLabel = computed(() => t(`studio.kind.${data.value.mediaKind}`));
const status = computed(() =>
  `${t('studio.breakdown.segments', { n: data.value.segmentCount })} · ${data.value.hasAnalysis ? t('studio.breakdown.analyzed') : t('studio.breakdown.notAnalyzed')}`,
);

function open(): void {
  void router.push(`/assets/${encodeURIComponent(data.value.mediaId)}/breakdown`);
}
</script>

<template>
  <BaseNode :node="node" :selected="selected" :lod="lod" icon="breakdown" :status="status">
    <img v-if="thumb" class="hf-thumb-sm" :src="thumb" loading="lazy" decoding="async" :alt="node.title" />
    <div v-else class="hf-thumb-sm hf-audio" />
    <div class="hf-chips">
      <span class="hf-chip">{{ kindLabel }}</span>
      <span class="hf-chip">{{ t('studio.breakdown.frames', { n: data.frameCount }) }}</span>
      <span v-if="data.durationSeconds" class="hf-chip">{{ t('studio.media.duration', { n: Math.round(data.durationSeconds) }) }}</span>
    </div>
    <template #foot>
      <button class="hf-action nodrag nopan" @click.stop="open" @mousedown.stop>{{ t('studio.breakdown.open') }}</button>
    </template>
  </BaseNode>
</template>

<style scoped>
.hf-audio { background: repeating-linear-gradient(90deg, var(--warn) 0 2px, transparent 2px 6px); opacity: 0.5; }
</style>
