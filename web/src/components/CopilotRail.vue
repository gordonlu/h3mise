<script setup lang="ts">
// Copilot rail — the script supervisor's live suggestions.
//
// Deterministic next actions come from /api/production (the rules stay in
// H3Mise); pending inference comes from the shared AI store. Each card is a
// one-click action, never a notification.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { get } from '../api/client';
import { t } from '../stores/locale';
import { useAiStore } from '../stores/ai';
import type { ProductionIssue, ProductionIssueCategory, ProductionIssueSeverity, ProductionOverview } from '@h3mise/shared';

const props = defineProps<{ shotCount?: number }>();
const router = useRouter();
const ai = useAiStore();
const overview = ref<ProductionOverview | null>(null);
let timer: number | undefined;

async function load(): Promise<void> {
  try {
    overview.value = await get<ProductionOverview>('/api/production');
  } catch {
    /* project may be switching; keep the previous copy */
  }
}

onMounted(() => {
  void load();
  timer = window.setInterval(() => void load(), 20_000);
});
onUnmounted(() => window.clearInterval(timer));
watch(() => props.shotCount, () => void load());

const topActions = computed(() => (overview.value?.nextActions ?? []).slice(0, 4));
const issueCounts = computed(() => ({
  blocker: overview.value?.issues.filter((item) => item.severity === 'blocker').length ?? 0,
  warning: overview.value?.issues.filter((item) => item.severity === 'warning').length ?? 0,
  info: overview.value?.issues.filter((item) => item.severity === 'info').length ?? 0,
}));
const totalIssues = computed(() => overview.value?.issues.length ?? 0);
const pending = computed(() => ai.pendingRequests.slice(0, 4));

function severityLabel(severity: ProductionIssueSeverity): string {
  return ({ blocker: t('workflow.production.blocker'), warning: t('workflow.production.warning'), info: t('workflow.production.next') })[severity];
}
function categoryLabel(category: ProductionIssueCategory): string {
  return ({ story: t('workflow.production.story'), assets: t('workflow.production.assets'), generation: t('workflow.production.generation'), review: t('workflow.production.review'), continuity: t('workflow.production.continuity'), timeline: t('workflow.production.timeline') })[category];
}
function openIssue(issue: ProductionIssue): void {
  void router.push(issue.to);
}
function openProduction(): void {
  void router.push('/production');
}

const sourceLabel = computed(() => {
  if (ai.agentAttached) return t('brain.externalAgent');
  if (ai.configured) return t('brain.projectAi');
  return t('brain.offline');
});
const sourceModel = computed(() => ai.agentAttached ? ai.agentLabel : ai.configured ? ai.status?.model ?? null : null);
</script>

<template>
  <aside class="copilot panel">
    <div class="cp-head">
      <div class="cp-title">
        <span class="cp-dot" :class="{ attached: ai.agentAttached, offline: !ai.agentAttached && !ai.configured }" />
        <strong>{{ t('copilot.title') }}</strong>
      </div>
      <span v-if="ai.pendingCount" class="badge accent no-dot">{{ ai.pendingCount }}</span>
    </div>
    <div class="cp-source">
      {{ sourceLabel }}<template v-if="sourceModel"> · {{ sourceModel }}</template>
    </div>

    <div class="cp-section">
      <div class="cp-label">{{ t('copilot.suggestions') }}</div>
      <template v-if="topActions.length">
        <article v-for="action in topActions" :key="action.id" class="cp-card" :class="action.severity">
          <span class="cp-kicker">{{ categoryLabel(action.category) }} · {{ severityLabel(action.severity) }}</span>
          <strong class="cp-card-title">{{ action.title }}</strong>
          <p class="cp-card-detail">{{ action.detail }}</p>
          <button class="sm cp-open" @click="openIssue(action)">{{ t('copilot.open') }}</button>
        </article>
      </template>
      <div v-else class="cp-empty muted">{{ t('copilot.allClear') }}</div>
    </div>

    <div v-if="totalIssues" class="cp-section">
      <div class="cp-label">{{ t('copilot.issues') }}</div>
      <button class="cp-counts" @click="openProduction">
        <span class="cp-count" :class="{ zero: !issueCounts.blocker }"><b>{{ issueCounts.blocker }}</b>{{ severityLabel('blocker') }}</span>
        <span class="cp-count" :class="{ zero: !issueCounts.warning }"><b>{{ issueCounts.warning }}</b>{{ severityLabel('warning') }}</span>
        <span class="cp-count" :class="{ zero: !issueCounts.info }"><b>{{ issueCounts.info }}</b>{{ severityLabel('info') }}</span>
      </button>
    </div>

    <div v-if="pending.length" class="cp-section">
      <div class="cp-label">{{ t('brain.pending') }}</div>
      <div v-for="request in pending" :key="request.id" class="cp-pending">
        <span class="mono cp-pending-id">{{ request.id }}</span>
        <span class="cp-pending-action">{{ request.action }}<template v-if="request.shotId"> · {{ request.shotId }}</template></span>
        <button class="ghost cp-cancel" :title="t('common.cancel')" @click="ai.cancelRequest(request.id)">✕</button>
      </div>
    </div>

    <div class="cp-foot muted">{{ t('copilot.footnote') }}</div>
  </aside>
</template>

<style scoped>
.copilot { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.cp-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.cp-title { display: flex; align-items: center; gap: 8px; }
.cp-title strong { font-size: 13.5px; }
.cp-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); }
.cp-dot.attached { background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.cp-dot.offline { background: var(--line-3); }
.cp-source { color: var(--text-3); font-size: 11.5px; margin-top: -6px; }
.cp-section { display: flex; flex-direction: column; gap: 8px; }
.cp-label { color: var(--text-3); font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; }
.cp-card {
  display: flex; flex-direction: column; gap: 5px;
  padding: 10px 11px; border-radius: 9px;
  border: 1px solid var(--line); background: var(--bg-subtle);
}
.cp-card.blocker { border-color: color-mix(in srgb, var(--bad) 40%, transparent); background: var(--bad-soft); }
.cp-card.warning { border-color: color-mix(in srgb, var(--warn) 38%, transparent); background: var(--warn-soft); }
.cp-card.info { border-color: var(--line); }
.cp-kicker { font-size: 10px; font-weight: 650; letter-spacing: 0.04em; color: var(--text-3); }
.cp-card.blocker .cp-kicker { color: var(--bad); }
.cp-card.warning .cp-kicker { color: var(--warn); }
.cp-card-title { font-size: 12.5px; line-height: 1.4; }
.cp-card-detail { margin: 0; color: var(--text-2); font-size: 11.5px; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.cp-open { align-self: flex-start; margin-top: 2px; }
.cp-empty { font-size: 12px; padding: 4px 2px; }
.cp-counts { display: flex; gap: 6px; background: none; border: none; padding: 0; box-shadow: none; cursor: pointer; }
.cp-counts:hover { background: none; }
.cp-count { display: flex; flex-direction: column; align-items: center; gap: 1px; flex: 1; padding: 7px 4px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg-subtle); color: var(--text-3); font-size: 10.5px; }
.cp-count b { font-size: 15px; font-variant-numeric: tabular-nums; color: var(--text); }
.cp-count.zero { opacity: 0.5; }
.cp-counts:hover .cp-count { border-color: var(--line-2); }
.cp-pending { display: flex; align-items: center; gap: 7px; padding: 6px 8px; border-radius: 7px; background: var(--bg-subtle); font-size: 11px; }
.cp-pending-id { color: var(--text-3); }
.cp-pending-action { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cp-cancel { padding: 1px 7px; font-size: 11px; color: var(--text-3); }
.cp-cancel:hover { color: var(--bad); }
.cp-foot { border-top: 1px dashed var(--line); padding-top: 9px; font-size: 10.5px; line-height: 1.5; }
</style>
