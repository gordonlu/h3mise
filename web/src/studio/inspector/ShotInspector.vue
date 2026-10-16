<script setup lang="ts">
import { computed } from 'vue';
import type { CanvasNode } from '@h3mise/shared';
import ShotWorkbench from '../../components/director/ShotWorkbench.vue';

const props = defineProps<{ node: CanvasNode | null }>();
const shotId = computed(() => (props.node?.kind === 'shot' ? props.node.domainId : null));
</script>

<template>
  <ShotWorkbench v-if="shotId" :key="shotId" :shot-id="shotId" compact />
</template>
