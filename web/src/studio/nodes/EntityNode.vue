<script setup lang="ts">
import { computed } from 'vue';
import type { NodeProps } from '@vue-flow/core';
import type { CanvasNode, EntityNodeData } from '@h3mise/shared';
import { mediaUrl } from '../../api/client';
import { t } from '../../stores/locale';
import BaseNode from './BaseNode.vue';
import { useNodeChrome } from './useNodeChrome';
import { useStudioStore } from '../../stores/studio';

const props = defineProps<NodeProps<{ node: CanvasNode }>>();
const { node, selected, lod } = useNodeChrome(props);
const studio = useStudioStore();
const data = computed(() => node.value.data as EntityNodeData);
const kindLabel = computed(() => t(`studio.kind.${data.value.entityKind}`));
const expanded = computed(() => studio.expandedEntities.includes(node.value.id));
</script>

<template>
  <BaseNode :node="node" :selected="selected" :lod="lod" icon="entity" status="">
    <img
      v-if="data.imageAssetId"
      class="hf-thumb"
      :src="mediaUrl(data.imageAssetId)"
      loading="lazy"
      decoding="async"
      :alt="node.title"
    />
    <div v-else class="hf-thumb hf-thumb-empty">{{ t('studio.entity.noImage') }}</div>
    <div class="hf-chips">
      <span class="hf-chip">{{ kindLabel }}</span>
    </div>
    <template v-if="data.stateCount" #foot>
      <button
        class="hf-action nodrag nopan"
        :title="t('studio.entity.toggleStates')"
        @click.stop="studio.toggleEntity(node.id)"
        @mousedown.stop
      >
        {{ expanded ? '▾' : '▸' }} {{ t('studio.entity.states', { n: data.stateCount }) }}
      </button>
    </template>
  </BaseNode>
</template>

<style scoped>
.hf-thumb-empty { display: grid; place-items: center; border: 1px dashed var(--bad); color: var(--bad); font-size: 11px; }
</style>
