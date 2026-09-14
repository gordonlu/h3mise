<script setup lang="ts">
// Cmd/Ctrl+K command palette — keyboard-first navigation and quick actions.
// Shot search is lazy: the list is fetched once on open and filtered locally.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { get } from '../api/client';
import { t } from '../stores/locale';
import { useThemeStore } from '../stores/theme';
import { useRenderStore } from '../stores/render';

const emit = defineEmits<{ close: [] }>();
const router = useRouter();
const theme = useThemeStore();
const render = useRenderStore();

interface PaletteItem {
  id: string;
  group: 'navigation' | 'actions' | 'shots';
  label: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}

const query = ref('');
const cursor = ref(0);
const inputEl = ref<HTMLInputElement | null>(null);
const shots = ref<Array<{ id: string; title: string }>>([]);

function go(path: string, query?: Record<string, string>): () => void {
  return () => void router.push(query ? { path, query } : path);
}

const navItems: PaletteItem[] = [
  { id: 'nav.story', group: 'navigation', label: t('nav.storyBeats'), hint: '/story', run: go('/story') },
  { id: 'nav.storyboard', group: 'navigation', label: t('nav.storyboard'), hint: '/storyboard', run: go('/storyboard') },
  { id: 'nav.assets', group: 'navigation', label: t('nav.assetLibrary'), hint: '/assets', run: go('/assets') },
  { id: 'nav.breakdown', group: 'navigation', label: t('nav.referenceBreakdown'), hint: '/assets?tab=media', run: go('/assets', { tab: 'media' }) },
  { id: 'nav.shots', group: 'navigation', label: t('nav.shotWorkspace'), hint: '/shots', run: go('/shots') },
  { id: 'nav.quick', group: 'navigation', label: t('nav.quickEdit'), hint: '/quick', run: go('/quick') },
  { id: 'nav.timeline', group: 'navigation', label: t('nav.timelineExport'), hint: '/timeline', run: go('/timeline') },
  { id: 'nav.production', group: 'navigation', label: t('nav.oneClick'), hint: '/production', run: go('/production') },
  { id: 'nav.settings', group: 'navigation', label: t('nav.settings'), hint: '/settings', run: go('/settings') },
];

const actionItems: PaletteItem[] = [
  { id: 'action.theme', group: 'actions', label: t('palette.toggleTheme'), keywords: 'theme dark light 主题 暗色 亮色', run: () => theme.toggle() },
  { id: 'action.queue', group: 'actions', label: t('palette.renderQueue'), keywords: 'render queue 渲染 队列 任务', run: () => { render.drawerOpen = true; } },
];

const shotItems = computed<PaletteItem[]>(() =>
  shots.value.map((s) => ({
    id: `shot.${s.id}`,
    group: 'shots' as const,
    label: `${s.id} · ${s.title || s.id}`,
    run: go(`/shots/${s.id}`),
  })),
);

function matches(item: PaletteItem, q: string): boolean {
  if (!q) return true;
  return `${item.label} ${item.hint ?? ''} ${item.keywords ?? ''} ${item.id}`.toLowerCase().includes(q);
}

const groups = computed(() => {
  const q = query.value.trim().toLowerCase();
  return [
    { key: 'navigation', label: t('palette.navigation'), items: navItems.filter((i) => matches(i, q)) },
    { key: 'actions', label: t('palette.actions'), items: actionItems.filter((i) => matches(i, q)) },
    { key: 'shots', label: t('palette.shots'), items: q ? shotItems.value.filter((i) => matches(i, q)) : [] },
  ].filter((g) => g.items.length > 0);
});

const flat = computed(() => groups.value.flatMap((g) => g.items));

watch(flat, () => {
  cursor.value = Math.min(cursor.value, Math.max(0, flat.value.length - 1));
});
watch(query, () => (cursor.value = 0));
watch(cursor, async () => {
  await nextTick();
  document.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
});

function run(item: PaletteItem | undefined): void {
  if (!item) return;
  item.run();
  emit('close');
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    cursor.value = Math.min(cursor.value + 1, flat.value.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    cursor.value = Math.max(cursor.value - 1, 0);
  } else if (e.key === 'Enter') {
    run(flat.value[cursor.value]);
  } else if (e.key === 'Escape') {
    emit('close');
  }
}

function onGlobalEscape(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}

onMounted(async () => {
  inputEl.value?.focus();
  document.addEventListener('keydown', onGlobalEscape);
  try {
    shots.value = await get<Array<{ id: string; title: string }>>('/api/shots');
  } catch {
    shots.value = [];
  }
});
onUnmounted(() => document.removeEventListener('keydown', onGlobalEscape));
</script>

<template>
  <div class="palette-backdrop" @click.self="emit('close')">
    <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <div class="palette-input">
        <svg aria-hidden="true" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" /></svg>
        <input ref="inputEl" v-model="query" :placeholder="t('palette.placeholder')" @keydown="onKeydown" />
        <span class="kbd">esc</span>
      </div>
      <div v-if="flat.length" class="palette-list">
        <template v-for="group in groups" :key="group.key">
          <div class="palette-group">{{ group.label }}</div>
          <button
            v-for="item in group.items"
            :key="item.id"
            class="palette-item"
            :class="{ active: flat[cursor]?.id === item.id }"
            @mousemove="cursor = flat.findIndex((x) => x.id === item.id)"
            @click="run(item)"
          >
            <span class="item-label">{{ item.label }}</span>
            <span v-if="item.hint" class="item-hint">{{ item.hint }}</span>
          </button>
        </template>
      </div>
      <div v-else class="palette-empty">{{ t('palette.empty') }}</div>
    </div>
  </div>
</template>

<style scoped>
.palette-backdrop {
  position: fixed; inset: 0; z-index: 70;
  background: rgba(15, 15, 16, 0.42);
  backdrop-filter: blur(5px);
  display: flex; justify-content: center; align-items: flex-start;
  padding-top: 14vh;
  animation: palette-fade 0.12s;
}
.palette {
  width: 560px; max-width: calc(100vw - 48px);
  background: var(--bg-2); border: 1px solid var(--line);
  border-radius: 14px; box-shadow: var(--shadow-modal);
  overflow: hidden;
  animation: palette-in 0.16s cubic-bezier(0.2, 0.9, 0.3, 1.1);
}
.palette-input { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--line); }
.palette-input svg { width: 17px; height: 17px; fill: none; stroke: var(--text-3); stroke-width: 1.6; stroke-linecap: round; flex: none; }
.palette-input input {
  flex: 1; border: none; background: none; box-shadow: none; padding: 0;
  font-size: 15px; color: var(--text);
}
.palette-input input:focus { box-shadow: none; }
.palette-list { max-height: 46vh; overflow: auto; padding: 6px; }
.palette-group {
  padding: 9px 10px 4px; color: var(--text-3);
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase;
}
.palette-item {
  width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 9px 11px; border: none; border-radius: 8px; background: none; box-shadow: none;
  color: var(--text); font-size: 13.5px; text-align: left; cursor: pointer;
}
.palette-item:hover { background: var(--bg-subtle); }
.palette-item.active { background: var(--accent-soft); color: var(--accent-text); }
.palette-item .item-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 550; }
.palette-item .item-hint { flex: none; color: var(--text-3); font-size: 11px; font-family: var(--mono); }
.palette-item.active .item-hint { color: color-mix(in srgb, var(--accent-text) 70%, var(--text-3)); }
.palette-empty { padding: 28px 16px; text-align: center; color: var(--text-3); font-size: 13px; }
@keyframes palette-in { from { opacity: 0; transform: translateY(-6px) scale(0.985); } }
@keyframes palette-fade { from { opacity: 0; } }
</style>
