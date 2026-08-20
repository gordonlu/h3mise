<script setup lang="ts">
import type { GuideStepState } from '@h3mise/shared';

defineProps<{
  stages: Array<{ key: string; label: string; state: GuideStepState; to?: string }>;
  compact?: boolean;
}>();
</script>

<template>
  <ol class="guide-steps" :class="{ compact }" aria-label="制作进度">
    <li v-for="(stage, index) in stages" :key="stage.key" :class="['guide-step', stage.state]">
      <div class="step-track" :class="{ first: index === 0, last: index === stages.length - 1 }">
        <span class="step-dot" aria-hidden="true" />
      </div>
      <router-link v-if="stage.to" :to="stage.to" class="step-label">{{ stage.label }}</router-link>
      <span v-else class="step-label">{{ stage.label }}</span>
      <span class="sr-only">{{ stage.state === 'complete' ? '已完成' : stage.state === 'current' ? '当前步骤' : stage.state === 'attention' ? '需要处理' : '尚未开始' }}</span>
    </li>
  </ol>
</template>

<style scoped>
.guide-steps { display: grid; grid-template-columns: repeat(var(--guide-count, 4), minmax(82px, 1fr)); margin: 0; padding: 0; list-style: none; }
.guide-step { position: relative; text-align: center; min-width: 0; }
.step-track { height: 16px; position: relative; display: flex; align-items: center; justify-content: center; }
.step-track::before, .step-track::after { content: ''; position: absolute; top: 7px; width: 50%; height: 2px; background: var(--line-2); }
.step-track::before { left: 0; }
.step-track::after { right: 0; }
.step-track.first::before, .step-track.last::after { display: none; }
.step-dot { position: relative; z-index: 1; width: 10px; height: 10px; border: 2px solid var(--line-2); border-radius: 50%; background: var(--bg-2); }
.step-label { display: inline-block; margin-top: 4px; color: var(--text-3); font-size: 12px; text-decoration: none; white-space: nowrap; }
.complete .step-dot { border-color: var(--ok); background: var(--ok); }
.complete .step-track::before, .complete .step-track::after { background: color-mix(in srgb, var(--ok) 55%, var(--line)); }
.complete .step-label { color: var(--text-2); }
.current .step-dot { width: 12px; height: 12px; border: 3px solid var(--accent); background: var(--bg-2); box-shadow: var(--focus-ring); }
.current .step-label { color: var(--accent-text); font-weight: 700; }
.attention .step-dot { border-color: var(--warn); background: var(--warn); }
.attention .step-label { color: var(--warn); font-weight: 600; }
.compact .step-label { font-size: 11.5px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
