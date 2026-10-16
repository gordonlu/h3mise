<script setup lang="ts">
import { computed } from 'vue';
import { BaseEdge, getBezierPath, type EdgeProps } from '@vue-flow/core';
import type { CanvasEdge } from '@h3mise/shared';

const props = defineProps<EdgeProps<{ edge: CanvasEdge }>>();

const path = computed(() =>
  getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    targetX: props.targetX,
    targetY: props.targetY,
    sourcePosition: props.sourcePosition,
    targetPosition: props.targetPosition,
  })[0],
);

const kind = computed(() => props.data?.edge?.kind ?? 'binding');
const derived = computed(() => props.data?.edge?.derived === true);
const focus = computed(() => props.data?.edge?.focusOnly === true);
</script>

<template>
  <BaseEdge
    :path="path"
    :class="['hf-edge-typed', `e-k-${kind}`, { 'e-derived': derived, 'e-focus': focus }]"
  />
</template>
