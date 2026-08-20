<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import type { GuideStepState, ProjectGuideSummary } from '@h3mise/shared';
import GuideStepper from './GuideStepper.vue';

const props = defineProps<{ summary: ProjectGuideSummary | null }>();
const route = useRoute();

const currentKey = computed(() => {
  if (route.path === '/story') return 'story';
  if (route.path === '/shots') return 'shots';
  if (route.path.startsWith('/shots/')) return 'production';
  if (route.path === '/timeline' && props.summary?.attention.kind === 'export') return 'export';
  if (route.path === '/timeline') return 'timeline';
  return props.summary?.shotCount ? 'production' : 'story';
});

const stages = computed(() => {
  const summary = props.summary;
  const productionDone = Boolean(summary?.shotCount && summary.selectedTakeCount === summary.shotCount);
  const definitions = [
    { key: 'story', label: '故事 / 设定', to: '/story', done: Boolean(summary?.shotCount) },
    { key: 'shots', label: 'Shot 列表', to: '/shots', done: Boolean(summary?.shotCount) },
    { key: 'production', label: '镜头制作', to: summary?.attention.to?.startsWith('/shots/') ? summary.attention.to : '/shots', done: productionDone },
    { key: 'timeline', label: '成片编排', to: '/timeline', done: Boolean(summary?.timelineClipCount) },
    { key: 'export', label: '导出', to: '/timeline', done: false },
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
      <span class="guide-title">项目进度</span>
      <GuideStepper :stages="stages" compact class="macro-steps" />
      <span v-if="summary" class="guide-summary">{{ summary.selectedTakeCount }} / {{ summary.shotCount }} 已选片</span>
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
