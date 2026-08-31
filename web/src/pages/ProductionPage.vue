<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { ProductionIssueCategory, ProductionIssueSeverity, ProductionOverview, RenderBatchShotStage } from '@h3mise/shared';
import { get } from '../api/client';

const overview = ref<ProductionOverview | null>(null);
const loading = ref(true);
const error = ref('');
const issueFilter = ref<'all' | ProductionIssueSeverity>('all');

const stageLabel: Record<RenderBatchShotStage, string> = {
  ready: '可以生成', active: '生成中', done: '已选片', needs_selection: '待选片',
  waiting_dependency: '等上游', needs_assets: '缺素材', needs_prompt: '缺 Prompt',
  needs_preflight: '待检查', blocked: '被阻塞',
};
const categoryLabel: Record<ProductionIssueCategory, string> = {
  story: '故事', assets: '资产', generation: '生成', review: '选片', continuity: '连续性', timeline: '时间线',
};
const severityLabel: Record<ProductionIssueSeverity, string> = { blocker: '阻塞', warning: '注意', info: '下一步' };

const visibleIssues = computed(() => overview.value?.issues.filter((item) => issueFilter.value === 'all' || item.severity === issueFilter.value) ?? []);
const issueCounts = computed(() => ({
  blocker: overview.value?.issues.filter((item) => item.severity === 'blocker').length ?? 0,
  warning: overview.value?.issues.filter((item) => item.severity === 'warning').length ?? 0,
  info: overview.value?.issues.filter((item) => item.severity === 'info').length ?? 0,
}));

function seconds(value: number): string {
  if (!value) return '—';
  return value >= 60 ? `${Math.floor(value / 60)}m ${Math.round(value % 60)}s` : `${value.toFixed(value % 1 ? 1 : 0)}s`;
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    overview.value = await get<ProductionOverview>('/api/production');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="production-page">
    <header class="page-head">
      <div>
        <p class="eyebrow">PRODUCTION CONTROL</p>
        <h1>制片总控台</h1>
        <p class="muted">不是多一个编辑器，而是告诉你项目卡在哪里、现在最该做什么。</p>
      </div>
      <button class="sm" :disabled="loading" @click="load">{{ loading ? '检查中…' : '重新检查' }}</button>
    </header>

    <div v-if="error" class="error-box">读取项目状态失败：{{ error }}</div>
    <div v-else-if="loading" class="loading-card">正在检查故事、镜头、资产、生成、选片和时间线…</div>

    <template v-else-if="overview">
      <section class="metrics">
        <article><span>镜头进度</span><strong>{{ overview.summary.selectedCount }} / {{ overview.summary.shotCount }}</strong><small>已选片</small></article>
        <article><span>计划 / 镜头</span><strong>{{ seconds(overview.summary.plannedDurationSeconds) }} / {{ seconds(overview.summary.shotDurationSeconds) }}</strong><small>故事规划与 Shot 合计</small></article>
        <article><span>时间线</span><strong>{{ overview.summary.timelineClipCount }} 段 · {{ seconds(overview.summary.timelineDurationSeconds) }}</strong><small>{{ overview.summary.exportCount }} 个导出</small></article>
        <article><span>任务状态</span><strong>{{ overview.summary.activeRenderCount }} 进行中 · {{ overview.summary.failedJobCount }} 失败</strong><small>还剩 {{ overview.summary.remainingShotCount }} 个镜头未完成</small></article>
      </section>

      <section class="next-section">
        <div class="section-title">
          <div><p class="eyebrow">NEXT 3</p><h2>现在最该做</h2></div>
          <span class="provider">当前生成服务：{{ overview.providerId }}</span>
        </div>
        <div v-if="overview.nextActions.length" class="next-grid">
          <router-link v-for="(action, index) in overview.nextActions" :key="action.id" :to="action.to" class="next-card" :class="action.severity">
            <span class="number">0{{ index + 1 }}</span>
            <div><small>{{ categoryLabel[action.category] }} · {{ severityLabel[action.severity] }}</small><h3>{{ action.title }}</h3><p>{{ action.detail }}</p></div>
            <b>去处理 →</b>
          </router-link>
        </div>
        <div v-else class="all-clear">当前没有发现阻塞项。项目状态完整，可以继续调整或交付。</div>
      </section>

      <section class="panel">
        <div class="section-title issue-heading">
          <div><p class="eyebrow">CHECKLIST</p><h2>项目问题</h2></div>
          <div class="filters">
            <button :class="{ active: issueFilter === 'all' }" @click="issueFilter = 'all'">全部 {{ overview.issues.length }}</button>
            <button :class="{ active: issueFilter === 'blocker' }" @click="issueFilter = 'blocker'">阻塞 {{ issueCounts.blocker }}</button>
            <button :class="{ active: issueFilter === 'warning' }" @click="issueFilter = 'warning'">注意 {{ issueCounts.warning }}</button>
            <button :class="{ active: issueFilter === 'info' }" @click="issueFilter = 'info'">下一步 {{ issueCounts.info }}</button>
          </div>
        </div>
        <div v-if="visibleIssues.length" class="issue-list">
          <router-link v-for="item in visibleIssues" :key="item.id" :to="item.to" class="issue-row">
            <i :class="item.severity" />
            <span class="issue-kind">{{ categoryLabel[item.category] }}</span>
            <div><strong>{{ item.title }}</strong><small>{{ item.detail }}</small></div>
            <span class="open">处理 →</span>
          </router-link>
        </div>
        <div v-else class="empty-filter">这个级别没有问题。</div>
      </section>

      <section class="panel">
        <div class="section-title"><div><p class="eyebrow">SHOT PIPELINE</p><h2>镜头生产状态</h2></div><span class="muted">优先显示阻塞和待处理镜头</span></div>
        <div v-if="overview.shots.length" class="shot-table">
          <router-link v-for="shot in overview.shots" :key="shot.shotId" :to="shot.to" class="shot-row">
            <span class="shot-order">{{ String(shot.order).padStart(2, '0') }}</span>
            <div class="shot-name"><strong>{{ shot.title }}</strong><small>{{ shot.reason }}</small></div>
            <span class="stage" :class="shot.stage">{{ stageLabel[shot.stage] }}</span>
            <span>{{ seconds(shot.durationSeconds) }}</span>
            <span>{{ shot.takeCount }} Takes</span>
            <span :class="shot.onTimeline ? 'ok-text' : 'muted'">{{ shot.onTimeline ? '已入时间线' : '未入时间线' }}</span>
          </router-link>
        </div>
        <div v-else class="empty-filter">还没有 Shot。先从故事页或镜头页建立镜头。</div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.production-page { max-width: 1320px; margin: 0 auto; padding: 26px 28px 64px; display: grid; gap: 24px; }
.page-head, .section-title { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; }
h1 { margin: 1px 0 4px; font: 600 30px/1.25 var(--serif); } h2 { margin: 0; font: 600 20px/1.3 var(--serif); }
.eyebrow { margin: 0; color: var(--accent-text); font: 700 10px/1.5 var(--mono); letter-spacing: .16em; }
.metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.metrics article { padding: 16px 18px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-2); box-shadow: var(--shadow-1); display: grid; gap: 5px; }
.metrics span, .metrics small { color: var(--text-3); font-size: 11px; }.metrics strong { font-size: 18px; }
.next-section { display: grid; gap: 12px; }.provider { color: var(--text-3); font-size: 12px; }
.next-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.next-card { min-height: 154px; padding: 17px; border: 1px solid var(--line); border-top: 3px solid var(--info); border-radius: var(--radius); background: var(--bg-2); color: var(--text); text-decoration: none; display: grid; grid-template-columns: auto 1fr; gap: 10px 13px; box-shadow: var(--shadow-1); }
.next-card:hover { text-decoration: none; border-color: var(--accent-line); transform: translateY(-1px); }.next-card.blocker { border-top-color: var(--bad); }.next-card.warning { border-top-color: var(--warn); }
.number { color: var(--text-3); font: 700 12px var(--mono); }.next-card small { color: var(--text-3); }.next-card h3 { margin: 3px 0; font-size: 15px; }.next-card p { margin: 0; color: var(--text-2); font-size: 12px; }.next-card b { grid-column: 2; color: var(--accent-text); font-size: 12px; }
.panel, .loading-card, .error-box, .all-clear { border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-2); padding: 18px; box-shadow: var(--shadow-1); }
.error-box { color: var(--bad); background: var(--bad-soft); }.all-clear { color: var(--ok); background: var(--ok-soft); }
.issue-heading { align-items: center; }.filters { display: flex; gap: 5px; }.filters button { padding: 5px 9px; font-size: 11px; }.filters button.active { color: var(--accent-text); border-color: var(--accent-line); background: var(--accent-soft); }
.issue-list { margin-top: 13px; border-top: 1px solid var(--line); }.issue-row { display: grid; grid-template-columns: 8px 58px 1fr auto; gap: 12px; align-items: center; padding: 11px 4px; color: var(--text); border-bottom: 1px solid var(--line); text-decoration: none; }
.issue-row:hover { text-decoration: none; background: var(--bg-subtle); }.issue-row i { width: 7px; height: 7px; border-radius: 50%; background: var(--info); }.issue-row i.blocker { background: var(--bad); }.issue-row i.warning { background: var(--warn); }
.issue-kind { color: var(--text-3); font-size: 11px; }.issue-row div { display: grid; }.issue-row small { color: var(--text-3); }.open { color: var(--accent-text); font-size: 11px; }
.shot-table { margin-top: 13px; border-top: 1px solid var(--line); }.shot-row { display: grid; grid-template-columns: 38px minmax(260px, 1fr) 90px 55px 75px 90px; gap: 12px; align-items: center; padding: 10px 5px; border-bottom: 1px solid var(--line); color: var(--text-2); text-decoration: none; font-size: 12px; }
.shot-row:hover { text-decoration: none; background: var(--bg-subtle); }.shot-order { font: 700 11px var(--mono); color: var(--text-3); }.shot-name { display: grid; min-width: 0; }.shot-name strong { color: var(--text); }.shot-name small { color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stage { justify-self: start; padding: 2px 7px; border-radius: 999px; background: var(--info-soft); color: var(--info); font-size: 10px; }.stage.blocked { background: var(--bad-soft); color: var(--bad); }.stage.needs_selection, .stage.needs_assets, .stage.waiting_dependency { background: var(--warn-soft); color: var(--warn); }.stage.done { background: var(--ok-soft); color: var(--ok); }
.ok-text { color: var(--ok); }.empty-filter { padding: 28px 4px 8px; color: var(--text-3); text-align: center; }
@media (max-width: 1120px) { .metrics { grid-template-columns: repeat(2, 1fr); }.next-grid { grid-template-columns: 1fr; }.shot-row { grid-template-columns: 38px 1fr 90px 55px; }.shot-row > :nth-last-child(-n+2) { display: none; } }
</style>
