<script setup lang="ts">
import { computed } from 'vue';
import type { EntityNodeData } from '@h3mise/shared';
import { useStudioStore } from '../../stores/studio';
import { t } from '../../stores/locale';

const store = useStudioStore();

const entities = computed(() =>
  (store.graph?.nodes ?? [])
    .filter((node) => node.kind === 'entity')
    .map((node) => ({ id: node.id, title: node.title, data: node.data as EntityNodeData }))
    .sort((a, b) => a.data.entityKind.localeCompare(b.data.entityKind) || a.title.localeCompare(b.title)),
);

function kindLabel(kind: string): string {
  const key = `studio.kind.${kind}`;
  const translated = t(key);
  return translated === key ? kind : translated;
}
</script>

<template>
  <div class="hf-lib">
    <p class="hf-muted hf-lib-hint">{{ t('studio.dock.assetsHint') }}</p>
    <button
      v-for="entity in entities"
      :key="entity.id"
      class="hf-lib-item"
      @click="store.select(entity.id)"
    >
      <span class="hf-chip">{{ kindLabel(entity.data.entityKind) }}</span>
      {{ entity.title }}
    </button>
  </div>
</template>
