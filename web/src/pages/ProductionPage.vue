<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { AutoProducePlan, AutoProduceRun, ProductionIssueCategory, ProductionIssueSeverity, ProductionOverview, RenderBatchShotStage, VideoProviderId } from '@h3mise/shared';
import { get, post, subscribeEvents } from '../api/client';

const overview = ref<ProductionOverview | null>(null);
const loading = ref(true);
const error = ref('');
const issueFilter = ref<'all' | ProductionIssueSeverity>('all');
const autoPlan = ref<AutoProducePlan | null>(null);
const autoRun = ref<AutoProduceRun | null>(null);
const autoBusy = ref(false);
const autoError = ref('');
const providerId = ref<VideoProviderId>('mock');
const megapixels = ref(0.6);
const realConfirmed = ref(false);
let stopEvents: (() => void) | null = null;

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

async function load(silent = false) {
  if (!silent) loading.value = true;
  error.value = '';
  try {
    const [production, plan, active, runs] = await Promise.all([
      get<ProductionOverview>('/api/production'), get<AutoProducePlan>('/api/auto-produce/plan'),
      get<AutoProduceRun | null>('/api/auto-produce/active'), get<AutoProduceRun[]>('/api/auto-produce/runs'),
    ]);
    overview.value = production;
    autoPlan.value = plan;
    autoRun.value = active ?? runs[0] ?? null;
    if (!autoRun.value) providerId.value = plan.settings.providerId;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (!silent) loading.value = false;
  }
}

const chosenProvider = computed(() => autoPlan.value?.providers.find((provider) => provider.id === providerId.value));
const progress = computed(() => autoRun.value?.totalShots ? Math.round(autoRun.value.doneShots / autoRun.value.totalShots * 100) : 0);

async function startAuto() {
  if (!autoPlan.value) return;
  autoBusy.value = true; autoError.value = '';
  try {
    autoRun.value = await post<AutoProduceRun>('/api/auto-produce/start', {
      providerId: providerId.value, aspectRatio: autoPlan.value.settings.aspectRatio,
      megapixels: megapixels.value, skipCompleted: true,
      confirmRealProvider: providerId.value !== 'mock' && realConfirmed.value,
    });
  } catch (cause) { autoError.value = cause instanceof Error ? cause.message : String(cause); }
  finally { autoBusy.value = false; }
}

async function cancelAuto() {
  if (!autoRun.value) return;
  autoBusy.value = true;
  try { autoRun.value = await post<AutoProduceRun>(`/api/auto-produce/${autoRun.value.id}/cancel`, {}); }
  finally { autoBusy.value = false; }
}

onMounted(() => {
  void load();
  stopEvents = subscribeEvents((event) => {
    if (event.type === 'auto.updated' || event.type === 'render.job.updated' || event.type === 'render.job.succeeded' || event.type === 'render.job.failed') void load(true);
  });
});
onUnmounted(() => stopEvents?.());
</script>

<template>
  <div class="production-page">
    <header class="page-head">
      <div>
        <p class="eyebrow">PRODUCTION CONTROL</p>
        <h1>制片总控台</h1>
        <p class="muted">不是多一个编辑器，而是告诉你项目卡在哪里、现在最该做什么。</p>
      </div>
      <button class="sm" :disabled="loading" @click="load()">{{ loading ? '检查中…' : '重新检查' }}</button>
    </header>

    <div v-if="error" class="error-box">读取项目状态失败：{{ error }}</div>
    <div v-else-if="loading" class="loading-card">正在检查故事、镜头、资产、生成、选片和时间线…</div>

    <template v-else-if="overview">
      <section class="auto-card">
        <div class="auto-copy">
          <p class="eyebrow">BEGINNER MODE</p>
          <h2>一键制作</h2>
          <p>确认一次设置，系统会在当前项目里完成Beat、Shot、Prompt、生成、选片、时间线、成片检查和导出。完成后仍可回到专业工作台继续编辑。</p>
          <p v-if="autoPlan?.storyPreparation.note" class="prep-note">{{ autoPlan.storyPreparation.note }}</p>
        </div>
        <div v-if="autoRun && !['succeeded','failed','cancelled'].includes(autoRun.status)" class="run-box">
          <div class="run-head"><strong>{{ autoRun.currentStep }}</strong><span>{{ autoRun.doneShots }}/{{ autoRun.totalShots }}</span></div>
          <div class="progress"><i :style="{ width: `${progress}%` }" /></div>
          <small>刷新或切换项目不会丢失进度；已成功的生成不会重复提交。</small>
          <button class="sm" :disabled="autoBusy" @click="cancelAuto">停止后续步骤</button>
        </div>
        <div v-else class="auto-settings">
          <label>生成服务<select v-model="providerId">
            <option v-for="provider in autoPlan?.providers" :key="provider.id" :value="provider.id" :disabled="!provider.usable">{{ provider.name }}{{ provider.usable ? '' : '（不可用）' }}</option>
          </select></label>
          <label>清晰度<select v-model.number="megapixels"><option :value="0.6">0.6MP（推荐）</option><option :value="0.8">0.8MP</option><option :value="1">1.0MP</option><option :value="1.2">1.2MP</option></select></label>
          <div class="estimate">预计{{ autoPlan?.renderCount ?? 0 }}个新生成 · {{ seconds(autoPlan?.estimatedDurationSeconds ?? 0) }}成片</div>
          <label v-if="chosenProvider?.requiresConfirmation" class="paid-confirm"><input v-model="realConfirmed" type="checkbox"> 我确认本次会向{{ chosenProvider.name }}提交{{ autoPlan?.renderCount }}个真实任务，可能产生费用；失败不会自动重投</label>
          <button class="primary" :disabled="autoBusy || Boolean(autoPlan?.blockers.length) || !chosenProvider?.usable || (chosenProvider?.requiresConfirmation && !realConfirmed)" @click="startAuto">{{ autoBusy ? '正在开始…' : '确认并开始制作' }}</button>
          <div v-if="autoPlan?.blockers.length" class="auto-blocker">{{ autoPlan.blockers.join('；') }}</div>
          <div v-if="autoRun?.status === 'succeeded'" class="auto-success">上次制作完成：<a v-if="autoRun.exportUrl" :href="autoRun.exportUrl" target="_blank">预览成片</a></div>
          <div v-else-if="autoRun?.status === 'failed'" class="auto-blocker">上次停在：{{ autoRun.currentStep }}。{{ autoRun.error }}</div>
          <div v-if="autoError" class="auto-blocker">{{ autoError }}</div>
        </div>
      </section>

      <section class="metrics">
        <article><span>镜头进度</span><strong>{{ overview.summary.selectedCount }} / {{ overview.summary.shotCount }}</strong><small>已选片</small></article>
        <article><span>计划 / 镜头</span><strong>{{ seconds(overview.summary.plannedDurationSeconds) }} / {{ seconds(overview.summary.shotDurationSeconds) }}</strong><small>故事规划与 Shot 合计</small></article>
        <article><span>时间线</span><strong>{{ overview.summary.timelineClipCount }} 段 · {{ seconds(overview.summary.timelineDurationSeconds) }}</strong><small>{{ overview.summary.exportCount }} 个导出</small></article>
        <article><span>任务状态</span><strong>{{ overview.summary.activeRenderCount }} 进行中 · {{ overview.summary.failedJobCount }} 失败</strong><small>还剩 {{ overview.summary.remainingShotCount }} 个镜头未完成</small></article>
      </section>

      <section class="next-section">
        <div class="section-title">
          <div><p class="eyebrow">NEXT 3</p><h2>现在最该做</h2></div>
          <span class="provider">专业流程默认服务：{{ overview.providerId }}</span>
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
.auto-card { display: grid; grid-template-columns: minmax(300px, 1fr) minmax(360px, .9fr); gap: 28px; padding: 22px; border: 1px solid var(--accent-line); border-radius: var(--radius); background: linear-gradient(135deg, var(--accent-soft), var(--bg-2) 60%); box-shadow: var(--shadow-1); }
.auto-copy h2 { margin: 2px 0 8px; font-size: 24px; }.auto-copy > p:not(.eyebrow) { max-width: 660px; margin: 0; color: var(--text-2); line-height: 1.7; }.prep-note { margin-top: 10px !important; color: var(--accent-text) !important; font-size: 12px; }
.auto-settings, .run-box { display: grid; gap: 10px; align-content: start; padding: 15px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg-2); }.auto-settings label { display: grid; grid-template-columns: 84px 1fr; align-items: center; gap: 8px; font-size: 12px; }.auto-settings select { min-width: 0; }.estimate { color: var(--text-3); font-size: 11px; }.auto-settings .paid-confirm { grid-template-columns: auto 1fr; padding: 9px; background: var(--warn-soft); color: var(--warn); line-height: 1.5; }.paid-confirm input { margin: 0; }.auto-blocker { color: var(--bad); font-size: 11px; line-height: 1.5; }.auto-success { color: var(--ok); font-size: 12px; }.run-head { display: flex; justify-content: space-between; gap: 12px; }.run-head span { font: 700 11px var(--mono); color: var(--accent-text); }.progress { height: 7px; overflow: hidden; border-radius: 99px; background: var(--bg-subtle); }.progress i { display: block; height: 100%; background: var(--accent); transition: width .25s; }.run-box small { color: var(--text-3); }
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
@media (max-width: 1120px) { .auto-card { grid-template-columns: 1fr; }.metrics { grid-template-columns: repeat(2, 1fr); }.next-grid { grid-template-columns: 1fr; }.shot-row { grid-template-columns: 38px 1fr 90px 55px; }.shot-row > :nth-last-child(-n+2) { display: none; } }
</style>
