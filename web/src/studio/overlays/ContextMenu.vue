<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useRunPlanStore } from '../../stores/runPlan';
import { useRunPlan } from '../../composables/useRunPlan';
import { useStudioStore } from '../../stores/studio';
import { t } from '../../stores/locale';

const plan = useRunPlanStore();
const store = useStudioStore();
const router = useRouter();
const { build } = useRunPlan();

const shotId = computed(() => {
  const nodeId = plan.contextMenu?.nodeId;
  return nodeId?.startsWith('shot:') ? nodeId.slice('shot:'.length) : null;
});

function runToHere(): void {
  if (shotId.value) {
    build(shotId.value);
    store.select(`shot:${shotId.value}`);
  }
  plan.closeMenu();
}

function openDesk(): void {
  if (shotId.value) void router.push(`/shots/${shotId.value}`);
  plan.closeMenu();
}
</script>

<template>
  <Teleport to="body">
    <div v-if="plan.contextMenu" class="hf-ctx-backdrop" @click="plan.closeMenu()" @contextmenu.prevent="plan.closeMenu()">
      <div class="hf-ctx" :style="{ left: `${plan.contextMenu.x}px`, top: `${plan.contextMenu.y}px` }" @click.stop>
        <template v-if="shotId">
          <button class="hf-ctx-item" @click="runToHere">{{ t('studio.menu.runToHere') }}</button>
          <button class="hf-ctx-item" @click="openDesk">{{ t('studio.menu.openDesk') }}</button>
        </template>
        <div v-else class="hf-ctx-item muted">{{ t('studio.menu.noActions') }}</div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.hf-ctx-backdrop { position: fixed; inset: 0; z-index: 20; }
.hf-ctx {
  position: absolute; min-width: 180px; padding: 4px; background: var(--bg-2);
  border: 1px solid var(--line); border-radius: var(--radius-sm); box-shadow: var(--shadow-2);
}
.hf-ctx-item { display: block; width: 100%; text-align: left; padding: 7px 10px; border: none; background: none; color: var(--text); font-size: 13px; border-radius: 6px; cursor: pointer; }
.hf-ctx-item:hover { background: var(--bg-muted); }
.hf-ctx-item.muted { color: var(--text-3); cursor: default; }
</style>
