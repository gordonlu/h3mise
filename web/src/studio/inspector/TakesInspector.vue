<script setup lang="ts">
import { computed } from 'vue';
import type { CanvasNode, TakesNodeData } from '@h3mise/shared';
import { fileUrl } from '../../api/client';
import { t } from '../../stores/locale';
import Field from './Field.vue';

const props = defineProps<{ node: CanvasNode | null }>();
const data = computed(() => props.node?.data as TakesNodeData | undefined);
</script>

<template>
  <template v-if="data">
    <p v-if="data.takes.length === 0" class="hf-muted">{{ t('studio.inspector.noTakes') }}</p>
    <div v-else class="hf-inspector-takes">
      <div v-for="take in data.takes" :key="take.id" class="hf-inspector-take" :class="`t-${take.status}`">
        <img v-if="take.posterPath" :src="fileUrl(take.posterPath)" loading="lazy" decoding="async" alt="" />
        <div v-else class="hf-inspector-take-empty" />
        <div class="hf-inspector-take-meta">
          <span class="hf-chip">{{ take.status }}</span>
          <span class="hf-chip">{{ Math.round(take.duration) }}s</span>
          <span v-if="take.rating" class="hf-chip">{{ t('studio.inspector.rating') }} {{ take.rating }}</span>
        </div>
      </div>
    </div>
  </template>
</template>
