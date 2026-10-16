<script setup lang="ts">
import { computed } from 'vue';
import type { AnnotationNodeData, CanvasNode } from '@h3mise/shared';

const props = defineProps<{ node: CanvasNode | null }>();
const annotation = computed(() =>
  props.node && (props.node.kind === 'note' || props.node.kind === 'frame')
    ? (props.node.data as AnnotationNodeData)
    : undefined,
);
</script>

<template>
  <template v-if="props.node">
    <div v-if="annotation" class="hf-inspector-section">
      <p class="hf-inspector-text">{{ annotation.text || '—' }}</p>
    </div>
    <p v-else class="hf-muted hf-mono">{{ props.node.id }}</p>
  </template>
</template>
