<script setup lang="ts">
// Thin route wrapper: the full shot workspace now lives in ShotWorkbench so the
// Studio inspector can reuse it. Keyed by shot id so switching shots remounts.
import { useRoute } from 'vue-router';
import ShotWorkbench from '../components/director/ShotWorkbench.vue';

const route = useRoute();
const shotId = route.params.id as string;
</script>

<template>
  <ShotWorkbench :key="shotId" :shot-id="shotId" />
</template>
