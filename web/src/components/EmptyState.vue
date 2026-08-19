<script setup lang="ts">
defineProps<{ icon?: string; title: string; desc?: string }>();
</script>

<template>
  <div class="empty-state">
    <div class="e-icon">{{ icon ?? '▧' }}</div>
    <div class="e-title">{{ title }}</div>
    <div v-if="desc" class="e-desc">{{ desc }}</div>
    <div v-if="$slots.default" class="e-actions"><slot /></div>
  </div>
</template>
