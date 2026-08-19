<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useProjectStore } from './stores/project';
import { useRenderStore } from './stores/render';
import { useToastStore } from './stores/toast';
import { useThemeStore } from './stores/theme';
import { subscribeEvents, get } from './api/client';
import RenderQueueDrawer from './components/RenderQueueDrawer.vue';
import ToastHost from './components/ToastHost.vue';
import ConfirmHost from './components/ConfirmHost.vue';
import type { AppEvent, RenderJob } from '@h3mise/shared';

const project = useProjectStore();
const render = useRenderStore();
const toasts = useToastStore();
const theme = useThemeStore();
const health = ref<{ ffmpeg: { available: boolean }; runningHubConfigured: boolean; aiConfigured: boolean } | null>(null);
let off: (() => void) | null = null;

// PRD §4 top-level IA: Story / Shots / Assets / Timeline.
const nav = [
  { to: '/story', label: 'Story' },
  { to: '/shots', label: 'Shots' },
  { to: '/assets', label: 'Assets' },
  { to: '/timeline', label: 'Timeline' },
];

function activeJobCount(): number {
  return render.jobs.filter((j: RenderJob) => ['UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING'].includes(j.status)).length;
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
  try {
    health.value = await get('/api/health');
  } catch {
    /* server down */
  }
  off = subscribeEvents((e: AppEvent) => {
    render.onEvent(e.type, e as unknown as Record<string, unknown>);
    notify(e);
    if (e.type === 'take.created' || e.type === 'shot.updated' || e.type === 'continuity.committed' || e.type === 'project.updated') {
      void project.refreshCurrent();
    }
  });
});

onUnmounted(() => off?.());
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <router-link to="/projects" class="brand">
        <span class="brand-mark">H3</span>
        <span class="brand-name">Mise</span>
      </router-link>

      <nav v-if="project.current" class="nav">
        <router-link v-for="n in nav" :key="n.to" :to="n.to" class="nav-item" active-class="active">
          {{ n.label }}
        </router-link>
      </nav>

      <div class="spacer" />

      <template v-if="project.current">
        <span class="muted project-title" :title="project.current.meta.id">{{ project.current.config.title }}</span>
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
          渲染队列
          <span v-if="activeJobCount()" class="badge accent no-dot">{{ activeJobCount() }}</span>
        </button>
        <router-link to="/settings" class="ghost-link">Settings</router-link>
      </template>

      <button class="ghost theme-toggle" :title="theme.theme === 'light' ? '切换到深色主题' : '切换到浅色主题'" @click="theme.toggle()">
        {{ theme.theme === 'light' ? '☾' : '☀' }}
      </button>
    </header>

    <main class="main">
      <router-view />
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
.brand { display: flex; align-items: baseline; gap: 7px; text-decoration: none; }
.brand-mark {
  font-family: var(--mono);
  font-weight: 700;
  font-size: 16px;
  color: #fff;
  background: var(--accent);
  padding: 2.5px 8px;
  border-radius: 7px;
  letter-spacing: -0.5px;
}
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
.project-title { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghost-link { color: var(--text-2); font-size: 13px; padding: 6px 9px; border-radius: 7px; }
.ghost-link:hover { color: var(--text); background: var(--bg-subtle); text-decoration: none; }
.theme-toggle { font-size: 15px; padding: 5px 9px; }
.main { flex: 1; overflow: auto; }
</style>
