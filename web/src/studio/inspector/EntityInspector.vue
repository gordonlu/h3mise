<script setup lang="ts">
import { computed } from 'vue';
import type { CanvasNode, CharacterStateNodeData, EntityNodeData } from '@h3mise/shared';
import { mediaUrl } from '../../api/client';
import { t } from '../../stores/locale';
import Field from './Field.vue';

const props = defineProps<{ node: CanvasNode | null }>();
const entity = computed(() => (props.node?.kind === 'entity' ? (props.node.data as EntityNodeData) : undefined));
const state = computed(() => (props.node?.kind === 'character_state' ? (props.node.data as CharacterStateNodeData) : undefined));
const image = computed(() => entity.value?.imageAssetId ?? state.value?.effectiveImageAssetId ?? null);
const kindLabel = computed(() => (entity.value ? t(`studio.kind.${entity.value.entityKind}`) : t('studio.node.character_state')));
</script>

<template>
  <template v-if="entity || state">
    <img v-if="image" class="hf-inspector-thumb" :src="mediaUrl(image)" loading="lazy" decoding="async" alt="" />
    <div v-else class="hf-inspector-thumb hf-inspector-thumb-empty">{{ t('studio.entity.noImage') }}</div>
    <Field :label="t('studio.inspector.type')">{{ kindLabel }}</Field>
    <template v-if="entity">
      <Field :label="t('studio.inspector.states')">{{ entity.stateCount }}</Field>
      <Field :label="t('studio.inspector.usage')">{{ t('studio.inspector.usageCount', { n: entity.usageShotIds.length }) }}</Field>
    </template>
  </template>
</template>
