<script setup lang="ts">
import { computed } from 'vue';
import { BaseEdge, getBezierPath, type EdgeProps } from '@vue-flow/core';
import type { CanvasEdge } from '@h3mise/shared';
import { useStudioStore } from '../../stores/studio';

const props = defineProps<EdgeProps<{ edge: CanvasEdge }>>();
const studio = useStudioStore();

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
const related = computed(() => studio.selection.includes(props.source) || studio.selection.includes(props.target));
const dim = computed(() => studio.selection.length > 0 && !related.value);
</script>

<template>
  <BaseEdge
    :path="path"
    :class="['hf-edge-typed', `e-k-${kind}`, { 'e-derived': derived, 'e-focus': focus, 'e-related': related, 'e-dim': dim }]"
  />
</template>
