<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{
  thumb: string | null;
  video: string | null;
  alt?: string;
  /** Preview only in card/detail LOD (never overview). */
  enabled?: boolean;
  /** Extra classes applied to both the image and the video. */
  mediaClass?: string;
}>();

const showVideo = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;

function clearTimer(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function onEnter(): void {
  if (!props.video || props.enabled === false) return;
  clearTimer();
  timer = setTimeout(() => {
    showVideo.value = true;
  }, 500);
}

function onLeave(): void {
  clearTimer();
  showVideo.value = false;
}

watch(() => props.video, () => {
  clearTimer();
  showVideo.value = false;
});
</script>

<template>
  <div class="hf-hover" @mouseenter="onEnter" @mouseleave="onLeave">
    <video
      v-if="showVideo && video"
      :class="mediaClass"
      :src="video"
      muted
      autoplay
      loop
      playsinline
      preload="none"
    />
    <img v-else-if="thumb" :class="mediaClass" :src="thumb" loading="lazy" decoding="async" :alt="alt ?? ''" />
    <div v-else :class="mediaClass" />
  </div>
</template>

<style scoped>
.hf-hover { display: block; width: 100%; }
</style>
