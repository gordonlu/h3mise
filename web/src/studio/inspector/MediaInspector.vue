<script setup lang="ts">
import { computed } from 'vue';
import type { CanvasNode, MediaNodeData } from '@h3mise/shared';
import { mediaUrl } from '../../api/client';
import { t } from '../../stores/locale';
import Field from './Field.vue';

const props = defineProps<{ node: CanvasNode | null }>();
const data = computed(() => props.node?.data as MediaNodeData | undefined);
</script>

<template>
  <template v-if="data && props.node">
    <img
      v-if="data.mediaKind !== 'audio'"
      class="hf-inspector-thumb"
      :src="mediaUrl(props.node.domainId)"
      loading="lazy"
      decoding="async"
      alt=""
    />
    <Field :label="t('studio.inspector.mediaKind')">{{ t(`studio.kind.${data.mediaKind}`) }}</Field>
    <Field v-if="data.durationSeconds" :label="t('studio.inspector.duration')">{{ Math.round(data.durationSeconds) }}s</Field>
    <Field :label="t('studio.inspector.file')"><span class="hf-mono">{{ props.node.domainId }}</span></Field>
  </template>
</template>
