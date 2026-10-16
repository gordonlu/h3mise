<script setup lang="ts">
import { computed } from 'vue';
import { H3_MODE_LABEL, SHOT_USER_STATUS_LABEL, type CanvasNode, type ShotNodeData } from '@h3mise/shared';
import { t } from '../../stores/locale';
import Field from './Field.vue';

const props = defineProps<{ node: CanvasNode | null }>();
const data = computed(() => props.node?.data as ShotNodeData | undefined);

const dependency = computed(() => {
  if (!data.value) return '—';
  if (!data.value.dependsOnShotId) return data.value.renderDependencyMode;
  return `${data.value.renderDependencyMode} · ${data.value.dependsOnShotId}`;
});

const preflight = computed(() => {
  if (!data.value?.latestPreflight) return t('studio.inspector.preflightNone');
  return data.value.latestPreflight.blocked ? t('studio.inspector.preflightBlocked') : t('studio.inspector.preflightPass');
});
</script>

<template>
  <template v-if="data">
    <Field :label="t('studio.inspector.status')">{{ SHOT_USER_STATUS_LABEL[data.userStatus] }}</Field>
    <Field :label="t('studio.inspector.mode')">{{ data.h3Mode ? H3_MODE_LABEL[data.h3Mode] : '—' }}</Field>
    <Field :label="t('studio.inspector.duration')">{{ data.durationSeconds }}s</Field>
    <Field :label="t('studio.inspector.aspect')">{{ data.aspectRatio }}</Field>
    <Field :label="t('studio.inspector.dependency')">{{ dependency }}</Field>
    <Field :label="t('studio.inspector.cast')">
      {{ data.castChips.map((chip) => chip.name).join('、') || '—' }}
    </Field>
    <Field v-if="data.missingRequired.length" :label="t('studio.inspector.missing')">
      <span class="hf-inspector-danger">{{ data.missingRequired.join('、') }}</span>
    </Field>
    <Field :label="t('studio.inspector.preflight')">{{ preflight }}</Field>
    <Field :label="t('studio.inspector.takes')">{{ data.takeCount }}（{{ data.candidateCount }} 候选）</Field>
    <Field v-if="data.selectedTakeId" :label="t('studio.inspector.selectedTake')">{{ data.selectedTakeId }}</Field>
    <p class="hf-muted hf-inspector-note">{{ t('studio.inspector.freeActionsHint') }}</p>
  </template>
</template>
