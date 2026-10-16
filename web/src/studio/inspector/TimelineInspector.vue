<script setup lang="ts">
import { computed } from 'vue';
import type { CanvasNode, ExportNodeData, TimelineNodeData } from '@h3mise/shared';
import { t } from '../../stores/locale';
import Field from './Field.vue';

const props = defineProps<{ node: CanvasNode | null }>();
const timeline = computed(() => (props.node?.kind === 'timeline' ? (props.node.data as TimelineNodeData) : undefined));
const exported = computed(() => (props.node?.kind === 'export' ? (props.node.data as ExportNodeData) : undefined));
</script>

<template>
  <template v-if="timeline">
    <Field :label="t('studio.inspector.clips')">{{ t('studio.inspector.clipCount', { n: timeline.clipCount }) }}</Field>
    <Field :label="t('studio.inspector.duration')">{{ Math.round(timeline.durationSeconds) }}s</Field>
  </template>
  <template v-else-if="exported">
    <Field :label="t('studio.inspector.exportCount')">{{ exported.exportCount }}</Field>
    <template v-if="exported.latest">
      <Field :label="t('studio.inspector.file')"><span class="hf-mono">{{ exported.latest.relPath }}</span></Field>
      <Field v-if="exported.latest.durationSeconds" :label="t('studio.inspector.duration')">
        {{ Math.round(exported.latest.durationSeconds) }}s
      </Field>
    </template>
    <p v-else class="hf-muted">{{ t('studio.export.none') }}</p>
  </template>
</template>
