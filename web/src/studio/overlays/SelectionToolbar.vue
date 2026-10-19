<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ShotNodeData } from '@h3mise/shared';
import { post } from '../../api/client';
import { useStudioStore } from '../../stores/studio';
import { useStudioUiStore } from '../../stores/studioUi';
import { useProjectStore } from '../../stores/project';
import { useToastStore } from '../../stores/toast';
import { t } from '../../stores/locale';

const store = useStudioStore();
const ui = useStudioUiStore();
const project = useProjectStore();
const toasts = useToastStore();
const busy = ref(false);

const shots = computed(() =>
  store.selection
    .map((id) => store.nodeById.get(id))
    .filter((node): node is NonNullable<typeof node> => node?.kind === 'shot')
    .map((node) => ({ id: node.domainId, data: node.data as ShotNodeData })),
);

const visible = computed(() => shots.value.length >= 2);

async function compileAll(): Promise<void> {
  busy.value = true;
  let done = 0;
  try {
    for (const shot of shots.value) {
      await post(`/api/shots/${encodeURIComponent(shot.id)}/prompts/compile`, { mode: shot.data.h3Mode ?? 't2va' });
      done += 1;
    }
    await store.refreshGraph();
    toasts.push({ kind: 'ok', text: t('studio.multi.compiled', { n: done }) });
  } catch (e) {
    toasts.push({ kind: 'err', text: t('studio.multi.failed', { msg: e instanceof Error ? e.message : String(e) }) });
  } finally {
    busy.value = false;
  }
}

async function preflightAll(): Promise<void> {
  const providerId = project.current?.config.default_provider ?? 'runninghub';
  const ready = shots.value.filter((shot) => shot.data.latestPromptVersionId);
  if (ready.length === 0) {
    toasts.push({ kind: 'info', text: t('studio.multi.noPrompt') });
    return;
  }
  busy.value = true;
  let done = 0;
  try {
    for (const shot of ready) {
      await post(`/api/shots/${encodeURIComponent(shot.id)}/preflight`, {
        promptVersionId: shot.data.latestPromptVersionId,
        providerId,
        megapixels: ui.megapixels,
      });
      done += 1;
    }
    await store.refreshGraph();
    toasts.push({ kind: 'ok', text: t('studio.multi.preflighted', { n: done }) });
  } catch (e) {
    toasts.push({ kind: 'err', text: t('studio.multi.failed', { msg: e instanceof Error ? e.message : String(e) }) });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="visible" class="hf-multi">
    <span class="hf-multi-count">{{ t('studio.multi.count', { n: shots.length }) }}</span>
    <button class="hf-action" :disabled="busy" @click="compileAll">{{ t('studio.multi.compile') }}</button>
    <button class="hf-action" :disabled="busy" @click="preflightAll">{{ t('studio.multi.preflight') }}</button>
    <button class="hf-action" :disabled="busy" @click="store.fitSelection()">{{ t('studio.view.fitSelection') }}</button>
    <button class="hf-action" :disabled="busy" @click="store.clearSelection()">{{ t('studio.multi.clear') }}</button>
  </div>
</template>

<style scoped>
.hf-multi {
  position: absolute; top: 12px; left: 50%; z-index: 9; transform: translateX(-50%);
  display: flex; align-items: center; gap: 6px; padding: 6px 8px;
  background: var(--bg-2); border: 1px solid var(--line); border-radius: var(--radius-pill);
  box-shadow: var(--shadow-1);
}
.hf-multi-count { padding: 0 6px; color: var(--text-2); font-size: 12px; white-space: nowrap; }
</style>
