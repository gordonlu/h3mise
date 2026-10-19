<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { storeToRefs } from 'pinia';
import { DEFAULT_LANE_ORDER, type CanvasLane, type StoryEpisodeList } from '@h3mise/shared';
import { useStudioStore } from '../stores/studio';
import { useStudioUiStore, isBottomDockTab, isLeftDockTab, MEGAPIXEL_OPTIONS } from '../stores/studioUi';
import { useRunPlanStore } from '../stores/runPlan';
import { useProjectStore } from '../stores/project';
import { useToastStore } from '../stores/toast';
import { useAutoProduce } from '../composables/useAutoProduce';
import { useStudioNavigate } from '../composables/useStudioNavigate';
import { useArrangeLayout } from '../composables/useArrangeLayout';
import { get, post } from '../api/client';
import { t } from '../stores/locale';
import StudioCanvas from '../studio/StudioCanvas.vue';
import StudioInspector from '../studio/inspector/StudioInspector.vue';
import StudioViewMenu from '../studio/StudioViewMenu.vue';
import BottomDock from '../studio/bottom/BottomDock.vue';
import LeftDock from '../studio/dock/LeftDock.vue';
import RunPlanCard from '../studio/overlays/RunPlanCard.vue';
import SelectionToolbar from '../studio/overlays/SelectionToolbar.vue';
import ContextMenu from '../studio/overlays/ContextMenu.vue';
import NoteEditor from '../studio/overlays/NoteEditor.vue';
import QuickCreateMenu from '../studio/overlays/QuickCreateMenu.vue';
import BreakdownPicker from '../studio/overlays/BreakdownPicker.vue';

const store = useStudioStore();
const ui = useStudioUiStore();
const runPlan = useRunPlanStore();
const project = useProjectStore();
const toasts = useToastStore();
const route = useRoute();
const { graph, loading, error } = storeToRefs(store);
const narrow = ref(false);
const noProject = ref(false);
const installingDemo = ref(false);
const episodes = ref<StoryEpisodeList | null>(null);
let episodeSeq = 0;
const { open: openAutoProduce } = useAutoProduce();
const navigate = useStudioNavigate();
const { arrange } = useArrangeLayout();

const showInspector = computed(() => ui.inspectorOpen && !noProject.value && !loading.value && !error.value);
const gridColumns = computed(() =>
  `${ui.leftOpen ? '220px ' : ''}minmax(0, 1fr)${showInspector.value ? ' 400px' : ''}`,
);

const isEmpty = computed(() => {
  if (noProject.value || loading.value || error.value) return false;
  const nodes = graph.value?.nodes ?? [];
  return !nodes.some((node) => node.kind === 'shot' || node.kind === 'beat');
});

async function startFromStory(): Promise<void> {
  for (const title of [t('studio.template.beatSetup'), t('studio.template.beatRising'), t('studio.template.beatPayoff')]) {
    await post('/api/story/beats', { title, category: 'other' });
  }
  await store.load();
}

async function startFromShot(): Promise<void> {
  const shot = await post<{ id: string }>('/api/shots', { h3Mode: 't2va' });
  await store.refreshGraph();
  store.select(`shot:${shot.id}`);
}

function checkWidth(): void {
  narrow.value = window.innerWidth < 1280;
}

async function loadEpisodes(): Promise<void> {
  const seq = ++episodeSeq;
  try {
    const next = await get<StoryEpisodeList>('/api/story/episodes');
    if (seq === episodeSeq) episodes.value = next;
  } catch {
    if (seq === episodeSeq) episodes.value = null;
  }
}

async function switchEpisode(event: Event): Promise<void> {
  const id = (event.target as HTMLSelectElement).value;
  if (!id || id === episodes.value?.activeEpisodeId) return;
  try {
    episodes.value = await post<StoryEpisodeList>(`/api/story/episodes/${encodeURIComponent(id)}/activate`, {});
    store.clearSelection();
    runPlan.setPlan(null);
    runPlan.setAutoPlan(null);
    await store.load();
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  }
}

function applyDeepLink(): void {
  const { node, lane, dock, bottom, tab } = route.query;
  if (typeof dock === 'string' && isLeftDockTab(dock)) navigate.go({ dock });
  if (typeof bottom === 'string' && isBottomDockTab(bottom)) navigate.go({ bottom });
  if (typeof lane === 'string' && (DEFAULT_LANE_ORDER as string[]).includes(lane)) {
    navigate.go({ lane: lane as CanvasLane });
  }
  if (typeof node === 'string') {
    navigate.go({ node, ...(typeof tab === 'string' ? { tab } : {}) });
  }
}

async function installGoodBoy(): Promise<void> {
  installingDemo.value = true;
  try {
    const installed = await project.installDemo('good-boy');
    if (!installed) return;
    noProject.value = false;
    await Promise.all([store.load(), loadEpisodes()]);
    applyDeepLink();
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  } finally {
    installingDemo.value = false;
  }
}

onMounted(async () => {
  checkWidth();
  window.addEventListener('resize', checkWidth);
  store.reset();
  await project.bootstrap();
  if (!project.current) {
    noProject.value = true;
    store.loading = false;
    return;
  }
  await Promise.all([store.load(), loadEpisodes()]);
  applyDeepLink();
});
onUnmounted(() => {
  window.removeEventListener('resize', checkWidth);
});

watch(() => route.query, () => applyDeepLink(), { deep: true });
</script>

<template>
  <div class="hf-studio">
    <header class="hf-topbar">
      <span class="hf-crumb">{{ t('studio.title') }}</span>
      <span class="hf-beta" :title="t('studio.betaHint')" role="note">{{ t('studio.beta') }}</span>
      <span class="hf-sub">{{ t('studio.subtitle') }}</span>
      <label v-if="episodes" class="hf-episode">
        <span class="hf-visually-hidden">{{ t('pages.story.episodeAria') }}</span>
        <select :value="episodes.activeEpisodeId" @change="switchEpisode">
          <option v-for="episode in episodes.episodes" :key="episode.id" :value="episode.id">
            EP {{ String(episode.order).padStart(2, '0') }} · {{ episode.title }}
          </option>
        </select>
      </label>
      <label v-if="!noProject" class="hf-episode">
        <span class="hf-visually-hidden">{{ t('studio.mp') }}</span>
        <select v-model.number="ui.megapixels">
          <option v-for="mp in MEGAPIXEL_OPTIONS" :key="mp" :value="mp">{{ mp }} MP</option>
        </select>
      </label>
      <span class="hf-spacer" />
      <template v-if="!noProject">
        <RouterLink to="/studio/series" class="hf-ghost hf-link">{{ t('studio.series.open') }}</RouterLink>
        <button class="hf-ghost" :disabled="loading || !!error" @click="openAutoProduce">{{ t('studio.auto.open') }}</button>
        <button class="hf-ghost" :disabled="loading || !!error" :title="t('studio.view.arrangeHint')" @click="arrange">{{ t('studio.view.arrange') }}</button>
        <StudioViewMenu />
        <button class="hf-ghost" @click="ui.toggleLeft()">{{ t('studio.dock.nodes') }}</button>
        <button v-if="!ui.inspectorOpen" class="hf-ghost" @click="ui.inspectorOpen = true">
          {{ t('studio.inspector.title') }}
        </button>
        <button class="hf-ghost" @click="store.load()">{{ t('studio.reload') }}</button>
      </template>
    </header>

    <div v-if="narrow" class="hf-narrow">{{ t('studio.tooNarrow') }}</div>

    <div class="hf-body-row" :style="{ gridTemplateColumns: gridColumns }">
      <LeftDock v-if="ui.leftOpen && !noProject && !loading && !error" />
      <div class="hf-canvas">
        <StudioCanvas v-if="!noProject && !loading && !error" />
        <div v-if="noProject" class="hf-overlay">
          <div class="hf-overlay-card hf-cold-start">
            <p class="hf-template-title">{{ t('studio.noProject.title') }}</p>
            <p class="hf-muted">{{ t('studio.noProject.hint') }}</p>
            <div class="hf-project-actions">
              <RouterLink to="/projects" class="hf-ghost">{{ t('studio.noProject.create') }}</RouterLink>
              <button class="hf-ghost" :disabled="installingDemo" @click="installGoodBoy">
                {{ installingDemo ? t('studio.noProject.installing') : t('studio.noProject.installDemo') }}
              </button>
              <RouterLink to="/projects" class="hf-ghost">{{ t('studio.noProject.openList') }}</RouterLink>
            </div>
          </div>
        </div>
        <div v-else-if="loading" class="hf-overlay">
          <div class="hf-overlay-card">{{ t('studio.loading') }}</div>
        </div>
        <div v-else-if="error" class="hf-overlay">
          <div class="hf-overlay-card">
            {{ t('studio.error', { msg: error }) }}
            <button @click="store.load()">{{ t('studio.reload') }}</button>
          </div>
        </div>
        <div v-else-if="isEmpty" class="hf-overlay">
          <div class="hf-overlay-card">
            <p class="hf-template-title">{{ t('studio.empty') }}</p>
            <div class="hf-templates">
              <button class="hf-template" @click="startFromStory">
                <strong>{{ t('studio.template.story') }}</strong>
                <small>{{ t('studio.template.storyHint') }}</small>
              </button>
              <button class="hf-template" @click="startFromShot">
                <strong>{{ t('studio.template.shot') }}</strong>
                <small>{{ t('studio.template.shotHint') }}</small>
              </button>
              <button class="hf-template" disabled>
                <strong>{{ t('studio.template.refVideo') }}</strong>
                <small>{{ t('studio.template.soon') }}</small>
              </button>
            </div>
          </div>
        </div>
        <RunPlanCard />
        <SelectionToolbar />
      </div>

      <StudioInspector
        v-if="showInspector"
        @collapse="ui.inspectorOpen = false"
      />
    </div>

    <BottomDock v-if="!noProject && !loading && !error && !isEmpty" />
    <ContextMenu />
    <NoteEditor />
    <QuickCreateMenu />
    <BreakdownPicker />
  </div>
</template>

