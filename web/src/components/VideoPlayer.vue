<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{ src: string; poster?: string | null; label?: string }>();
const video = ref<HTMLVideoElement | null>(null);

watch(
  () => props.src,
  () => {
    // Force reload when the source changes (A/B compare).
    video.value?.load();
  },
);
</script>

<template>
  <div class="player" :title="label">
    <video ref="video" :src="src" :poster="poster ?? undefined" controls preload="metadata" playsinline />
  </div>
</template>

<style scoped>
.player { width: 100%; background: #000; border-radius: var(--radius-sm); overflow: hidden; }
video { display: block; width: 100%; max-height: 340px; background: #000; }
</style>
