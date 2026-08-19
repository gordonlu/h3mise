<script setup lang="ts">
import { ref, watch } from 'vue';

const props = withDefaults(defineProps<{ src: string; poster?: string | null; label?: string; maxHeight?: number }>(), { maxHeight: 340 });
const emit = defineEmits<{ play: []; pause: []; seeked: []; timeupdate: [t: number] }>();

const video = ref<HTMLVideoElement | null>(null);

watch(
  () => props.src,
  () => {
    // Force reload when the source changes (A/B compare).
    video.value?.load();
  },
);

function currentTime(): number {
  return video.value?.currentTime ?? 0;
}

function seek(t: number) {
  if (video.value) video.value.currentTime = t;
}

function play() {
  void video.value?.play();
}

function pause() {
  video.value?.pause();
}

defineExpose({ currentTime, seek, play, pause });
</script>

<template>
  <div class="player" :title="label">
    <video
      ref="video"
      :src="src"
      :poster="poster ?? undefined"
      controls
      preload="metadata"
      playsinline
      :style="{ maxHeight: `${maxHeight}px` }"
      @play="emit('play')"
      @pause="emit('pause')"
      @seeked="emit('seeked')"
      @timeupdate="emit('timeupdate', ($event.target as HTMLVideoElement).currentTime)"
    />
  </div>
</template>

<style scoped>
.player { width: 100%; background: #000; border-radius: var(--radius-sm); overflow: hidden; box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25); }
video { display: block; width: 100%; background: #000; }
</style>
