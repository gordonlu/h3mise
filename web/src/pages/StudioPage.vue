<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useStudioStore } from '../stores/studio';
import { t } from '../stores/locale';
import StudioCanvas from '../studio/StudioCanvas.vue';

const store = useStudioStore();
const { graph, loading, error } = storeToRefs(store);
const narrow = ref(false);

const isEmpty = computed(() => !loading.value && !error.value && (graph.value?.nodes.length ?? 0) === 0);

function checkWidth(): void {
  narrow.value = window.innerWidth < 1280;
}

onMounted(() => {
  checkWidth();
  window.addEventListener('resize', checkWidth);
  void store.load();
});
onUnmounted(() => window.removeEventListener('resize', checkWidth));
</script>

<template>
  <div class="hf-studio">
    <header class="hf-topbar">
      <span class="hf-crumb">{{ t('studio.title') }}</span>
      <span class="hf-sub">{{ t('studio.subtitle') }}</span>
      <span class="hf-spacer" />
      <button class="hf-ghost" @click="store.load()">{{ t('studio.reload') }}</button>
    </header>

    <div v-if="narrow" class="hf-narrow">{{ t('studio.tooNarrow') }}</div>

    <div class="hf-canvas">
      <StudioCanvas v-if="!loading && !error && !isEmpty" />
      <div v-if="loading" class="hf-overlay">
        <div class="hf-overlay-card">{{ t('studio.loading') }}</div>
      </div>
      <div v-else-if="error" class="hf-overlay">
        <div class="hf-overlay-card">
          {{ t('studio.error', { msg: error }) }}
          <button @click="store.load()">{{ t('studio.reload') }}</button>
        </div>
      </div>
      <div v-else-if="isEmpty" class="hf-overlay">
        <div class="hf-overlay-card">{{ t('studio.empty') }}</div>
      </div>
    </div>
  </div>
</template>
