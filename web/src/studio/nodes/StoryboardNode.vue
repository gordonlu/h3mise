<script setup lang="ts">
import { computed, ref } from 'vue';
import type { NodeProps } from '@vue-flow/core';
import type { CanvasNode, StoryboardNodeData } from '@h3mise/shared';
import { mediaUrl } from '../../api/client';
import { t } from '../../stores/locale';
import { useStoryboardActions } from '../../composables/useStoryboardActions';
import BaseNode from './BaseNode.vue';
import { useNodeChrome } from './useNodeChrome';

const props = defineProps<NodeProps<{ node: CanvasNode }>>();
const { node, selected, lod } = useNodeChrome(props);
const data = computed(() => node.value.data as StoryboardNodeData);
const { mainAction, regeneratePanel } = useStoryboardActions();
const action = computed(() => mainAction(node.value.domainId, data.value));
const busy = ref(false);

async function runAction(): Promise<void> {
  if (action.value.disabled || busy.value) return;
  busy.value = true;
  try {
    await action.value.run();
  } finally {
    busy.value = false;
  }
}

async function regen(panelId: string, order: number): Promise<void> {
  busy.value = true;
  try {
    await regeneratePanel(node.value.domainId, panelId, order);
  } finally {
    busy.value = false;
  }
}
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
        <button
          v-if="data.status === 'ready'"
          class="hf-board-regen nodrag nopan"
          :title="t('studio.storyboard.regenerate')"
          @click.stop="regen(panel.id, panel.order)"
          @mousedown.stop
        >¥</button>
      </div>
    </div>
    <template #foot>
      <button
        class="hf-action nodrag nopan"
        :class="{ paid: action.paid }"
        :disabled="action.disabled || busy"
        @click.stop="runAction"
        @mousedown.stop
      >
        {{ busy ? '…' : action.label }}<span v-if="action.paid" class="hf-action-cost">¥</span>
      </button>
    </template>
  </BaseNode>
</template>

<style scoped>
.hf-board-grid { display: grid; gap: 3px; }
.hf-board-cell { position: relative; aspect-ratio: 16 / 10; border-radius: 4px; background: var(--bg-muted); display: grid; place-items: center; font-size: 10px; color: var(--text-3); overflow: hidden; }
.hf-board-cell img { width: 100%; height: 100%; object-fit: cover; }
.hf-board-regen {
  position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; border-radius: 4px;
  border: none; background: var(--accent); color: #fff; font-size: 10px; cursor: pointer;
  opacity: 0; transition: opacity 120ms ease;
}
.hf-board-cell:hover .hf-board-regen { opacity: 1; }
</style>
