<script setup lang="ts">
import { computed } from 'vue';
import type { NodeProps } from '@vue-flow/core';
import { H3_MODE_LABEL, SHOT_USER_STATUS_LABEL, type CanvasNode, type ShotNodeData } from '@h3mise/shared';
import { fileUrl } from '../../api/client';
import { useStudioStore } from '../../stores/studio';
import BaseNode from './BaseNode.vue';
import { useNodeChrome } from './useNodeChrome';

const props = defineProps<NodeProps<{ node: CanvasNode }>>();
const { node, selected, lod } = useNodeChrome(props);
const studio = useStudioStore();
const data = computed(() => node.value.data as ShotNodeData);
const cover = computed(() => (data.value.coverPath ? fileUrl(data.value.coverPath) : null));
const missing = computed(() => data.value.missingRequired);
const live = computed(() => studio.liveJobs[node.value.domainId] ?? null);
const status = computed(() => (live.value ? live.value.status : SHOT_USER_STATUS_LABEL[data.value.userStatus]));
const statusClass = computed(() => (live.value ? 's-rendering' : `s-${data.value.userStatus}`));
</script>

<template>
  <BaseNode
    :node="node"
    :selected="selected"
    :lod="lod"
    icon="◎"
    :status="status"
    :status-class="statusClass"
  >
    <img v-if="cover" class="hf-thumb" :src="cover" loading="lazy" decoding="async" :alt="node.title" />
    <div v-else class="hf-thumb" />
    <div class="hf-chips">
      <span v-if="data.h3Mode" class="hf-chip">{{ H3_MODE_LABEL[data.h3Mode] }}</span>
      <span class="hf-chip">{{ data.durationSeconds }}s</span>
      <span class="hf-chip">{{ data.aspectRatio }}</span>
      <span v-if="data.dependsOnShotId" class="hf-chip">⛓ {{ data.dependsOnShotId }}</span>
    </div>
    <div class="hf-chips">
      <span v-for="chip in data.castChips" :key="chip.entityId" class="hf-chip">{{ chip.name }}</span>
      <span v-for="item in missing" :key="item" class="hf-chip missing">{{ item }}</span>
    </div>
  </BaseNode>
</template>
