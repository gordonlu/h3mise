<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import type { GuideStepState, ProjectGuideSummary } from '@h3mise/shared';
import GuideStepper from './GuideStepper.vue';
import { t } from '../stores/locale';

const props = defineProps<{ summary: ProjectGuideSummary | null }>();
const route = useRoute();

const currentKey = computed(() => {
  if (route.path === '/story') return 'story';
  if (route.path === '/shots') return 'shots';
  if (route.path.startsWith('/shots/')) return 'production';
  if (route.path === '/timeline' && (props.summary?.attention.kind === 'export' || props.summary?.attention.kind === 'complete')) return 'export';
  if (route.path === '/timeline') return 'timeline';
  return props.summary?.shotCount ? 'production' : 'story';
});

const stages = computed(() => {
  const summary = props.summary;
  const productionDone = Boolean(summary?.shotCount && summary.selectedTakeCount === summary.shotCount);
  const definitions = [
    { key: 'story', label: t('guide.storySetup'), to: '/story', done: Boolean(summary?.shotCount) },
    { key: 'shots', label: t('guide.shotList'), to: '/shots', done: Boolean(summary?.shotCount) },
    { key: 'production', label: t('guide.production'), to: summary?.attention.to?.startsWith('/shots/') ? summary.attention.to : '/shots', done: productionDone },
    { key: 'timeline', label: t('guide.assembly'), to: '/timeline', done: Boolean(summary?.timelineClipCount) },
    { key: 'export', label: t('guide.export'), to: '/timeline', done: Boolean(summary?.exportCount) },
  ];
  return definitions.map((stage) => ({
    ...stage,
    state: (stage.done ? 'complete' : stage.key === currentKey.value ? 'current' : 'upcoming') as GuideStepState,
  }));
});
</script>

<template>
  <div class="project-guide">
    <div class="guide-inner">
      <span class="guide-title">{{ t('guide.progress') }}</span>
      <GuideStepper :stages="stages" compact class="macro-steps" />
      <span v-if="summary" class="guide-summary">{{ t('guide.selectedTakes', { selected: summary.selectedTakeCount, total: summary.shotCount }) }}</span>
    </div>
  </div>
</template>

<style scoped>
.project-guide { position: sticky; top: 54px; z-index: 18; border-bottom: 1px solid var(--line); background: color-mix(in srgb, var(--bg) 94%, transparent); backdrop-filter: blur(10px); }
.guide-inner { min-height: 58px; max-width: 1160px; margin: 0 auto; padding: 8px 24px; display: grid; grid-template-columns: auto minmax(460px, 1fr) auto; align-items: center; gap: 22px; }
.guide-title { color: var(--text-3); font-size: 11.5px; font-weight: 700; letter-spacing: 0.08em; white-space: nowrap; }
.macro-steps { --guide-count: 5; }
.guide-summary { color: var(--text-2); font-size: 12px; white-space: nowrap; }
</style>
