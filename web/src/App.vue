<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useProjectStore } from './stores/project';
import { useRenderStore } from './stores/render';
import { useToastStore } from './stores/toast';
import { useThemeStore } from './stores/theme';
import { locale, setLocale, t } from './stores/locale';
import { subscribeEvents, get } from './api/client';
import RenderQueueDrawer from './components/RenderQueueDrawer.vue';
import ToastHost from './components/ToastHost.vue';
import ConfirmHost from './components/ConfirmHost.vue';
import type { AppEvent, RenderJob } from '@h3mise/shared';
import type { ProjectGuideSummary } from '@h3mise/shared';
import ProjectGuideBar from './components/ProjectGuideBar.vue';
import WorkspaceNav from './components/WorkspaceNav.vue';

const project = useProjectStore();
const route = useRoute();
const render = useRenderStore();
const toasts = useToastStore();
const theme = useThemeStore();
const health = ref<{ ffmpeg: { available: boolean }; runningHubConfigured: boolean; aiConfigured: boolean } | null>(null);
const projectsOpen = ref(false);
const projectGuide = ref<ProjectGuideSummary | null>(null);
const projectsRef = ref<HTMLElement | null>(null);
let off: (() => void) | null = null;

function cycleLocale(): void {
  setLocale(locale.value === 'zh' ? 'en' : locale.value === 'en' ? 'ja' : 'zh');
}

function localeLabel(): string {
  return locale.value === 'zh' ? '中' : locale.value === 'en' ? 'EN' : '日';
}

function localeTitle(): string {
  return locale.value === 'zh' ? 'Switch to English' : locale.value === 'en' ? '日本語に切り替え' : '切换到中文';
}

function activeJobCount(): number {
  return render.jobs.filter((j: RenderJob) => ['LOCAL_QUEUED', 'UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING'].includes(j.status)).length;
}

async function switchProject(id: string) {
  projectsOpen.value = false;
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

async function refreshProjectGuide() {
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

function onProjectsClickOutside(e: MouseEvent) {
  if (projectsOpen.value && projectsRef.value && !projectsRef.value.contains(e.target as Node)) {
    projectsOpen.value = false;
  }
}

/** Global SSE → toast notifications (render lifecycle, takes, continuity). */
function notify(e: AppEvent) {
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
  try {
    health.value = await get('/api/health');
  } catch {
    /* server down */
  }
  document.addEventListener('mousedown', onProjectsClickOutside);
  off = subscribeEvents((e: AppEvent) => {
    render.onEvent(e.type, e as unknown as Record<string, unknown>);
    notify(e);
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
function scheduleGuideRefresh() {
  if (guideTimer) clearTimeout(guideTimer);
  guideTimer = setTimeout(() => {
    guideTimer = null;
    void refreshProjectGuide();
  }, 300);
}

onUnmounted(() => {
  off?.();
  if (guideTimer) clearTimeout(guideTimer);
  document.removeEventListener('mousedown', onProjectsClickOutside);
});

watch(() => route.path, () => void scheduleGuideRefresh());
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <router-link to="/projects" class="brand">
        <img src="/h3mise-logo.png" alt="H3Mise" class="brand-logo" />
      </router-link>

      <template v-if="project.current">
        <div ref="projectsRef" class="project-switch" :class="{ open: projectsOpen }">
          <button class="project-switch-btn" @click="projectsOpen = !projectsOpen">
            <span class="project-title" :title="project.current.meta.id">{{ project.current.config.title }}</span>
            <svg class="caret" aria-hidden="true" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" /></svg>
          </button>
          <div v-if="projectsOpen" class="project-menu">
            <button
              v-for="p in project.projects"
              :key="p.id"
              class="project-menu-item"
              :class="{ active: p.id === project.projectId }"
              @click="switchProject(p.id)"
            >
              <span class="project-menu-title">{{ p.title }}</span>
              <span class="project-menu-meta">{{ t('shell.shotsCount', { n: p.shotCount ?? 0 }) }}</span>
            </button>
            <router-link to="/projects" class="project-menu-link" @click="projectsOpen = false">{{ t('shell.projectList') }}</router-link>
          </div>
        </div>
        <WorkspaceNav />
        <div class="spacer" />
        <button class="ghost queue-button" @click="render.drawerOpen = true">
          {{ t('common.renderQueue') }}
          <span v-if="activeJobCount()" class="badge accent no-dot">{{ activeJobCount() }}</span>
        </button>
        <router-link
          to="/settings"
          class="ghost-link system-link"
          :title="health?.ffmpeg.available === false ? t('shell.ffmpegUnavailable') : t('shell.systemSettings')"
        >
          <span v-if="health?.ffmpeg.available === false" class="system-alert" />
          {{ t('nav.settings') }}
        </router-link>
      </template>

      <button class="ghost locale-toggle" :title="localeTitle()" @click="cycleLocale">
        {{ localeLabel() }}
      </button>
      <button class="ghost theme-toggle" :title="theme.theme === 'light' ? t('shell.darkTheme') : t('shell.lightTheme')" @click="theme.toggle()">
        {{ theme.theme === 'light' ? '☾' : '☀' }}
      </button>
    </header>

    <ProjectGuideBar v-if="project.current && route.path !== '/quick'" :summary="projectGuide" />

    <main class="main">
      <!-- Project data is server-scoped. Remount the active page whenever the
           project changes so deterministic ids such as shot-001 from the old
           project can never be submitted into the newly opened project. -->
      <router-view :key="`${project.projectId ?? 'none'}:${$route.fullPath}`" />
    </main>

    <RenderQueueDrawer v-if="render.drawerOpen" @close="render.drawerOpen = false" />
    <ToastHost />
    <ConfirmHost />
  </div>
</template>

<style scoped>
.shell { display: flex; flex-direction: column; height: 100%; }
.topbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 18px;
  height: 54px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--bg-2) 86%, transparent);
  backdrop-filter: blur(10px);
  position: sticky;
  top: 0;
  z-index: 20;
}
.brand { display: flex; align-items: center; text-decoration: none; flex-shrink: 0; }
.brand-logo { height: 50px; width: auto; display: block; }
.brand-name { font-size: 18px; font-weight: 600; color: var(--text); font-family: var(--serif); letter-spacing: 0.02em; }
.spacer { flex: 1; }
.project-switch { position: relative; flex-shrink: 1; min-width: 0; }
.project-switch-btn {
  display: flex; align-items: center; gap: 6px;
  max-width: 190px;
  padding: 5px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-2);
  color: var(--text);
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
}
.project-switch-btn:hover { border-color: var(--line-2); background: var(--bg-subtle); }
.caret { width: 14px; height: 14px; fill: none; stroke: var(--text-3); stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.project-menu {
  position: absolute; right: 0; top: calc(100% + 6px);
  min-width: 240px;
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--shadow-2);
  padding: 6px;
  z-index: 40;
}
.project-menu-item {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 7px;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 13px;
  color: var(--text);
  text-align: left;
}
.project-menu-item:hover { background: var(--bg-subtle); }
.project-menu-item.active { background: var(--accent-soft); color: var(--accent-text); font-weight: 600; }
.project-menu-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.project-menu-meta { font-size: 11px; color: var(--text-3); flex-shrink: 0; }
.project-menu-link {
  display: block;
  margin-top: 4px;
  padding: 8px 10px;
  border-top: 1px solid var(--line);
  color: var(--text-2);
  font-size: 12.5px;
  text-decoration: none;
  border-radius: 0 0 7px 7px;
}
.project-menu-link:hover { color: var(--text); text-decoration: none; }
.project-title { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghost-link { color: var(--text-2); font-size: 13px; padding: 6px 9px; border-radius: 7px; }
.ghost-link:hover { color: var(--text); background: var(--bg-subtle); text-decoration: none; }
.queue-button { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.system-link { position: relative; white-space: nowrap; }
.system-alert { position: absolute; top: 4px; right: 3px; width: 6px; height: 6px; border-radius: 50%; background: var(--bad); box-shadow: 0 0 0 2px var(--bg-2); }
.theme-toggle { font-size: 15px; padding: 5px 9px; }
.main { flex: 1; overflow: auto; }
.main :deep(.page) { max-width: 1080px; margin: 0 auto; padding: 18px 22px; }
</style>
