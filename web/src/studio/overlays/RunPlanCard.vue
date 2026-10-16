<script setup lang="ts">
import { computed } from 'vue';
import { useRunPlanStore, type RunStage } from '../../stores/runPlan';
import { useRunPlan } from '../../composables/useRunPlan';
import { t } from '../../stores/locale';

const plan = useRunPlanStore();
const { prepareAll, renderAll, rebuild } = useRunPlan();

const STAGE_KEY: Record<RunStage, string> = {
  done: 'studio.runplan.stageDone',
  needs_selection: 'studio.runplan.stageSelection',
  rendering: 'studio.runplan.stageRendering',
  needs_prompt: 'studio.runplan.stagePrompt',
  needs_preflight: 'studio.runplan.stagePreflight',
  waiting_dependency: 'studio.runplan.stageWaiting',
  ready: 'studio.runplan.stageReady',
  blocked: 'studio.runplan.stageBlocked',
};

const renderableCount = computed(() => plan.renderable.length);
</script>

<template>
  <div v-if="plan.plan" class="hf-runplan">
    <header class="hf-runplan-head">
      <span>{{ t('studio.runplan.title') }}</span>
      <button class="hf-runplan-close" @click="plan.setPlan(null)">✕</button>
    </header>
    <ol class="hf-runplan-list">
      <li v-for="item in plan.plan.items" :key="item.nodeId" class="hf-runplan-item">
        <span class="hf-runplan-order">{{ item.order }}</span>
        <span class="hf-runplan-title">{{ item.title }}</span>
        <span class="hf-chip" :class="item.stage">{{ t(STAGE_KEY[item.stage]) }}</span>
      </li>
    </ol>
    <div class="hf-runplan-actions">
      <button class="hf-ghost" @click="prepareAll">{{ t('studio.runplan.prepare') }}</button>
      <button class="hf-ghost" @click="rebuild">{{ t('studio.runplan.refresh') }}</button>
      <button class="primary" :disabled="renderableCount === 0" @click="renderAll">
        {{ t('studio.runplan.render', { n: renderableCount }) }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.hf-runplan {
  position: absolute; top: 60px; right: 16px; z-index: 8; width: 320px; max-height: 60%;
  display: flex; flex-direction: column; background: var(--bg-2); border: 1px solid var(--line);
  border-radius: var(--radius); box-shadow: var(--shadow-2); overflow: hidden;
}
.hf-runplan-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--line); font-weight: 600; font-size: 13px; }
.hf-runplan-close { border: none; background: none; color: var(--text-3); cursor: pointer; }
.hf-runplan-list { list-style: none; margin: 0; padding: 6px 8px; overflow: auto; flex: 1; min-height: 0; }
.hf-runplan-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12px; }
.hf-runplan-order { flex: none; width: 18px; height: 18px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-text); display: grid; place-items: center; font-size: 10px; font-weight: 700; }
.hf-runplan-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hf-chip.ready { background: var(--ok-soft); color: var(--ok); }
.hf-chip.blocked, .hf-chip.waiting_dependency { background: var(--bad-soft); color: var(--bad); }
.hf-chip.needs_selection { background: var(--warn-soft); color: var(--warn); }
.hf-runplan-actions { display: flex; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--line); }
</style>
