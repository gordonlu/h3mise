<script setup lang="ts">
import { markRaw, onErrorCaptured, onMounted, onUnmounted, ref, shallowRef, type Component } from 'vue';
import type { MediaAsset, Shot } from '@h3mise/shared';
import { t as tr } from '../../stores/locale';

const props = defineProps<{
  shot: Shot;
  media: MediaAsset[];
  modes: string[];
}>();
const emit = defineEmits<{ assetsAdded: [] }>();

const Panel = shallowRef<Component | null>(null);
const error = ref<string | null>(null);
const generation = ref(0);
let disposed = false;

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

async function loadPanel(): Promise<void> {
  try {
    const module = await import('./ShotComposerPanel.vue');
    if (!disposed) Panel.value = markRaw(module.default);
  } catch (reason) {
    if (!disposed) error.value = describe(reason);
  }
}

function retry(): void {
  error.value = null;
  Panel.value = null;
  generation.value += 1;
  void loadPanel();
}

onErrorCaptured((reason, _instance, info) => {
  console.error('[shot-composer]', reason, info);
  error.value = describe(reason);
  return false;
});

onMounted(() => {
  void loadPanel();
});

onUnmounted(() => {
  disposed = true;
});
</script>

<template>
  <div v-if="error" class="composer-error">
    <strong>{{ tr('shot.composer.failedTitle') }}</strong>
    <p class="muted">{{ tr('shot.composer.failedHint') }}</p>
    <p class="muted err-detail">{{ error }}</p>
    <button class="sm" type="button" @click="retry">{{ tr('shot.composer.retry') }}</button>
  </div>
  <component
    :is="Panel"
    v-else-if="Panel"
    :key="generation"
    :shot="props.shot"
    :media="props.media"
    :modes="props.modes"
    @assets-added="emit('assetsAdded')"
  />
  <p v-else class="muted">{{ tr('common.loading') }}</p>
</template>

<style scoped>
.composer-error { display: grid; gap: 6px; padding: 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-2); }
.composer-error strong { color: var(--bad); }
.composer-error p { margin: 0; }
.err-detail { max-height: 120px; overflow: auto; font-family: var(--mono); font-size: 11.5px; white-space: pre-wrap; }
</style>
