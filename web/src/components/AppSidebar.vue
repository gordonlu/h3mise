<script setup lang="ts">
// App sidebar — the single navigation surface. Replaces the topbar nav
// groups and the project guide bar: workflow stages with live counts, the
// project's next action, and global utilities.
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { ProjectGuideSummary } from '@h3mise/shared';
import { useProjectStore } from '../stores/project';
import { useRenderStore } from '../stores/render';
import { useAiStore } from '../stores/ai';
import { useThemeStore } from '../stores/theme';
import { locale, setLocale, t } from '../stores/locale';

const props = defineProps<{
  guide: ProjectGuideSummary | null;
  ffmpegAvailable: boolean | null;
  onSwitch: (id: string) => Promise<void>;
}>();
const emit = defineEmits<{ palette: [] }>();

const route = useRoute();
const router = useRouter();
const project = useProjectStore();
const render = useRenderStore();
const ai = useAiStore();
const theme = useThemeStore();

const projectsOpen = ref(false);
const brainOpen = ref(false);
const root = ref<HTMLElement | null>(null);

function onClickOutside(e: MouseEvent): void {
  if (root.value && !root.value.contains(e.target as Node)) {
    projectsOpen.value = false;
    brainOpen.value = false;
  }
}
onMounted(() => document.addEventListener('mousedown', onClickOutside));
onUnmounted(() => document.removeEventListener('mousedown', onClickOutside));

// --- icons: stroke paths drawn on a 24x24 canvas ---------------------------
const ICONS: Record<string, string[]> = {
  story: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6'],
  shots: ['M3 6h18v12H3z', 'M7 6v12', 'M17 6v12', 'M3 10h4', 'M3 14h4', 'M17 10h4', 'M17 14h4'],
  assets: ['M3 7h6l2 2h10v10H3z', 'M3 7V5h6l1 2'],
  timeline: ['M3 7h16', 'M3 12h20', 'M3 17h11'],
  storyboard: ['M4 4h6v6H4z', 'M14 4h6v6h-6z', 'M4 14h6v6H4z', 'M14 14h6v6h-6z'],
  breakdown: ['M3 5h18v14H3z', 'M10 9.5l5 2.5-5 2.5z'],
  quick: ['M6 4l12 12', 'M18 4L6 16', 'M6.5 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M17.5 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'],
  settings: ['M4 7h10', 'M18 7h2', 'M4 12h4', 'M12 12h8', 'M4 17h12', 'M20 17h0'],
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M16 16l5 5'],
  queue: ['M4 5h16v14H4z', 'M10 9l5 3-5 3z'],
  bolt: ['M13 2 4 14h6l-1 8 9-12h-6l1-8z'],
  board: ['M4 5h16v14H4z', 'M4 9h16'],
  film: ['M3 6h18v12H3z', 'M7 6v12', 'M17 6v12'],
};

interface NavItem {
  to: string;
  label: string;
  icon: string;
  count?: number;
  attention?: boolean;
  warn?: boolean;
}

function isActive(to: string): boolean {
  if (to === '/shots') return route.path === '/shots' || route.path.startsWith('/shots/');
  if (to === '/assets') return route.path.startsWith('/assets');
  return route.path === to;
}

function needsAttention(to: string): boolean {
  const target = props.guide?.attention?.to ?? '';
  if (to === '/story') return target.startsWith('/story');
  if (to === '/shots') return target.startsWith('/shots');
  if (to === '/timeline') return target.startsWith('/timeline');
  return false;
}

const sections = computed(() => [
  {
    key: 'prepare',
    label: t('nav.prepare'),
    items: [
      { to: '/story', label: t('nav.storyBeats'), icon: 'story', attention: needsAttention('/story') },
      { to: '/shots', label: t('nav.shotWorkspace'), icon: 'shots', count: props.guide?.shotCount, attention: needsAttention('/shots') },
      { to: '/assets', label: t('nav.assetLibrary'), icon: 'assets' },
      { to: '/assets?tab=media', label: t('nav.referenceBreakdown'), icon: 'breakdown' },
    ] as NavItem[],
  },
  {
    key: 'professional',
    label: t('nav.professional'),
    items: [
      { to: '/timeline', label: t('nav.timelineExport'), icon: 'timeline', count: props.guide?.timelineClipCount, attention: needsAttention('/timeline') },
      { to: '/quick', label: t('nav.quickEdit'), icon: 'quick' },
      { to: '/storyboard', label: t('nav.storyboard'), icon: 'storyboard' },
      { to: '/settings', label: t('nav.settings'), icon: 'settings', warn: props.ffmpegAvailable === false },
    ] as NavItem[],
  },
]);

const attention = computed(() => props.guide?.attention ?? null);
const activeJobs = computed(() => render.jobs.filter((j) => ['LOCAL_QUEUED', 'UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING'].includes(j.status)).length);

function brainLabel(): string {
  if (ai.agentAttached) return t('brain.externalAgent');
  if (ai.configured) return t('brain.projectAi');
  return t('brain.offline');
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

async function pickProject(id: string): Promise<void> {
  projectsOpen.value = false;
  await props.onSwitch(id);
}
</script>

<template>
  <aside ref="root" class="side" :aria-label="t('nav.workspaceAria')">
    <router-link to="/projects" class="side-brand">
      <img src="/h3mise-logo.png" alt="H3Mise" />
    </router-link>

    <template v-if="project.current">
      <div class="side-project">
        <button class="side-project-btn" :class="{ open: projectsOpen }" @click="projectsOpen = !projectsOpen">
          <span class="side-project-title">{{ project.current.config.title }}</span>
          <svg viewBox="0 0 16 16" class="chev"><path d="m4 6 4 4 4-4" /></svg>
        </button>
        <div v-if="projectsOpen" class="side-project-menu">
          <button
            v-for="p in project.projects"
            :key="p.id"
            class="side-project-item"
            :class="{ active: p.id === project.projectId }"
            @click="pickProject(p.id)"
          >
            <span class="side-project-name">{{ p.title }}</span>
            <span class="side-project-meta">{{ t('shell.shotsCount', { n: p.shotCount ?? 0 }) }}</span>
          </button>
          <router-link to="/projects" class="side-project-all" @click="projectsOpen = false">{{ t('shell.projectList') }}</router-link>
        </div>
      </div>

      <router-link to="/production" class="side-oneclick" :class="{ active: route.path === '/production' }">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path v-for="d in ICONS.bolt" :key="d" :d="d" /></svg>
        <span>{{ t('nav.oneClick') }}</span>
      </router-link>
    </template>
    <div v-else class="side-empty muted">{{ t('nav.sideNoProject') }}</div>

    <nav v-for="section in sections" :key="section.key" class="side-section" :aria-label="section.label">
      <div class="side-section-label">{{ section.label }}</div>
      <router-link
        v-for="item in section.items"
        :key="item.to"
        :to="item.to"
        class="side-item"
        :class="{ active: isActive(item.to) }"
      >
        <svg class="side-icon" viewBox="0 0 24 24" aria-hidden="true"><path v-for="d in ICONS[item.icon]" :key="d" :d="d" /></svg>
        <span class="side-label">{{ item.label }}</span>
        <span v-if="item.warn" class="side-warn" :title="t('shell.ffmpegUnavailable')" />
        <span v-else-if="item.attention" class="side-dot" />
        <span v-if="item.count !== undefined" class="side-count">{{ item.count }}</span>
      </router-link>
    </nav>

    <div class="side-spacer" />

    <template v-if="project.current && attention">
      <div class="side-next">
        <div class="side-next-kicker">{{ t('nav.sideNext') }}</div>
        <strong>{{ attention.title }}</strong>
        <span class="side-next-desc">{{ attention.description }}</span>
        <button class="primary sm" @click="router.push(attention.to)">{{ t('nav.sideGo') }}</button>
      </div>
      <div v-if="guide" class="side-progress">
        <span>{{ t('nav.sideProgress', { selected: guide.selectedTakeCount, total: guide.shotCount }) }}</span>
        <div class="side-progress-track"><i :style="{ width: guide.shotCount ? `${Math.round((guide.selectedTakeCount / guide.shotCount) * 100)}%` : '0%' }" /></div>
      </div>
    </template>

    <div class="side-utils">
      <button class="side-util" :title="t('nav.sidePalette')" @click="emit('palette')">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path v-for="d in ICONS.search" :key="d" :d="d" /></svg>
        <span>{{ t('nav.sidePalette') }}</span>
        <span class="kbd">⌘K</span>
      </button>

      <div class="side-brain">
        <button class="side-util" :title="t('brain.title')" @click="brainOpen = !brainOpen">
          <span class="brain-dot" :class="{ attached: ai.agentAttached, offline: !ai.agentAttached && !ai.configured }" />
          <span>{{ brainLabel() }}</span>
          <span v-if="ai.pendingCount" class="badge accent no-dot">{{ ai.pendingCount }}</span>
        </button>
        <div v-if="brainOpen" class="side-brain-menu">
          <div class="side-brain-copy">
            <strong>{{ brainLabel() }}</strong>
            <small v-if="ai.agentAttached">{{ ai.agentLabel ?? t('brain.noModel') }}</small>
            <small v-else-if="ai.configured">{{ ai.status?.model ?? t('brain.noModel') }}</small>
            <small v-else>{{ t('brain.noModel') }}</small>
          </div>
          <div v-if="ai.pendingRequests.length" class="side-brain-pending">
            <div class="side-brain-pending-title">{{ t('brain.pending') }}</div>
            <div v-for="request in ai.pendingRequests" :key="request.id" class="side-brain-row">
              <span class="mono">{{ request.id }}</span>
              <span class="side-brain-action">{{ request.action }}</span>
              <button class="ghost side-cancel" :title="t('common.cancel')" @click="ai.cancelRequest(request.id)">✕</button>
            </div>
          </div>
          <button v-if="ai.agentAttached" class="ghost side-brain-detach" @click="ai.detachAgent()">{{ t('brain.detach') }}</button>
        </div>
      </div>

      <button class="side-util" @click="render.drawerOpen = true">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path v-for="d in ICONS.queue" :key="d" :d="d" /></svg>
        <span>{{ t('common.renderQueue') }}</span>
        <span v-if="activeJobs" class="badge accent no-dot">{{ activeJobs }}</span>
      </button>

      <div class="side-toggles">
        <button class="side-toggle" :title="localeTitle()" @click="cycleLocale">{{ localeLabel() }}</button>
        <button class="side-toggle" :title="theme.theme === 'light' ? t('shell.darkTheme') : t('shell.lightTheme')" @click="theme.toggle()">
          {{ theme.theme === 'light' ? '☾' : '☀' }}
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.side {
  width: 100%;
  height: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 12px 14px;
  border-right: 1px solid var(--line);
  background: var(--bg-2);
  overflow-y: auto;
  overflow-x: hidden;
}
.side-brand { display: flex; align-items: center; padding: 2px 6px 8px; }
.side-brand img { height: 34px; width: auto; display: block; }

.side-project { position: relative; margin-bottom: 8px; }
.side-project-btn {
  width: 100%;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 8px 10px; border: 1px solid var(--line); border-radius: 9px;
  background: var(--bg-subtle); color: var(--text); font-weight: 600; font-size: 13px;
  box-shadow: none;
}
.side-project-btn:hover, .side-project-btn.open { border-color: var(--line-2); background: var(--bg-3); }
.side-project-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chev { width: 14px; height: 14px; fill: none; stroke: var(--text-3); stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.side-project-menu {
  position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: 40;
  padding: 6px; border: 1px solid var(--line); border-radius: 10px;
  background: var(--bg-2); box-shadow: var(--shadow-2);
}
.side-project-item {
  width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 7px 9px; border: none; border-radius: 7px; background: none; box-shadow: none;
  color: var(--text); font-size: 12.5px; text-align: left;
}
.side-project-item:hover { background: var(--bg-subtle); }
.side-project-item.active { background: var(--accent-soft); color: var(--accent-text); font-weight: 600; }
.side-project-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-project-meta { color: var(--text-3); font-size: 10.5px; flex: none; }
.side-project-all { display: block; margin-top: 4px; padding: 7px 9px; border-top: 1px solid var(--line); color: var(--text-2); font-size: 12px; }

.side-oneclick {
  display: flex; align-items: center; justify-content: center; gap: 7px;
  padding: 9px 12px; margin-bottom: 6px; border-radius: 9px;
  background: var(--accent); color: #fff; font-weight: 650; font-size: 13px;
  text-decoration: none;
}
.side-oneclick svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linejoin: round; }
.side-oneclick:hover { background: var(--accent-2); text-decoration: none; }
.side-oneclick.active { background: var(--accent-3); }

.side-empty { padding: 10px 8px; font-size: 12px; }

.side-section { margin-top: 10px; display: flex; flex-direction: column; gap: 1px; }
.side-section-label {
  padding: 4px 8px; color: var(--text-3);
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em;
}
.side-item {
  position: relative;
  display: flex; align-items: center; gap: 9px;
  padding: 7px 9px; border-radius: 8px;
  color: var(--text-2); font-size: 13px; text-decoration: none;
}
.side-item:hover { background: var(--bg-subtle); color: var(--text); text-decoration: none; }
.side-item.active { background: var(--accent-soft); color: var(--accent-text); font-weight: 600; }
.side-item.active::before {
  content: ''; position: absolute; left: -12px; top: 6px; bottom: 6px; width: 3px;
  border-radius: 0 3px 3px 0; background: var(--accent);
}
.side-icon { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; opacity: 0.85; }
.side-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-count { flex: none; font-size: 10.5px; color: var(--text-3); background: var(--bg-subtle); border-radius: 999px; padding: 1px 7px; }
.side-item.active .side-count { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent-text); }
.side-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.side-warn { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--bad); }

.side-spacer { flex: 1; min-height: 10px; }

.side-next {
  display: grid; gap: 4px;
  margin-top: 10px; padding: 11px 12px;
  border: 1px solid var(--accent-line); border-radius: 10px;
  background: var(--accent-soft);
}
.side-next-kicker { font-size: 10px; font-weight: 700; letter-spacing: 0.08em; color: var(--accent-text); }
.side-next strong { font-size: 12.5px; line-height: 1.4; }
.side-next-desc { color: var(--text-2); font-size: 11px; line-height: 1.5; }
.side-next .primary { justify-self: start; margin-top: 3px; }

.side-progress { padding: 8px 4px 0; display: grid; gap: 5px; }
.side-progress > span { font-size: 11px; color: var(--text-3); }
.side-progress-track { height: 4px; border-radius: 999px; background: var(--bg-muted); overflow: hidden; }
.side-progress-track i { display: block; height: 100%; background: var(--accent); border-radius: 999px; transition: width 0.3s; }

.side-utils { display: flex; flex-direction: column; gap: 2px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); }
.side-util {
  display: flex; align-items: center; gap: 9px; width: 100%;
  padding: 7px 9px; border: none; border-radius: 8px; background: none; box-shadow: none;
  color: var(--text-2); font-size: 12.5px; text-align: left;
}
.side-util:hover { background: var(--bg-subtle); color: var(--text); }
.side-util svg { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; opacity: 0.85; }
.side-util .kbd { margin-left: auto; }
.side-brain { position: relative; }
.side-brain-menu {
  position: absolute; left: 0; right: 0; bottom: calc(100% + 8px); z-index: 45;
  padding: 10px; border: 1px solid var(--line); border-radius: 10px;
  background: var(--bg-2); box-shadow: var(--shadow-2);
}
.side-brain-copy { display: grid; gap: 1px; padding: 2px 4px 8px; }
.side-brain-copy strong { font-size: 12.5px; }
.side-brain-copy small { color: var(--text-3); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-brain-pending { border-top: 1px solid var(--line); padding-top: 7px; display: grid; gap: 4px; }
.side-brain-pending-title { color: var(--text-3); font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; padding: 0 4px; }
.side-brain-row { display: flex; align-items: center; gap: 7px; padding: 5px 6px; border-radius: 7px; background: var(--bg-subtle); font-size: 11px; }
.side-brain-row .mono { color: var(--text-3); }
.side-brain-action { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-cancel { padding: 1px 7px; font-size: 11px; color: var(--text-3); }
.side-cancel:hover { color: var(--bad); }
.side-brain-detach { width: 100%; margin-top: 7px; font-size: 12px; }
.brain-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); flex: none; }
.brain-dot.attached { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.brain-dot.offline { background: var(--line-3); }

.side-toggles { display: flex; gap: 4px; margin-top: 6px; padding: 0 3px; }
.side-toggle {
  flex: 1; padding: 6px; border: 1px solid var(--line); border-radius: 8px; background: none; box-shadow: none;
  color: var(--text-2); font-size: 12px;
}
.side-toggle:hover { background: var(--bg-subtle); border-color: var(--line-2); }
</style>
