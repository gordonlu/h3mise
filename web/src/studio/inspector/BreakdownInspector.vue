<script setup lang="ts">
import { computed } from 'vue';
import type { BreakdownNodeData, CanvasNode } from '@h3mise/shared';
import { t } from '../../stores/locale';
import Field from './Field.vue';

const props = defineProps<{ node: CanvasNode | null }>();
const data = computed<BreakdownNodeData | null>(() => (props.node?.kind === 'breakdown' ? props.node.data : null));
</script>

<template>
  <template v-if="data">
    <Field :label="t('studio.inspector.mediaKind')">{{ t(`studio.kind.${data.mediaKind}`) }}</Field>
    <Field :label="t('studio.inspector.duration')">{{ data.durationSeconds ? t('studio.media.duration', { n: Math.round(data.durationSeconds) }) : '—' }}</Field>
    <Field :label="t('studio.inspector.segments')">{{ data.segmentCount }}</Field>
    <Field :label="t('studio.inspector.frames')">{{ data.frameCount }}</Field>
    <Field :label="t('studio.inspector.revision')">{{ data.revision }}</Field>
    <Field :label="t('studio.inspector.analysis')">
      {{ data.hasAnalysis ? t('studio.breakdown.analyzed') : t('studio.breakdown.notAnalyzed') }}
    </Field>
    <div class="hf-inspector-section">
      <RouterLink :to="`/assets/${encodeURIComponent(data.mediaId)}/breakdown`" class="hf-action">
        {{ t('studio.breakdown.open') }}
      </RouterLink>
    </div>
  </template>
</template>
