<script setup lang="ts">
import { computed } from 'vue';
import type { CanvasNode, StoryboardNodeData } from '@h3mise/shared';
import { mediaUrl } from '../../api/client';
import { t } from '../../stores/locale';
import Field from './Field.vue';

const props = defineProps<{ node: CanvasNode | null }>();
const data = computed(() => props.node?.data as StoryboardNodeData | undefined);
</script>

<template>
  <template v-if="data">
    <Field :label="t('studio.inspector.status')">{{ data.status }}</Field>
    <Field :label="t('studio.inspector.page')">{{ data.pageNumber }} / {{ data.totalPages }}</Field>
    <Field :label="t('studio.inspector.panels')">{{ data.panelCount }}</Field>
    <div class="hf-inspector-grid">
      <div v-for="panel in data.panels" :key="panel.id" class="hf-inspector-cell">
        <img v-if="panel.assetId" :src="mediaUrl(panel.assetId)" loading="lazy" decoding="async" alt="" />
        <span v-else>{{ panel.order }}</span>
      </div>
    </div>
  </template>
</template>
