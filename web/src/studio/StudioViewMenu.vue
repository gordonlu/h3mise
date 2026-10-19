<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { DEFAULT_LANE_ORDER, type CanvasLane } from '@h3mise/shared';
import { useStudioStore } from '../stores/studio';
import { useArrangeLayout } from '../composables/useArrangeLayout';
import { t } from '../stores/locale';

const store = useStudioStore();
const { arrange } = useArrangeLayout();
const open = ref(false);
const root = ref<HTMLElement | null>(null);

const lanes = computed(() => DEFAULT_LANE_ORDER.filter((lane) => lane !== 'free'));

function isHidden(lane: CanvasLane): boolean {
  return store.hiddenLanes.includes(lane);
}

async function toggleLane(lane: CanvasLane): Promise<void> {
  const next = isHidden(lane)
    ? store.hiddenLanes.filter((item) => item !== lane)
    : [...store.hiddenLanes, lane];
  store.setHiddenLanes(next);
  await store.saveView();
}

async function toggleEdges(): Promise<void> {
  const current = store.layout?.view.edgeVisibility ?? 'default';
  store.setEdgeVisibility(current === 'all' ? 'default' : 'all');
  await store.saveView();
}

function fitAll(): void {
  store.fitAll();
  open.value = false;
}

function fitSelection(): void {
  store.fitSelection();
  open.value = false;
}

function onDocumentClick(event: MouseEvent): void {
  if (!open.value) return;
  if (root.value && !root.value.contains(event.target as globalThis.Node)) open.value = false;
}

onMounted(() => document.addEventListener('click', onDocumentClick));
onUnmounted(() => document.removeEventListener('click', onDocumentClick));
</script>

<template>
  <div ref="root" class="hf-view-menu">
    <button class="hf-ghost" :class="{ active: open }" aria-haspopup="menu" :aria-expanded="open" @click="open = !open">{{ t('studio.view.title') }}</button>
    <div v-if="open" class="hf-view-pop" role="menu">
      <button class="hf-view-item" role="menuitem" @click="fitAll">{{ t('studio.view.fitAll') }}</button>
      <button class="hf-view-item" role="menuitem" :disabled="store.selection.length === 0" @click="fitSelection">
        {{ t('studio.view.fitSelection') }}
      </button>
      <div class="hf-view-sep" />
      <button class="hf-view-item check" role="menuitemcheckbox" :aria-checked="store.layout?.view.edgeVisibility === 'all'" @click="toggleEdges">
        <span class="hf-view-check">{{ store.layout?.view.edgeVisibility === 'all' ? '✓' : '' }}</span>
        {{ t('studio.view.edges') }}
      </button>
      <div class="hf-view-sep" />
      <div class="hf-view-label">{{ t('studio.view.lanes') }}</div>
      <button
        v-for="lane in lanes"
        :key="lane"
        class="hf-view-item check"
        role="menuitemcheckbox"
        :aria-checked="!isHidden(lane)"
        @click="toggleLane(lane)"
      >
        <span class="hf-view-check">{{ isHidden(lane) ? '' : '✓' }}</span>
        {{ t(`studio.lane.${lane}`) }}
      </button>
      <div class="hf-view-sep" />
      <button class="hf-view-item danger" role="menuitem" @click="open = false; arrange()">{{ t('studio.view.reset') }}</button>
    </div>
  </div>
</template>

<style scoped>
.hf-view-menu { position: relative; }
.hf-view-menu .hf-ghost.active { border-color: var(--accent); color: var(--accent-text); }
.hf-view-pop {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; width: 210px; padding: 5px;
  background: var(--bg-2); border: 1px solid var(--line); border-radius: var(--radius-sm); box-shadow: var(--shadow-2);
}
.hf-view-item {
  display: flex; align-items: center; gap: 7px; width: 100%; padding: 6px 9px;
  border: none; border-radius: 6px; background: none; color: var(--text); font-size: 12px; text-align: left; cursor: pointer;
}
.hf-view-item:hover:not(:disabled) { background: var(--bg-muted); }
.hf-view-item:disabled { color: var(--text-3); cursor: default; }
.hf-view-item.danger { color: var(--bad); }
.hf-view-check { flex: none; width: 12px; color: var(--accent-text); font-size: 11px; }
.hf-view-label { padding: 6px 9px 3px; color: var(--text-3); font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
.hf-view-sep { height: 1px; margin: 5px 0; background: var(--line); }
</style>
