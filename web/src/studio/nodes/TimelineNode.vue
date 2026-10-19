<script setup lang="ts">
import { computed } from 'vue';
import type { NodeProps } from '@vue-flow/core';
import type { CanvasNode, TimelineNodeData } from '@h3mise/shared';
import { t } from '../../stores/locale';
import BaseNode from './BaseNode.vue';
import { useNodeChrome } from './useNodeChrome';

const props = defineProps<NodeProps<{ node: CanvasNode }>>();
const { node, selected, lod } = useNodeChrome(props);
const data = computed(() => node.value.data as TimelineNodeData);
</script>

<template>
  <BaseNode :node="node" :selected="selected" :lod="lod" icon="timeline" :status="t('studio.timeline.clips', { n: data.clipCount })">
    <div class="hf-strip">
      <span v-for="clip in data.clips" :key="clip.id" class="hf-strip-clip" :title="clip.shotId">{{ clip.order }}</span>
      <span v-if="data.clips.length === 0" class="hf-strip-empty" />
    </div>
    <div class="hf-chips"><span class="hf-chip">{{ Math.round(data.durationSeconds) }}s</span></div>
  </BaseNode>
</template>

<style scoped>
.hf-strip { display: flex; gap: 3px; min-height: 34px; align-items: stretch; border-radius: 5px; background: var(--bg-muted); padding: 3px; overflow: hidden; }
.hf-strip-clip { flex: 1; min-width: 14px; border-radius: 3px; background: var(--ok); color: #fff; font-size: 9px; display: grid; place-items: center; }
.hf-strip-empty { flex: 1; border-radius: 3px; background: repeating-linear-gradient(45deg, var(--line) 0 4px, transparent 4px 8px); }
</style>
