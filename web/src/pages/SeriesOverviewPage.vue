<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { StoryEpisodeList } from '@h3mise/shared';
import { get, post } from '../api/client';
import { useProjectStore } from '../stores/project';
import { useToastStore } from '../stores/toast';
import { t } from '../stores/locale';

const router = useRouter();
const project = useProjectStore();
const toasts = useToastStore();
const episodes = ref<StoryEpisodeList | null>(null);
const loading = ref(false);
const creating = ref(false);

const title = computed(() => project.current?.config.title ?? t('studio.title'));

async function load(): Promise<void> {
  loading.value = true;
  try {
    episodes.value = await get<StoryEpisodeList>('/api/story/episodes');
  } catch (e) {
    toasts.push({ kind: 'err', text: t('studio.series.failed', { msg: e instanceof Error ? e.message : String(e) }) });
  } finally {
    loading.value = false;
  }
}

async function openEpisode(id: string): Promise<void> {
  if (id !== episodes.value?.activeEpisodeId) {
    await post(`/api/story/episodes/${encodeURIComponent(id)}/activate`, {});
  }
  void router.push('/studio');
}

async function createEpisode(): Promise<void> {
  creating.value = true;
  try {
    const next = (episodes.value?.episodes.length ?? 0) + 1;
    await post('/api/story/episodes', { title: t('studio.series.newEpisodeTitle', { n: next }) });
    toasts.push({ kind: 'ok', text: t('studio.series.created') });
    void router.push('/studio');
  } catch (e) {
    toasts.push({ kind: 'err', text: t('studio.series.failed', { msg: e instanceof Error ? e.message : String(e) }) });
  } finally {
    creating.value = false;
  }
}

onMounted(() => void load());
</script>

<template>
  <div class="hf-series">
    <header class="hf-series-head">
      <div>
        <p class="hf-series-crumb">
          <RouterLink to="/studio">{{ t('studio.series.back') }}</RouterLink>
          <span>/</span>
          <span>{{ t('studio.series.title') }}</span>
        </p>
        <h1>{{ title }}</h1>
        <p class="hf-series-sub">{{ t('studio.series.subtitle') }}</p>
      </div>
      <button class="primary" :disabled="creating" @click="createEpisode">
        {{ creating ? t('studio.series.creating') : t('studio.series.newEpisode') }}
      </button>
    </header>

    <p v-if="loading" class="hf-muted">{{ t('common.loading') }}</p>
    <p v-else-if="!episodes?.episodes.length" class="hf-muted">{{ t('studio.series.empty') }}</p>
    <div v-else class="hf-series-canvas">
      <div class="hf-series-spine" aria-hidden="true" />
      <button
        v-for="episode in episodes.episodes"
        :key="episode.id"
        class="hf-series-node"
        :class="{ active: episode.id === episodes.activeEpisodeId }"
        @click="openEpisode(episode.id)"
      >
        <span class="hf-series-ep">EP {{ String(episode.order).padStart(2, '0') }}</span>
        <strong>{{ episode.title }}</strong>
        <span class="hf-series-meta">{{ t('studio.series.meta', { beats: episode.beatCount, shots: episode.shotCount }) }}</span>
        <span class="hf-series-action">
          {{ episode.id === episodes.activeEpisodeId ? t('studio.series.current') : t('studio.series.openEpisode') }}
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.hf-series {
  min-height: 100%; padding: 28px 36px 48px; background: var(--bg);
}
.hf-series-head {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 20px;
  max-width: 980px; margin: 0 auto 28px;
}
.hf-series-crumb { display: flex; gap: 8px; margin: 0 0 10px; color: var(--text-3); font-size: 12px; }
.hf-series-crumb a { color: var(--accent-text); text-decoration: none; }
.hf-series-head h1 { margin: 0 0 6px; font-size: 26px; letter-spacing: -0.03em; }
.hf-series-sub { margin: 0; color: var(--text-3); font-size: 13px; }
.hf-series-canvas {
  position: relative; display: grid; gap: 14px; max-width: 980px; margin: 0 auto; padding-left: 26px;
}
.hf-series-spine {
  position: absolute; left: 8px; top: 18px; bottom: 18px; width: 2px;
  background: linear-gradient(var(--accent-line), var(--line));
}
.hf-series-node {
  position: relative; display: grid; grid-template-columns: 74px minmax(0, 1fr) auto; grid-template-rows: auto auto;
  gap: 4px 14px; align-items: center; width: 100%; padding: 18px 20px;
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-2);
  box-shadow: var(--shadow-1); color: var(--text); text-align: left; cursor: pointer;
}
.hf-series-node::before {
  content: ''; position: absolute; left: -22px; top: 50%; width: 22px; height: 2px; background: var(--line-2);
}
.hf-series-node:hover { border-color: var(--accent); }
.hf-series-node.active { border-color: var(--accent-bright); box-shadow: var(--focus-ring), var(--shadow-1); }
.hf-series-node.active::before { background: var(--accent); }
.hf-series-ep { grid-row: 1 / 3; color: var(--accent-text); font: 700 12px/1 var(--mono); letter-spacing: 0.08em; }
.hf-series-node strong { font-size: 16px; font-weight: 650; }
.hf-series-meta { color: var(--text-3); font-size: 12px; }
.hf-series-action { grid-row: 1 / 3; justify-self: end; color: var(--text-2); font-size: 12px; }
.hf-series-node.active .hf-series-action { color: var(--accent-text); font-weight: 700; }
</style>
