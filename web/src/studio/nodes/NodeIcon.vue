<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ name?: string; size?: number }>();

const ICONS: Record<string, string[]> = {
  story: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6'],
  beat: ['M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.2l5.9-.9z'],
  sequence: ['M4 7h16', 'M4 12h16', 'M4 17h16'],
  storyboard: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
  entity: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21c0-4 4-6 8-6s8 2 8 6'],
  state: ['M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M6 20c0-3 2.5-5 6-5s6 2 6 5', 'M18 4l2 2-2 2'],
  media: ['M3 5h18v14H3z', 'M8 11l3 3 3-4 4 5H6z', 'M8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z'],
  breakdown: ['M3 5h18v14H3z', 'M10 9.5l5 2.5-5 2.5z'],
  shot: ['M4 7h16v12H4z', 'M8 7l2-3h4l2 3', 'M12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z'],
  takes: ['M4 5h7v7H4z', 'M13 5h7v7h-7z', 'M4 14h7v7H4z', 'M13 14h7v7h-7z'],
  take: ['M4 5h16v14H4z', 'M8 5v14', 'M16 5v14', 'M10 9l4 3-4 3z'],
  timeline: ['M3 7h16', 'M3 12h20', 'M3 17h11'],
  export: ['M12 3v12', 'm7 10 5 5 5-5', 'M4 21h16'],
  note: ['M5 4h14v16H5z', 'M8 8h8', 'M8 12h8', 'M8 16h5'],
  frame: ['M3 3h18v18H3z'],
  node: ['M4 4h16v16H4z'],
};

const paths = computed(() => ICONS[props.name ?? 'node'] ?? ICONS.node);
const dimension = computed(() => props.size ?? 14);
</script>

<template>
  <svg
    class="hf-node-icon"
    :width="dimension"
    :height="dimension"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="path in paths" :key="path" :d="path" />
  </svg>
</template>

<style scoped>
.hf-node-icon { flex: none; display: block; }
</style>
