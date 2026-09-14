<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useProjectStore } from './stores/project';
import { useRenderStore } from './stores/render';
import { useToastStore } from './stores/toast';
import { useThemeStore } from './stores/theme';
import { useAiStore } from './stores/ai';
import { locale, setLocale, t } from './stores/locale';
import { subscribeEvents, get } from './api/client';
import RenderQueueDrawer from './components/RenderQueueDrawer.vue';
import ToastHost from './components/ToastHost.vue';
import ConfirmHost from './components/ConfirmHost.vue';
import type { AppEvent, RenderJob } from '@h3mise/shared';
import type { ProjectGuideSummary } from '@h3mise/shared';
import ProjectGuideBar from './components/ProjectGuideBar.vue';
import WorkspaceNav from './components/WorkspaceNav.vue';
import CommandPalette from './components/CommandPalette.vue';

const project = useProjectStore();
const route = useRoute();
const render = useRenderStore();
const toasts = useToastStore();
const theme = useThemeStore();
const ai = useAiStore();
const health = ref<{ ffmpeg: { available: boolean }; runningHubConfigured: boolean; aiConfigured: boolean } | null>(null);
const projectsOpen = ref(false);
const paletteOpen = ref(false);
const brainOpen = ref(false);
const projectGuide = ref<ProjectGuideSummary | null>(null);
const projectsRef = ref<HTMLElement | null>(null);
const brainRef = ref<HTMLElement | null>(null);
let off: (() => void) | null = null;
let aiTimer: number | undefined;

/** Brain indicator — who provides inference in this session. */
function brainLabel(): string {
  if (ai.agentAttached) return t('brain.externalAgent');
  if (ai.configured) return t('brain.projectAi');
  return t('brain.offline');
}

function onGlobalKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    paletteOpen.value = !paletteOpen.value;
  }
}

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
  if (brainOpen.value && brainRef.value && !brainRef.value.contains(e.target as Node)) {
    brainOpen.value = false;
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
  void ai.refresh();
  aiTimer = window.setInterval(() => void ai.refresh(), 15_000);
  try {
    health.value = await get('/api/health');
  } catch {
    /* server down */
  }
  document.addEventListener('mousedown', onProjectsClickOutside);
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
  if (aiTimer) window.clearInterval(aiTimer);
  document.removeEventListener('mousedown', onProjectsClickOutside);
  document.removeEventListener('keydown', onGlobalKeydown);
});

watch(() => route.path, () => {
  void scheduleGuideRefresh();
});
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
        <button class="ghost palette-button" :title="t('palette.open')" @click="paletteOpen = true">
          <svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
          <span class="kbd">⌘K</span>
        </button>
        <div ref="brainRef" class="brain">
          <button
            class="ghost brain-button"
            :class="{ attached: ai.agentAttached }"
            :title="`${t('brain.title')}：${brainLabel()}${ai.agentLabel ? ` (${ai.agentLabel})` : ''}`"
            @click="brainOpen = !brainOpen"
          >
            <span class="brain-dot" :class="{ attached: ai.agentAttached, offline: !ai.agentAttached && !ai.configured }" />
            <span class="brain-label">{{ brainLabel() }}</span>
            <span v-if="ai.pendingCount" class="badge accent no-dot">{{ ai.pendingCount }}</span>
          </button>
          <div v-if="brainOpen" class="brain-menu">
            <div class="brain-row">
              <span class="brain-dot" :class="{ attached: ai.agentAttached, offline: !ai.agentAttached && !ai.configured }" />
              <div class="brain-copy">
                <strong>{{ brainLabel() }}</strong>
                <small v-if="ai.agentAttached">{{ ai.agentLabel ?? t('brain.noModel') }}</small>
                <small v-else-if="ai.configured">{{ ai.status?.model ?? t('brain.noModel') }}</small>
                <small v-else>{{ t('brain.noModel') }}</small>
              </div>
            </div>
            <div v-if="ai.pendingRequests.length" class="brain-pending">
              <div class="brain-pending-title">{{ t('brain.pending') }}</div>
              <div v-for="request in ai.pendingRequests" :key="request.id" class="brain-pending-row">
                <span class="mono">{{ request.id }}</span>
                <span class="brain-action">{{ request.action }}</span>
                <button class="ghost brain-cancel" :title="t('common.cancel')" @click="ai.cancelRequest(request.id)">✕</button>
              </div>
            </div>
            <button v-if="ai.agentAttached" class="ghost brain-detach" @click="ai.detachAgent()">{{ t('brain.detach') }}</button>
          </div>
        </div>
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

    <ProjectGuideBar v-if="project.current && route.path !== '/quick' && route.name !== 'reference-breakdown'" :summary="projectGuide" />

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
.shell { display: flex; flex-direction: column; height: 100%; }
.topbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 24px;
  height: 58px;
  border-bottom: 1px solid var(--line);
  background: color-mix(in srgb, var(--bg-2) 96%, transparent);
  backdrop-filter: blur(8px);
  position: sticky;
  top: 0;
  z-index: 20;
}
.brand { display: flex; align-items: center; text-decoration: none; flex-shrink: 0; }
.brand-logo { height: 46px; width: auto; display: block; }
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
.palette-button { display: inline-flex; align-items: center; gap: 7px; padding: 5px 9px; }
.palette-button svg { width: 15px; height: 15px; fill: none; stroke: var(--text-3); stroke-width: 1.6; stroke-linecap: round; }
.palette-button:hover svg { stroke: var(--text-2); }
.palette-button .kbd { font-size: 10px; }

/* brain indicator — who provides inference */
.brain { position: relative; }
.brain-button { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; padding: 5px 10px; }
.brain-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); flex: none; }
.brain-dot.attached { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.brain-dot.offline { background: var(--line-3); }
.brain-label { font-size: 12.5px; color: var(--text-2); }
.brain-button.attached .brain-label { color: var(--accent-text); font-weight: 600; }
.brain-menu {
  position: absolute; right: 0; top: calc(100% + 8px);
  width: 280px; padding: 10px;
  background: var(--bg-2); border: 1px solid var(--line); border-radius: 10px;
  box-shadow: var(--shadow-2); z-index: 45;
}
.brain-row { display: flex; align-items: center; gap: 10px; padding: 4px 6px 10px; }
.brain-copy { display: grid; gap: 1px; min-width: 0; }
.brain-copy strong { font-size: 13px; }
.brain-copy small { color: var(--text-3); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brain-pending { border-top: 1px solid var(--line); padding-top: 8px; display: grid; gap: 4px; }
.brain-pending-title { color: var(--text-3); font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 0 6px; }
.brain-pending-row { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 7px; background: var(--bg-subtle); font-size: 11.5px; }
.brain-pending-row .mono { color: var(--text-3); }
.brain-action { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brain-cancel { padding: 1px 7px; font-size: 11px; color: var(--text-3); }
.brain-cancel:hover { color: var(--bad); }
.brain-detach { width: 100%; margin-top: 8px; font-size: 12px; }
.system-link { position: relative; white-space: nowrap; }
.system-alert { position: absolute; top: 4px; right: 3px; width: 6px; height: 6px; border-radius: 50%; background: var(--bad); box-shadow: 0 0 0 2px var(--bg-2); }
.theme-toggle { font-size: 15px; padding: 5px 9px; }
.main { flex: 1; overflow: auto; }
.main :deep(.page) { width: 100%; max-width: 1440px; margin: 0 auto; padding: 24px 32px 48px; }
</style>
