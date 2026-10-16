<script setup lang="ts">
import { computed } from 'vue';
import type { CanvasNode, StoryNodeData } from '@h3mise/shared';
import { t } from '../../stores/locale';
import Field from './Field.vue';

const props = defineProps<{ node: CanvasNode | null }>();
const data = computed(() => props.node?.data as StoryNodeData | undefined);
</script>

<template>
  <template v-if="data">
    <Field :label="t('studio.inspector.planned')">{{ data.plannedDurationSeconds }}s</Field>
    <Field :label="t('studio.inspector.beats')">{{ data.beatCount }}</Field>
    <div class="hf-inspector-section">
      <div class="hf-inspector-label">{{ t('studio.inspector.synopsis') }}</div>
      <p class="hf-inspector-text">{{ data.synopsis || '—' }}</p>
    </div>
  </template>
</template>
