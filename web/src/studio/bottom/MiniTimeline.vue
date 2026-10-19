<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useStudioStore } from '../../stores/studio';
import { useStudioNavigate } from '../../composables/useStudioNavigate';
import { useToastStore } from '../../stores/toast';
import { post } from '../../api/client';
import { t } from '../../stores/locale';
import type { TimelineNodeData } from '@h3mise/shared';

const store = useStudioStore();
const toasts = useToastStore();
const router = useRouter();
const { goShot } = useStudioNavigate();

const timeline = computed<TimelineNodeData | null>(() => {
  const node = store.graph?.nodes.find((item) => item.kind === 'timeline');
  return node ? (node.data as TimelineNodeData) : null;
});
const shotCount = computed(() => store.graph?.nodes.filter((node) => node.kind === 'shot').length ?? 0);
const clipShotIds = computed(() => new Set((timeline.value?.clips ?? []).map((clip) => clip.shotId)));
const missing = computed(() => Math.max(0, shotCount.value - clipShotIds.value.size));

async function quickBuild(): Promise<void> {
  await post('/api/timeline/quick-build');
  await store.refreshGraph();
  toasts.push({ kind: 'ok', text: t('studio.bottom.built') });
}

async function exportFilm(): Promise<void> {
  const result = await post<{ jobId: string }>('/api/timeline/export', {});
  toasts.push({ kind: 'ok', text: t('studio.bottom.exportStarted', { id: result.jobId }) });
}
</script>

<template>
  <div class="hf-dock-panel">
    <div class="hf-dock-actions">
      <button class="hf-ghost" @click="quickBuild">{{ t('studio.bottom.quickBuild') }}</button>
      <button class="hf-ghost" @click="exportFilm">{{ t('studio.bottom.export') }}</button>
      <button class="hf-ghost" @click="router.push('/timeline')">{{ t('studio.bottom.openFull') }}</button>
    </div>
    <div v-if="timeline" class="hf-dock-strip">
      <div v-for="clip in timeline.clips" :key="clip.id" class="hf-dock-clip" :title="clip.shotId" @click="goShot(clip.shotId)">
        <span>{{ clip.order }}</span>
      </div>
      <div v-for="n in missing" :key="`miss-${n}`" class="hf-dock-clip missing" :title="t('studio.bottom.missing')">—</div>
    </div>
    <p v-else class="hf-muted">{{ t('studio.bottom.empty') }}</p>
  </div>
</template>

<style scoped>
.hf-dock-actions { display: flex; gap: 8px; margin-bottom: 8px; }
.hf-dock-strip { display: flex; gap: 4px; overflow-x: auto; padding-bottom: 4px; }
.hf-dock-clip { flex: none; width: 74px; height: 46px; border-radius: 6px; background: var(--ok); color: #fff; display: grid; place-items: center; font-size: 12px; cursor: pointer; }
.hf-dock-clip:hover { filter: brightness(1.08); }
.hf-dock-clip.missing { background: repeating-linear-gradient(45deg, var(--line) 0 5px, transparent 5px 10px); color: var(--text-3); }
</style>
