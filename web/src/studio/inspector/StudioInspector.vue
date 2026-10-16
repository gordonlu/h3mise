<script setup lang="ts">
import { computed, markRaw } from 'vue';
import { useRouter } from 'vue-router';
import { SHOT_USER_STATUS_LABEL, type CanvasNode, type ShotNodeData } from '@h3mise/shared';
import { useStudioStore } from '../../stores/studio';
import { t } from '../../stores/locale';
import EmptyInspector from './EmptyInspector.vue';
import MultiInspector from './MultiInspector.vue';
import StoryInspector from './StoryInspector.vue';
import BeatInspector from './BeatInspector.vue';
import ShotInspector from './ShotInspector.vue';
import TakesInspector from './TakesInspector.vue';
import EntityInspector from './EntityInspector.vue';
import MediaInspector from './MediaInspector.vue';
import StoryboardInspector from './StoryboardInspector.vue';
import TimelineInspector from './TimelineInspector.vue';
import DefaultInspector from './DefaultInspector.vue';

const emit = defineEmits<{ collapse: [] }>();
const store = useStudioStore();
const router = useRouter();

const bodies: Record<string, unknown> = {
  story: markRaw(StoryInspector),
  beat: markRaw(BeatInspector),
  shot: markRaw(ShotInspector),
  takes: markRaw(TakesInspector),
  entity: markRaw(EntityInspector),
  character_state: markRaw(EntityInspector),
  media: markRaw(MediaInspector),
  storyboard: markRaw(StoryboardInspector),
  timeline: markRaw(TimelineInspector),
  export: markRaw(TimelineInspector),
  sequence: markRaw(DefaultInspector),
  note: markRaw(DefaultInspector),
  frame: markRaw(DefaultInspector),
};

const ICONS: Record<string, string> = {
  story: '▤', beat: '❖', sequence: '▦', storyboard: '▥', entity: '✦',
  character_state: '✦', media: '▧', shot: '◎', takes: '▣', timeline: '▬', export: '⤓', note: '✎', frame: '⬚',
};

const node = computed<CanvasNode | null>(() => store.selectedNode);
const many = computed(() => store.selection.length > 1);
const body = computed(() => (node.value ? bodies[node.value.kind] ?? DefaultInspector : EmptyInspector));

const status = computed(() => {
  if (!node.value || node.value.kind !== 'shot') return '';
  return SHOT_USER_STATUS_LABEL[(node.value.data as ShotNodeData).userStatus];
});

const fullRoute = computed(() => {
  const current = node.value;
  if (!current) return null;
  switch (current.kind) {
    case 'story':
    case 'beat':
    case 'sequence':
      return '/story';
    case 'storyboard':
      return '/storyboard';
    case 'entity':
    case 'character_state':
    case 'media':
      return '/assets';
    case 'shot':
      return `/shots/${current.domainId}`;
    case 'takes': {
      const shotId = (current.data as { shotId: string }).shotId;
      return `/shots/${shotId}#takes`;
    }
    case 'timeline':
    case 'export':
      return '/timeline';
    default:
      return null;
  }
});

function openFull(): void {
  if (fullRoute.value) void router.push(fullRoute.value);
}
</script>

<template>
  <aside class="hf-inspector" aria-label="Inspector">
    <header class="hf-inspector-head">
      <span class="hf-icon" aria-hidden="true">{{ node ? ICONS[node.kind] ?? '◆' : '⌖' }}</span>
      <span class="hf-inspector-title">
        {{ many ? t('studio.inspector.multi', { n: store.selection.length }) : node?.title ?? t('studio.inspector.title') }}
      </span>
      <span v-if="status" class="hf-badge">{{ status }}</span>
      <button v-if="fullRoute" class="hf-inspector-action" :title="t('studio.inspector.openFull')" @click="openFull">↗</button>
      <button class="hf-inspector-action" :title="t('studio.inspector.collapse')" @click="emit('collapse')">»</button>
    </header>
    <div class="hf-inspector-body">
      <component :is="body" :node="node" />
    </div>
  </aside>
</template>
