<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core';
import type { CanvasPort } from '@h3mise/shared';

const props = defineProps<{ port: CanvasPort }>();
</script>

<template>
  <Handle
    :id="props.port.id"
    :type="props.port.direction === 'in' ? 'target' : 'source'"
    :position="props.port.direction === 'in' ? Position.Left : Position.Right"
    :connectable="false"
    :class="`hf-h-${props.port.type}`"
  />
</template>
