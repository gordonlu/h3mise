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

// Top-level IA: Story / Shots / Assets / Timeline.
const nav = [
  { to: '/story', label: () => t('nav.story') },
  { to: '/shots', label: () => t('nav.shots') },
  { to: '/assets', label: () => t('nav.assets') },
  { to: '/timeline', label: () => t('nav.timeline') },
];

function activeJobCount(): number {
  return render.jobs.filter((j: RenderJob) => ['UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING'].includes(j.status)).length;
}

async function switchProject(id: string) {
  projectsOpen.value = false;
  if (id === project.projectId) return;
  try {
    await project.openProject(id);
    await project.refreshProjects();
    await render.refresh();
    await refreshProjectGuide();
    toasts.push({ kind: 'ok', text: `已切换到项目：${project.current?.config.title ?? id}` });
  } catch (e) {
    toasts.push({ kind: 'err', text: `切换项目失败：${e instanceof Error ? e.message : e}` });
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
  switch (e.type) {
    case 'render.job.succeeded':
      toasts.push({ kind: 'ok', text: `渲染成功，Take 已就绪（Shot ${e.shotId}）`, actionLabel: '去选片', actionTo: `/shots/${e.shotId}` });
      break;
    case 'render.job.failed':
      toasts.push({ kind: 'err', text: `渲染失败（Shot ${e.shotId}）：${e.error?.slice(0, 120) ?? ''}`, actionLabel: '查看', actionTo: `/shots/${e.shotId}` });
      break;
    case 'take.selected':
      toasts.push({ kind: 'info', text: `已选片（Shot ${e.shotId}）` });
      break;
    case 'continuity.committed':
      toasts.push({ kind: 'ok', text: `${e.scope === 'visual' ? '视觉' : '叙事'}连续性已提交（Shot ${e.shotId}）` });
      break;
    case 'render.job.created':
      toasts.push({ kind: 'info', text: `渲染任务已创建（Shot ${e.shotId}）` });
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

      <nav v-if="project.current" class="nav">
        <router-link v-for="n in nav" :key="n.to" :to="n.to" class="nav-item" active-class="active">
          {{ n.label() }}
        </router-link>
      </nav>

      <div class="spacer" />

      <template v-if="project.current">
        <div ref="projectsRef" class="project-switch" :class="{ open: projectsOpen }">
          <button class="project-switch-btn" @click="projectsOpen = !projectsOpen">
            <span class="project-title" :title="project.current.meta.id">{{ project.current.config.title }}</span>
            <span class="caret">▾</span>
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
              <span class="project-menu-meta">{{ p.shotCount }} shots</span>
            </button>
            <router-link to="/projects" class="project-menu-link" @click="projectsOpen = false">项目列表…</router-link>
          </div>
        </div>
        <span v-if="!health?.ffmpeg.available" class="badge bad">ffmpeg missing</span>
        <span
          :class="['badge', health?.runningHubConfigured ? 'ok' : 'warn']"
          :title="health?.runningHubConfigured ? 'RUNNINGHUB_API_KEY set' : 'RUNNINGHUB_API_KEY not set'"
        >
          RH {{ health?.runningHubConfigured ? '✓' : '—' }}
        </span>
        <span
          :class="['badge', health?.aiConfigured ? 'ok' : 'no-dot muted']"
          :title="health?.aiConfigured ? 'built-in AI configured' : 'built-in AI not configured (AI-optional)'"
        >
          AI {{ health?.aiConfigured ? '✓' : '—' }}
        </span>
        <button class="ghost" @click="render.drawerOpen = true">
          {{ t('common.renderQueue') }}
          <span v-if="activeJobCount()" class="badge accent no-dot">{{ activeJobCount() }}</span>
        </button>
        <router-link to="/settings" class="ghost-link">{{ t('nav.settings') }}</router-link>
      </template>

      <button class="ghost locale-toggle" :title="locale === 'zh' ? 'Switch to English' : '切换到中文'" @click="setLocale(locale === 'zh' ? 'en' : 'zh')">
        {{ locale === 'zh' ? '中' : 'EN' }}
      </button>
      <button class="ghost theme-toggle" :title="theme.theme === 'light' ? '切换到深色主题' : '切换到浅色主题'" @click="theme.toggle()">
        {{ theme.theme === 'light' ? '☾' : '☀' }}
      </button>
    </header>

    <ProjectGuideBar v-if="project.current" :summary="projectGuide" />

    <main class="main">
      <router-view :key="$route.path" />
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
.brand-logo { height: 26px; width: auto; display: block; }
.brand-name { font-size: 18px; font-weight: 600; color: var(--text); font-family: var(--serif); letter-spacing: 0.02em; }
.nav { display: flex; gap: 4px; }
.nav-item {
  padding: 6px 14px;
  border-radius: 7px;
  color: var(--text-2);
  font-size: 13.5px;
  text-decoration: none;
  transition: all 0.13s;
}
.nav-item:hover { color: var(--text); background: var(--bg-subtle); text-decoration: none; }
.nav-item.active {
  color: var(--accent-text);
  background: var(--accent-soft);
  font-weight: 600;
  box-shadow: inset 0 -2px 0 var(--accent);
}
.spacer { flex: 1; }
.project-switch { position: relative; }
.project-switch-btn {
  display: flex; align-items: center; gap: 6px;
  max-width: 260px;
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
.caret { font-size: 10px; color: var(--text-3); }
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
.project-title { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghost-link { color: var(--text-2); font-size: 13px; padding: 6px 9px; border-radius: 7px; }
.ghost-link:hover { color: var(--text); background: var(--bg-subtle); text-decoration: none; }
.theme-toggle { font-size: 15px; padding: 5px 9px; }
.main { flex: 1; overflow: auto; }
</style>
