<script setup lang="ts">
defineProps<{ label?: string }>();
</script>

<template>
  <div class="hf-field">
    <span v-if="label" class="hf-field-label">{{ label }}</span>
    <span class="hf-field-value"><slot /></span>
  </div>
</template>
