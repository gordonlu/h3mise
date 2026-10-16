<script setup lang="ts">
import type { NodeProps } from '@vue-flow/core';

const props = defineProps<NodeProps<{ label: string }>>();
</script>

<template>
  <div class="hf-ghost-node">{{ props.data.label }}</div>
</template>

<style scoped>
.hf-ghost-node {
  border: 1px dashed var(--accent); border-radius: var(--radius-sm); padding: 14px 10px;
  color: var(--accent-text); font-size: 12px; text-align: center;
  background: color-mix(in srgb, var(--accent-soft) 60%, transparent);
}
</style>
