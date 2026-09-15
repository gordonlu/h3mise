<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useProjectStore } from './stores/project';
import { useRenderStore } from './stores/render';
import { useToastStore } from './stores/toast';
import { useThemeStore } from './stores/theme';
import { useAiStore } from './stores/ai';
import { t } from './stores/locale';
import { subscribeEvents, get } from './api/client';
import AppSidebar from './components/AppSidebar.vue';
import RenderQueueDrawer from './components/RenderQueueDrawer.vue';
import ToastHost from './components/ToastHost.vue';
import ConfirmHost from './components/ConfirmHost.vue';
import CommandPalette from './components/CommandPalette.vue';
import type { AppEvent, ProjectGuideSummary } from '@h3mise/shared';

const project = useProjectStore();
const route = useRoute();
const render = useRenderStore();
const toasts = useToastStore();
const theme = useThemeStore();
const ai = useAiStore();
const health = ref<{ ffmpeg: { available: boolean } } | null>(null);
const paletteOpen = ref(false);
const projectGuide = ref<ProjectGuideSummary | null>(null);
let off: (() => void) | null = null;
let aiTimer: number | undefined;

function onGlobalKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    paletteOpen.value = !paletteOpen.value;
  }
}

async function switchProject(id: string): Promise<void> {
  if (id === project.projectId) return;
  try {
    if (!(await project.openProject(id))) return;
    await project.refreshProjects();
    await render.refresh();
    await refreshProjectGuide();
    toasts.push({ kind: 'ok', text: t('shell.switchedProject', { name: project.current?.config.title ?? id }) });
  } catch (e) {
    toasts.push({ kind: 'err', text: t('shell.switchProjectFailed', { msg: e instanceof Error ? e.message : String(e) }) });
  }
}

async function refreshProjectGuide(): Promise<void> {
  if (!project.current) {
    projectGuide.value = null;
    return;
  }
  try {
    projectGuide.value = await get<ProjectGuideSummary>('/api/guide/project');
  } catch {
    projectGuide.value = null;
  }
}

/** Global SSE → toast notifications (render lifecycle, takes, continuity). */
function notify(e: AppEvent): void {
  const renderProjectId = e.type.startsWith('render.job.') && 'projectId' in e ? e.projectId : null;
  const isCurrentRenderProject = !renderProjectId || renderProjectId === project.projectId;
  const projectLabel = renderProjectId && !isCurrentRenderProject
    ? `（${project.projects.find((item) => item.id === renderProjectId)?.title ?? renderProjectId}）`
    : '';
  switch (e.type) {
    case 'render.job.succeeded':
      toasts.push({ kind: 'ok', text: t('shell.renderSucceeded', { project: projectLabel, shot: e.shotId }), ...(isCurrentRenderProject ? { actionLabel: t('shell.pickTake'), actionTo: `/shots/${e.shotId}` } : {}) });
      break;
    case 'render.job.failed':
      toasts.push({ kind: 'err', text: t('shell.renderFailed', { project: projectLabel, shot: e.shotId, msg: e.error?.slice(0, 120) ?? '' }), ...(isCurrentRenderProject ? { actionLabel: t('shell.view'), actionTo: `/shots/${e.shotId}` } : {}) });
      break;
    case 'take.selected':
      toasts.push({ kind: 'info', text: t('shell.takeSelected', { shot: e.shotId }) });
      break;
    case 'continuity.committed':
      toasts.push({ kind: 'ok', text: t('shell.continuityCommitted', { scope: t(e.scope === 'visual' ? 'shell.visual' : 'shell.narrative'), shot: e.shotId }) });
      break;
    case 'render.job.created':
      toasts.push({ kind: 'info', text: t('shell.renderCreated', { project: projectLabel, shot: e.shotId }) });
      break;
  }
}

onMounted(async () => {
  theme.apply();
  await project.bootstrap();
  await render.refresh();
  await refreshProjectGuide();
  void ai.refresh();
  aiTimer = window.setInterval(() => void ai.refresh(), 15_000);
  try {
    health.value = await get('/api/health');
  } catch {
    /* server down */
  }
  document.addEventListener('keydown', onGlobalKeydown);
  off = subscribeEvents((e: AppEvent) => {
    render.onEvent(e.type, e as unknown as Record<string, unknown>);
    notify(e);
    if (e.type.startsWith('ai.request.')) void ai.refresh();
    if (e.type === 'take.created' || e.type === 'shot.updated' || e.type === 'continuity.committed' || e.type === 'project.updated') {
      void project.refreshCurrent();
      void scheduleGuideRefresh();
    }
    // Only terminal/milestone render events refresh the guide; polling
    // status ticks (render.job.updated) are handled by the debounce.
    if (e.type === 'render.job.created' || e.type === 'render.job.succeeded' || e.type === 'render.job.failed' || e.type === 'take.selected') {
      void scheduleGuideRefresh();
    }
  });
});

let guideTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleGuideRefresh(): void {
  if (guideTimer) clearTimeout(guideTimer);
  guideTimer = setTimeout(() => {
    guideTimer = null;
    void refreshProjectGuide();
  }, 300);
}

onUnmounted(() => {
  off?.();
  if (guideTimer) clearTimeout(guideTimer);
  if (aiTimer) window.clearInterval(aiTimer);
  document.removeEventListener('keydown', onGlobalKeydown);
});

watch(() => route.path, () => {
  void scheduleGuideRefresh();
});
</script>

<template>
  <div class="shell">
    <AppSidebar
      :guide="projectGuide"
      :ffmpeg-available="health?.ffmpeg.available ?? null"
      :on-switch="switchProject"
      @palette="paletteOpen = true"
    />

    <main class="main">
      <!-- Project data is server-scoped. Remount the active page whenever the
           project changes so deterministic ids such as shot-001 from the old
           project can never be submitted into the newly opened project. -->
      <router-view :key="`${project.projectId ?? 'none'}:${$route.fullPath}`" />
    </main>

    <RenderQueueDrawer v-if="render.drawerOpen" @close="render.drawerOpen = false" />
    <CommandPalette v-if="paletteOpen" @close="paletteOpen = false" />
    <ToastHost />
    <ConfirmHost />
  </div>
</template>

<style scoped>
.shell { position: relative; z-index: 1; display: grid; grid-template-columns: 276px minmax(0, 1fr); height: 100%; }
.main { min-width: 0; overflow: auto; }
.main :deep(.page) { width: 100%; max-width: 1440px; margin: 0 auto; padding: 28px 36px 56px; }
</style>
