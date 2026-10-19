<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { ShotNodeData } from '@h3mise/shared';
import { del, post } from '../../api/client';
import { useRunPlanStore } from '../../stores/runPlan';
import { useRunPlan } from '../../composables/useRunPlan';
import { useStudioStore } from '../../stores/studio';
import { useStudioUiStore } from '../../stores/studioUi';
import { useToastStore } from '../../stores/toast';
import { useShotActions } from '../../composables/useShotActions';
import { useConnect } from '../../composables/useConnect';
import { useCanvasCreate } from '../../composables/useCanvasCreate';
import { useDuplicateShot } from '../../composables/useDuplicateShot';
import { confirmDialog } from '../../stores/confirm';
import { t } from '../../stores/locale';

const plan = useRunPlanStore();
const store = useStudioStore();
const ui = useStudioUiStore();
const toasts = useToastStore();
const router = useRouter();
const { build } = useRunPlan();
const { mainAction } = useShotActions();
const { create } = useCanvasCreate();
const { duplicate } = useDuplicateShot();
const { disconnect } = useConnect();
const busy = ref(false);

const shotId = computed(() => {
  const nodeId = plan.contextMenu?.nodeId;
  return nodeId?.startsWith('shot:') ? nodeId.slice('shot:'.length) : null;
});
const node = computed(() => {
  const nodeId = plan.contextMenu?.nodeId;
  return nodeId ? store.nodeById.get(nodeId) ?? null : null;
});
const data = computed<ShotNodeData | null>(() => (node.value?.kind === 'shot' ? node.value.data : null));
const edge = computed(() => {
  const edgeId = plan.edgeContextMenu?.edgeId;
  return edgeId ? store.graph?.edges.find((item) => item.id === edgeId) ?? null : null;
});
const stage = computed(() => (shotId.value && data.value ? mainAction(shotId.value, data.value) : null));

async function runStage(): Promise<void> {
  const action = stage.value;
  if (!action || action.disabled) return;
  plan.closeMenu();
  try {
    await action.run();
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  }
}

function runToHere(): void {
  if (shotId.value) {
    build(shotId.value);
    store.select(`shot:${shotId.value}`);
  }
  plan.closeMenu();
}

async function newNextShot(): Promise<void> {
  const current = shotId.value;
  const nodeId = plan.contextMenu?.nodeId;
  if (!current || !nodeId) return;
  busy.value = true;
  try {
    const base = store.positions.get(nodeId) ?? { x: 0, y: 0 };
    const created = await create({ kind: 'shot', mode: 'i2va' }, { x: base.x + 340, y: base.y });
    plan.closeMenu();
    if (!created) return;
    const storyId = store.graph?.storyId;
    if (!storyId) return;
    try {
      await store.connect({
        storyId,
        source: { nodeId, port: 'tail_frame' },
        target: { nodeId: created, port: 'first_frame' },
      });
    } catch {
      /* the new shot exists even if linking needs a replacement decision */
    }
  } finally {
    busy.value = false;
  }
}

async function resolveDependency(): Promise<void> {
  if (!shotId.value) return;
  busy.value = true;
  try {
    await post(`/api/shots/${encodeURIComponent(shotId.value)}/render-dependency/resolve`);
    await store.refreshGraph();
    toasts.push({ kind: 'ok', text: t('studio.menu.dependencyResolved') });
    plan.closeMenu();
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  } finally {
    busy.value = false;
  }
}

async function duplicateShot(): Promise<void> {
  const current = shotId.value;
  const nodeId = plan.contextMenu?.nodeId;
  if (!current || !nodeId) return;
  const base = store.positions.get(nodeId) ?? { x: 0, y: 0 };
  busy.value = true;
  try {
    await duplicate(current, base);
    plan.closeMenu();
  } catch (e) {
    toasts.push({ kind: 'err', text: t('studio.copy.failed', { msg: e instanceof Error ? e.message : String(e) }) });
  } finally {
    busy.value = false;
  }
}

function openDesk(): void {
  if (shotId.value) void router.push(`/shots/${shotId.value}`);
  plan.closeMenu();
}

function locateInOutline(): void {
  if (!shotId.value) return;
  ui.openLeft('outline');
  store.select(`shot:${shotId.value}`);
  store.focusNode(`shot:${shotId.value}`);
  plan.closeMenu();
}

async function disconnectEdge(): Promise<void> {
  const id = edge.value?.id;
  if (!id) return;
  plan.closeMenu();
  await disconnect(id);
}

async function deleteShot(): Promise<void> {
  const id = shotId.value;
  if (!id) return;
  plan.closeMenu();
  const ok = await confirmDialog({
    title: t('studio.menu.deleteTitle'),
    message: t('studio.menu.deleteMessage'),
    confirmLabel: t('common.delete'),
    danger: true,
  });
  if (!ok) return;
  busy.value = true;
  try {
    await del(`/api/shots/${encodeURIComponent(id)}`);
    store.clearSelection();
    await store.load();
    toasts.push({ kind: 'ok', text: t('studio.menu.deleted') });
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="plan.contextMenu" class="hf-ctx-backdrop" @click="plan.closeMenu()" @contextmenu.prevent="plan.closeMenu()">
      <div class="hf-ctx" :style="{ left: `${plan.contextMenu.x}px`, top: `${plan.contextMenu.y}px` }" @click.stop>
        <template v-if="shotId && stage">
          <button v-if="!stage.disabled" class="hf-ctx-item" :disabled="busy" @click="runStage">
            {{ stage.label }}<span v-if="stage.paid" class="hf-ctx-paid">¥</span>
          </button>
          <div class="hf-ctx-sep" />
          <button class="hf-ctx-item" :disabled="busy" @click="runToHere">{{ t('studio.menu.runToHere') }}</button>
          <button class="hf-ctx-item" :disabled="busy" @click="newNextShot">{{ t('studio.menu.newNextShot') }}</button>
          <button class="hf-ctx-item" :disabled="busy" @click="duplicateShot">{{ t('studio.menu.duplicate') }}</button>
          <button
            v-if="data?.renderDependencyMode === 'previous_take' || data?.dependsOnShotId"
            class="hf-ctx-item"
            :disabled="busy"
            @click="resolveDependency"
          >{{ t('studio.menu.resolveDependency') }}</button>
          <div class="hf-ctx-sep" />
          <button class="hf-ctx-item" @click="openDesk">{{ t('studio.menu.openDesk') }}</button>
          <button class="hf-ctx-item" @click="locateInOutline">{{ t('studio.menu.locateOutline') }}</button>
          <div class="hf-ctx-sep" />
          <button class="hf-ctx-item danger" :disabled="busy" @click="deleteShot">{{ t('studio.menu.deleteShot') }}</button>
        </template>
        <div v-else class="hf-ctx-item muted">{{ t('studio.menu.noActions') }}</div>
      </div>
    </div>
  </Teleport>

  <Teleport to="body">
    <div v-if="plan.edgeContextMenu" class="hf-ctx-backdrop" @click="plan.closeMenu()" @contextmenu.prevent="plan.closeMenu()">
      <div class="hf-ctx" :style="{ left: `${plan.edgeContextMenu.x}px`, top: `${plan.edgeContextMenu.y}px` }" @click.stop>
        <div class="hf-ctx-label">{{ t('studio.edge.why') }}</div>
        <div class="hf-ctx-reason">{{ edge ? t(`studio.edge.${edge.kind}`) : '' }}</div>
        <template v-if="edge && !edge.derived">
          <div class="hf-ctx-sep" />
          <button class="hf-ctx-item danger" @click="disconnectEdge">{{ t('studio.menu.disconnect') }}</button>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.hf-ctx-backdrop { position: fixed; inset: 0; z-index: 20; }
.hf-ctx {
  position: absolute; min-width: 210px; padding: 4px; background: var(--bg-2);
  border: 1px solid var(--line); border-radius: var(--radius-sm); box-shadow: var(--shadow-2);
}
.hf-ctx-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; text-align: left; padding: 7px 10px; border: none; background: none; color: var(--text); font-size: 13px; border-radius: 6px; cursor: pointer; }
.hf-ctx-item:hover:not(:disabled) { background: var(--bg-muted); }
.hf-ctx-item:disabled { color: var(--text-3); cursor: default; }
.hf-ctx-item.danger { color: var(--bad); }
.hf-ctx-item.muted { color: var(--text-3); cursor: default; }
.hf-ctx-paid { color: var(--accent-text); font-weight: 700; }
.hf-ctx-label { padding: 6px 10px 2px; color: var(--text-3); font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
.hf-ctx-reason { padding: 2px 10px 8px; max-width: 260px; color: var(--text-2); font-size: 12px; line-height: 1.5; }
.hf-ctx-sep { height: 1px; margin: 4px 0; background: var(--line); }
</style>
