<script setup lang="ts">
import { computed } from 'vue';
import type { NodeProps } from '@vue-flow/core';
import type { CanvasNode, ExportNodeData } from '@h3mise/shared';
import { t } from '../../stores/locale';
import BaseNode from './BaseNode.vue';
import { useNodeChrome } from './useNodeChrome';

const props = defineProps<NodeProps<{ node: CanvasNode }>>();
const { node, selected, lod } = useNodeChrome(props);
const data = computed(() => node.value.data as ExportNodeData);
const base = computed(() => data.value.latest?.relPath.split('/').pop() ?? '');
const status = computed(() =>
  data.value.latest ? t('studio.export.count', { n: data.value.exportCount }) : t('studio.export.none'),
);
</script>

<template>
  <BaseNode :node="node" :selected="selected" :lod="lod" icon="⤓" :status="status">
    <div v-if="data.latest" class="hf-export">
      <div class="hf-export-name" :title="data.latest.relPath">{{ base }}</div>
      <div class="hf-chips">
        <span v-if="data.latest.durationSeconds" class="hf-chip">{{ Math.round(data.latest.durationSeconds) }}s</span>
      </div>
    </div>
    <div v-else class="hf-export hf-export-empty">{{ t('studio.export.none') }}</div>
  </BaseNode>
</template>

<style scoped>
.hf-export { font-size: 11px; color: var(--text-2); display: grid; gap: 4px; }
.hf-export-name { font-family: var(--mono); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hf-export-empty { color: var(--text-3); }
</style>
