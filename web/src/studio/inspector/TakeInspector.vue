<script setup lang="ts">
import { computed } from 'vue';
import type { CanvasNode, TakeNodeData } from '@h3mise/shared';
import { fileUrl } from '../../api/client';
import { t } from '../../stores/locale';
import Field from './Field.vue';

const props = defineProps<{ node: CanvasNode | null }>();
const data = computed<TakeNodeData | null>(() => (props.node?.kind === 'take' ? props.node.data : null));
const cover = computed(() => (data.value?.posterPath ? fileUrl(data.value.posterPath) : null));
</script>

<template>
  <template v-if="data">
    <img v-if="cover" class="hf-inspector-thumb" :src="cover" loading="lazy" decoding="async" :alt="node?.title ?? ''" />
    <Field :label="t('studio.inspector.status')">{{ t('studio.take.selected') }}</Field>
    <Field :label="t('studio.inspector.duration')">{{ Math.round(data.duration) }}s</Field>
    <Field :label="t('studio.inspector.rating')">{{ data.rating ?? '—' }}</Field>
    <Field :label="t('studio.inspector.shot')">{{ data.shotId }}</Field>
    <div class="hf-inspector-section">
      <RouterLink :to="`/shots/${encodeURIComponent(data.shotId)}#takes`" class="hf-action">
        {{ t('studio.inspector.openTakes') }}
      </RouterLink>
    </div>
  </template>
</template>
