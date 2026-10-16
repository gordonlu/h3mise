<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useStudioStore } from '../stores/studio';
import { t } from '../stores/locale';
import StudioCanvas from '../studio/StudioCanvas.vue';
import StudioInspector from '../studio/inspector/StudioInspector.vue';
import BottomDock from '../studio/bottom/BottomDock.vue';
import LeftDock from '../studio/dock/LeftDock.vue';
import RunPlanCard from '../studio/overlays/RunPlanCard.vue';
import ContextMenu from '../studio/overlays/ContextMenu.vue';
import NoteEditor from '../studio/overlays/NoteEditor.vue';

const store = useStudioStore();
const route = useRoute();
const { graph, loading, error } = storeToRefs(store);
const narrow = ref(false);
const inspectorOpen = ref(true);
const dockOpen = ref(true);

const showInspector = computed(() => inspectorOpen.value && !loading.value && !error.value);
const gridColumns = computed(() =>
  `${dockOpen.value ? '220px ' : ''}minmax(0, 1fr)${showInspector.value ? ' 400px' : ''}`,
);

const isEmpty = computed(() => !loading.value && !error.value && (graph.value?.nodes.length ?? 0) === 0);

function checkWidth(): void {
  narrow.value = window.innerWidth < 1280;
}

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === '[') {
    event.preventDefault();
    dockOpen.value = !dockOpen.value;
  } else if (event.key === ']') {
    event.preventDefault();
    inspectorOpen.value = !inspectorOpen.value;
  } else if (event.key === 'Escape') {
    store.clearSelection();
  }
}

async function applyDeepLink(): Promise<void> {
  const node = typeof route.query.node === 'string' ? route.query.node : null;
  if (node) {
    store.select(node);
    inspectorOpen.value = true;
  }
}

onMounted(async () => {
  checkWidth();
  window.addEventListener('resize', checkWidth);
  window.addEventListener('keydown', onKeydown);
  await store.load();
  await applyDeepLink();
});
onUnmounted(() => {
  window.removeEventListener('resize', checkWidth);
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="hf-studio">
    <header class="hf-topbar">
      <span class="hf-crumb">{{ t('studio.title') }}</span>
      <span class="hf-sub">{{ t('studio.subtitle') }}</span>
      <span class="hf-spacer" />
      <button class="hf-ghost" @click="dockOpen = !dockOpen">{{ t('studio.dock.nodes') }}</button>
      <button v-if="!inspectorOpen" class="hf-ghost" @click="inspectorOpen = true">
        {{ t('studio.inspector.title') }}
      </button>
      <button class="hf-ghost" @click="store.load()">{{ t('studio.reload') }}</button>
    </header>

    <div v-if="narrow" class="hf-narrow">{{ t('studio.tooNarrow') }}</div>

    <div class="hf-body-row" :style="{ gridTemplateColumns: gridColumns }">
      <LeftDock v-if="dockOpen && !loading && !error" />
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
        <RunPlanCard />
      </div>

      <StudioInspector
        v-if="showInspector"
        @collapse="inspectorOpen = false"
      />
    </div>

    <BottomDock v-if="!loading && !error && !isEmpty" />
    <ContextMenu />
    <NoteEditor />
  </div>
</template>

