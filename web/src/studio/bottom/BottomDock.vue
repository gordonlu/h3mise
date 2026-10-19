<script setup lang="ts">
import { computed, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useRenderStore } from '../../stores/render';
import { useStudioStore } from '../../stores/studio';
import { useStudioUiStore, type BottomDockTab } from '../../stores/studioUi';
import { t } from '../../stores/locale';
import MiniTimeline from './MiniTimeline.vue';
import QueuePanel from './QueuePanel.vue';
import ProblemsPanel from './ProblemsPanel.vue';
import AiRequestsPanel from './AiRequestsPanel.vue';
import ActivityLog from './ActivityLog.vue';

const render = useRenderStore();
const store = useStudioStore();
const ui = useStudioUiStore();
const { bottomOpen: open, bottomTab: tab } = storeToRefs(ui);
const problems = ref<InstanceType<typeof ProblemsPanel> | null>(null);
const aiPanel = ref<InstanceType<typeof AiRequestsPanel> | null>(null);

const ACTIVE = new Set(['LOCAL_QUEUED', 'UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING']);
const activeJobs = computed(() => render.jobs.filter((job) => ACTIVE.has(job.status)).length);
const problemCount = computed(() => store.graph?.nodes.filter((node) => node.kind === 'shot' && node.badges.some((badge) => badge.kind === 'blocker')).length ?? 0);
const aiCount = computed(() => store.graph?.nodes.filter((node) => node.kind === 'shot' && node.data.pendingAiRequestIds.length > 0).length ?? 0);

function selectTab(next: BottomDockTab): void {
  if (open.value && tab.value === next) {
    open.value = false;
    return;
  }
  tab.value = next;
  open.value = true;
  if (next === 'problems') void problems.value?.load();
  if (next === 'ai') void aiPanel.value?.load();
  if (next === 'queue' && !render.loaded) void render.refresh();
}
</script>

<template>
  <div class="hf-bottom" :class="{ open }">
    <div class="hf-bottom-bar">
      <button class="hf-tab" :class="{ active: open && tab === 'timeline' }" @click="selectTab('timeline')">
        {{ t('studio.bottom.timeline') }}
      </button>
      <button class="hf-tab" :class="{ active: open && tab === 'queue' }" @click="selectTab('queue')">
        {{ t('studio.bottom.queue') }}<b v-if="activeJobs">{{ activeJobs }}</b>
      </button>
      <button class="hf-tab" :class="{ active: open && tab === 'problems' }" @click="selectTab('problems')">
        {{ t('studio.bottom.problems') }}<b v-if="problemCount">{{ problemCount }}</b>
      </button>
      <button class="hf-tab" :class="{ active: open && tab === 'ai' }" @click="selectTab('ai')">
        {{ t('studio.bottom.ai') }}<b v-if="aiCount">{{ aiCount }}</b>
      </button>
      <button class="hf-tab" :class="{ active: open && tab === 'log' }" @click="selectTab('log')">
        {{ t('studio.bottom.log') }}
      </button>
      <span class="hf-bottom-spacer" />
      <button class="hf-tab toggle" :title="open ? t('studio.bottom.collapse') : t('studio.bottom.expand')" @click="open = !open">
        {{ open ? '⌄' : '⌃' }}
      </button>
    </div>
    <div v-if="open" class="hf-bottom-body">
      <MiniTimeline v-if="tab === 'timeline'" />
      <QueuePanel v-else-if="tab === 'queue'" />
      <ProblemsPanel v-else-if="tab === 'problems'" ref="problems" />
      <AiRequestsPanel v-else-if="tab === 'ai'" ref="aiPanel" />
      <ActivityLog v-else />
    </div>
  </div>
</template>
