<script setup lang="ts">
import { computed } from 'vue';
import type { BeatNodeData, CanvasNode } from '@h3mise/shared';
import { t } from '../../stores/locale';
import Field from './Field.vue';

const props = defineProps<{ node: CanvasNode | null }>();
const data = computed(() => props.node?.data as BeatNodeData | undefined);
</script>

<template>
  <template v-if="data">
    <Field :label="t('studio.inspector.category')">{{ data.category }}</Field>
    <Field :label="t('studio.inspector.duration')">{{ data.durationSeconds }}s</Field>
    <Field v-if="data.location" :label="t('studio.inspector.location')">{{ data.location }}</Field>
    <Field v-if="data.timeOfDay" :label="t('studio.inspector.timeOfDay')">{{ data.timeOfDay }}</Field>
    <Field v-if="data.weather" :label="t('studio.inspector.weather')">{{ data.weather }}</Field>
    <Field :label="t('studio.inspector.linkedShots')">{{ data.shotIds.join('、') || '—' }}</Field>
    <div class="hf-inspector-section">
      <div class="hf-inspector-label">{{ t('studio.inspector.summary') }}</div>
      <p class="hf-inspector-text">{{ data.summary || '—' }}</p>
    </div>
  </template>
</template>
