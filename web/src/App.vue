<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { useProjectStore } from './stores/project';
import { useRenderStore } from './stores/render';
import { subscribeEvents, get } from './api/client';
import RenderQueueDrawer from './components/RenderQueueDrawer.vue';
import type { AppEvent, RenderJob } from '@h3mise/shared';

const project = useProjectStore();
const render = useRenderStore();
const health = ref<{ ffmpeg: { available: boolean }; runningHubConfigured: boolean; aiConfigured: boolean } | null>(null);
let off: (() => void) | null = null;

const nav = [
  { to: '/shots', label: 'Shots' },
  { to: '/story', label: 'Story' },
  { to: '/assets', label: 'Assets' },
  { to: '/timeline', label: 'Timeline' },
];

function activeJobCount(): number {
  return render.jobs.filter((j: RenderJob) => ['UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING'].includes(j.status)).length;
}

onMounted(async () => {
  await project.bootstrap();
  await render.refresh();
  try {
    health.value = await get('/api/health');
  } catch {
    /* server down */
  }
  off = subscribeEvents((e: AppEvent) => {
    render.onEvent(e.type, e as unknown as Record<string, unknown>);
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
          :class="['badge', health?.aiConfigured ? 'ok' : 'muted']"
          :title="health?.aiConfigured ? 'built-in AI configured' : 'built-in AI not configured (AI-optional)'"
        >
          AI {{ health?.aiConfigured ? '✓' : '—' }}
        </span>
        <button class="ghost" @click="render.drawerOpen = true">
          渲染队列
          <span v-if="activeJobCount()" class="badge accent">{{ activeJobCount() }}</span>
        </button>
        <router-link to="/settings" class="ghost-link">Settings</router-link>
      </template>
    </header>

    <main class="main">
      <router-view />
    </main>

    <RenderQueueDrawer v-if="render.drawerOpen" @close="render.drawerOpen = false" />
  </div>
</template>

<style scoped>
.shell { display: flex; flex-direction: column; height: 100%; }
.topbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 18px;
  height: 52px;
  border-bottom: 1px solid var(--line);
  background: rgba(17, 20, 24, 0.85);
  backdrop-filter: blur(8px);
  position: sticky;
  top: 0;
  z-index: 20;
}
.brand { display: flex; align-items: baseline; gap: 6px; text-decoration: none; }
.brand-mark {
  font-family: var(--mono);
  font-weight: 700;
  font-size: 17px;
  color: #201503;
  background: linear-gradient(180deg, #f0b14e, var(--accent-2));
  padding: 2px 7px;
  border-radius: 6px;
  letter-spacing: -0.5px;
}
.brand-name { font-size: 17px; font-weight: 600; color: var(--text); }
.nav { display: flex; gap: 4px; }
.nav-item {
  padding: 6px 13px;
  border-radius: 6px;
  color: var(--text-2);
  font-size: 13.5px;
  text-decoration: none;
}
.nav-item:hover { color: var(--text); background: var(--bg-3); text-decoration: none; }
.nav-item.active { color: var(--accent); background: var(--bg-3); }
.spacer { flex: 1; }
.project-title { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghost-link { color: var(--text-2); font-size: 13px; padding: 6px 8px; border-radius: 6px; }
.ghost-link:hover { color: var(--text); background: var(--bg-3); text-decoration: none; }
.main { flex: 1; overflow: auto; }
</style>
