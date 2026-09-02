<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { t } from '../stores/locale';

type GroupKey = 'prepare' | 'professional';

const route = useRoute();
const root = ref<HTMLElement | null>(null);
const openGroup = ref<GroupKey | null>(null);

const groups: Array<{
  key: GroupKey;
  label: () => string;
  items: Array<{ to: string; label: () => string; description: () => string }>;
}> = [
  {
    key: 'prepare',
    label: () => t('nav.prepare'),
    items: [
      { to: '/story', label: () => t('nav.storyBeats'), description: () => t('nav.storyBeatsDesc') },
      { to: '/storyboard', label: () => t('nav.storyboard'), description: () => t('nav.storyboardDesc') },
      { to: '/assets', label: () => t('nav.assetLibrary'), description: () => t('nav.assetLibraryDesc') },
    ],
  },
  {
    key: 'professional',
    label: () => t('nav.professional'),
    items: [
      { to: '/shots', label: () => t('nav.shotWorkspace'), description: () => t('nav.shotWorkspaceDesc') },
      { to: '/quick', label: () => t('nav.quickEdit'), description: () => t('nav.quickEditDesc') },
      { to: '/timeline', label: () => t('nav.timelineExport'), description: () => t('nav.timelineExportDesc') },
    ],
  },
];

function isItemActive(to: string): boolean {
  return route.path === to || (to === '/shots' && route.path.startsWith('/shots/'));
}

function isGroupActive(group: (typeof groups)[number]): boolean {
  return group.items.some((item) => isItemActive(item.to));
}

function toggle(group: GroupKey) {
  openGroup.value = openGroup.value === group ? null : group;
}

function closeOutside(event: MouseEvent) {
  if (root.value && !root.value.contains(event.target as Node)) openGroup.value = null;
}

function closeOnEscape(event: KeyboardEvent) {
  if (event.key === 'Escape') openGroup.value = null;
}

watch(() => route.fullPath, () => { openGroup.value = null; });
onMounted(() => {
  document.addEventListener('mousedown', closeOutside);
  document.addEventListener('keydown', closeOnEscape);
});
onUnmounted(() => {
  document.removeEventListener('mousedown', closeOutside);
  document.removeEventListener('keydown', closeOnEscape);
});
</script>

<template>
  <nav ref="root" class="workspace-nav" :aria-label="t('nav.workspaceAria')">
    <router-link to="/production" class="one-click" active-class="active">
      <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M11.7 1.8 4.6 11h4l-.5 7.2 7.3-9.5h-4.2l.5-6.9Z" /></svg>
      <span>{{ t('nav.oneClick') }}</span>
    </router-link>

    <div v-for="group in groups" :key="group.key" class="nav-group" :class="{ open: openGroup === group.key }">
      <button
        class="group-trigger"
        :class="{ active: isGroupActive(group) }"
        :aria-expanded="openGroup === group.key"
        aria-haspopup="menu"
        @click="toggle(group.key)"
      >
        <span>{{ group.label() }}</span>
        <svg class="chevron" aria-hidden="true" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" /></svg>
      </button>

      <div v-if="openGroup === group.key" class="group-menu" role="menu">
        <router-link
          v-for="item in group.items"
          :key="item.to"
          :to="item.to"
          class="group-item"
          :class="{ active: isItemActive(item.to) }"
          role="menuitem"
        >
          <span class="item-copy"><strong>{{ item.label() }}</strong><small>{{ item.description() }}</small></span>
          <svg aria-hidden="true" viewBox="0 0 16 16"><path d="m6 3 5 5-5 5" /></svg>
        </router-link>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.workspace-nav { display: flex; align-items: center; gap: 5px; flex-shrink: 0; }
.one-click, .group-trigger {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 7px 12px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  text-decoration: none;
  white-space: nowrap;
}
.one-click { color: #fff; background: var(--accent); border: 1px solid var(--accent); }
.one-click:hover { color: #fff; background: var(--accent-2); text-decoration: none; }
.one-click.active { background: var(--accent-3); border-color: var(--accent-3); }
.one-click svg { width: 15px; height: 15px; fill: currentColor; }
.nav-group { position: relative; }
.group-trigger { color: var(--text-2); background: transparent; border-color: transparent; box-shadow: none; }
.group-trigger:hover, .nav-group.open .group-trigger { color: var(--text); background: var(--bg-subtle); }
.group-trigger.active { color: var(--accent-text); background: var(--accent-soft); }
.chevron { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; transition: transform .15s; }
.nav-group.open .chevron { transform: rotate(180deg); }
.group-menu {
  position: absolute;
  left: 0;
  top: calc(100% + 8px);
  width: 282px;
  padding: 7px;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: var(--bg-2);
  box-shadow: var(--shadow-2);
  z-index: 45;
}
.group-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 11px;
  border-radius: 8px;
  color: var(--text);
  text-decoration: none;
}
.group-item:hover { background: var(--bg-subtle); text-decoration: none; }
.group-item.active { color: var(--accent-text); background: var(--accent-soft); }
.item-copy { display: grid; gap: 2px; flex: 1; min-width: 0; }
.item-copy strong { font-size: 13px; line-height: 1.35; }
.item-copy small { color: var(--text-3); font-size: 11px; line-height: 1.4; }
.group-item.active small { color: color-mix(in srgb, var(--accent-text) 72%, var(--text-3)); }
.group-item > svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; opacity: .5; }
</style>
