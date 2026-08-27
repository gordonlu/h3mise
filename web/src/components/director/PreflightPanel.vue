<script setup lang="ts">
import { computed, ref } from 'vue';
import type { PreflightReport, PromptVersion, ProviderStatus } from '@h3mise/shared';
import { H3_MODE_LABEL } from '@h3mise/shared';

const props = defineProps<{
  reports: PreflightReport[];
  prompt: PromptVersion | null;
  provider: ProviderStatus | null;
  durationSeconds: number;
  aspectRatio: string;
  megapixels?: number;
  aiEnabled: boolean;
  onBasic: (promptId: string, megapixels: number) => Promise<PreflightReport>;
  onAiCheck: (promptId: string) => Promise<PreflightReport | null>;
  onRefreshPrompt: () => Promise<void>;
  onRender: (promptId: string) => Promise<void>;
}>();

const busy = ref('');
const effectiveMegapixels = computed(() => props.megapixels ?? 1);
const megapixelsLabel = computed(() => effectiveMegapixels.value === 1 ? '1.0 MP' : `${effectiveMegapixels.value} MP`);
const latestMatchingReport = computed(() => props.prompt
  ? props.reports.find((report) => report.promptVersionId === props.prompt?.id) ?? null
  : null);
const visibleReports = computed(() => latestMatchingReport.value ? [latestMatchingReport.value] : []);
const matchingReportCount = computed(() => props.prompt
  ? props.reports.filter((report) => report.promptVersionId === props.prompt?.id).length
  : 0);
const canRender = computed(() => Boolean(latestMatchingReport.value && !latestMatchingReport.value.blocked));
const providerSupportsPrompt = computed(() => props.prompt && Boolean(
  props.provider?.capabilities?.supportedModes.includes(props.prompt.h3Mode),
));
const renderReady = computed(() => canRender.value && providerSupportsPrompt.value);
const needsPromptRefresh = computed(() => Boolean(latestMatchingReport.value?.basic.some((section) =>
  section.checks.some((check) => check.key === 'integrity.prompt_references'),
)));
const providerDisplayName = computed(() => props.provider?.name.replace(/\s+\d{8,}$/, '') ?? 'RunningHub');

async function run(kind: 'basic' | 'ai') {
  if (!props.prompt) return;
  busy.value = kind;
  try {
    if (kind === 'basic') await props.onBasic(props.prompt.id, effectiveMegapixels.value);
    else await props.onAiCheck(props.prompt.id);
  } finally {
    busy.value = '';
  }
}

async function render() {
  if (!props.prompt) return;
  busy.value = 'render';
  try {
    await props.onRender(props.prompt.id);
  } finally {
    busy.value = '';
  }
}

async function refreshPrompt() {
  busy.value = 'refresh-prompt';
  try {
    await props.onRefreshPrompt();
  } finally {
    busy.value = '';
  }
}

const STATUS_COLOR: Record<string, string> = { ok: 'ok', warn: 'warn', fail: 'bad', skip: 'muted' };
const RISK_COLOR: Record<string, string> = { LOW: 'ok', MEDIUM: 'warn', HIGH: 'bad' };
const RISK_LABEL: Record<string, string> = { LOW: '低', MEDIUM: '中', HIGH: '高' };
</script>

<template>
  <div class="col">
    <div class="row preflight-actions">
      <button class="primary sm check-action" :disabled="busy !== '' || !prompt" @click="run('basic')">运行生成检查</button>
      <button v-if="aiEnabled" class="sm ai-check-action" :disabled="busy !== '' || !prompt" @click="run('ai')">AI 连续性检查</button>
      <span v-if="busy === 'basic'" class="muted">检查中…</span>
      <span v-if="busy === 'ai'" class="muted">AI 连续性检查中…（后台任务）</span>
    </div>

    <div v-if="!prompt" class="muted">请先编译或粘贴提示词。</div>
    <div v-else-if="!latestMatchingReport" class="panel pending-check">
      <strong>当前提示词还没有生成检查记录</strong>
      <p>旧提示词的检查结果不会沿用。点击“运行生成检查”确认当前提示词、参考素材和生成参数。</p>
    </div>

    <div v-for="r in visibleReports" :key="r.id" class="panel preflight">
      <div class="spread report-head">
        <span class="muted mono report-meta">{{ r.id }} · {{ new Date(r.createdAt).toLocaleString() }}</span>
        <div class="row report-status">
          <span v-if="r.aiSemanticRun" class="badge info">已运行 AI 连续性检查</span>
          <span v-else class="muted">未运行 AI 连续性检查</span>
          <span :class="['badge', RISK_COLOR[r.risk]]">风险：{{ RISK_LABEL[r.risk] }}</span>
          <span :class="['badge', r.blocked ? 'bad' : 'ok']">{{ r.blocked ? '未通过' : '可生成' }}</span>
        </div>
      </div>
      <div class="sections">
        <div v-for="s in r.basic" :key="s.key" class="sec">
          <span :class="['badge', STATUS_COLOR[s.status]]">{{ s.label }}</span>
          <ul>
            <li v-for="ch in s.checks" :key="ch.key" :class="ch.severity">
              {{ ch.message }}
            </li>
          </ul>
        </div>
      </div>
      <div v-if="r.semantic" class="sections">
        <div v-for="s in r.semantic" :key="s.key" class="sec">
          <span :class="['badge', STATUS_COLOR[s.status]]">{{ s.label }}</span>
          <ul>
            <li v-for="ch in s.checks" :key="ch.key" :class="ch.severity">{{ ch.message }}</li>
          </ul>
        </div>
      </div>
    </div>
    <div v-if="matchingReportCount > 1" class="muted">已保留 {{ matchingReportCount - 1 }} 条历史检查记录；当前只显示最新结果。</div>

    <div v-if="needsPromptRefresh" class="panel repair-prompt">
      <div>
        <strong>参考素材已更新</strong>
        <p>当前提示词尚未包含新的参考图。重新生成后会自动复查，不会提交生成任务。</p>
      </div>
      <button class="primary sm" :disabled="busy !== ''" @click="refreshPrompt">
        {{ busy === 'refresh-prompt' ? '处理中…' : '重新生成提示词并复查' }}
      </button>
    </div>

    <!-- PRD §41 cost protection: show exactly what one Generate will spend. -->
    <div class="panel cost-preview">
      <div class="panel-title">渲染成本预览（本次提交 = 1 次付费生成）</div>
      <div class="panel-body row wrap cost-row">
        <span class="badge accent no-dot provider-badge" :title="provider?.name">{{ providerDisplayName }}</span>
        <span class="badge no-dot">{{ prompt ? H3_MODE_LABEL[prompt.h3Mode] : '—' }}</span>
        <span class="badge no-dot">{{ durationSeconds }}s</span>
        <span class="badge no-dot">{{ aspectRatio }}</span>
        <span v-if="provider?.id === 'runninghub'" class="badge no-dot">{{ megapixelsLabel }}</span>
        <span class="muted take-count">1 个 Take</span>
      </div>
    </div>

    <button class="primary render-btn" :disabled="busy !== '' || !prompt || !renderReady" @click="render">
      {{ busy === 'render' ? '提交中…' : renderReady ? '生成视频 · 创建 1 个新 Take' : !latestMatchingReport ? '请先运行当前提示词的生成检查' : canRender && !providerSupportsPrompt ? '当前 Provider 不支持此模式' : '生成检查通过后可生成' }}
    </button>
    <p class="muted">点击后会显示最终参数确认；提交前还会强制重跑生成检查，未通过时不会产生生成任务。</p>
  </div>
</template>

<style scoped>
.col { min-width: 0; }
.preflight-actions { flex-wrap: wrap; }
.check-action, .ai-check-action { font-weight: 650; }
.ai-check-action { color: var(--info); background: var(--info-soft); border-color: color-mix(in srgb, var(--info) 48%, transparent); box-shadow: none; }
.ai-check-action:hover { color: var(--info); background: color-mix(in srgb, var(--info-soft) 72%, var(--bg-2)); border-color: var(--info); }
.preflight { min-width: 0; overflow: hidden; padding: 10px 12px; }
.report-head { align-items: flex-start; flex-wrap: wrap; }
.report-meta { min-width: 0; overflow-wrap: anywhere; }
.report-status { flex-wrap: wrap; }
.sections { min-width: 0; display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.sec { min-width: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 10px; align-items: flex-start; }
.sec ul { min-width: 0; margin: 0; padding-left: 0; list-style: none; }
.sec li { min-width: 0; font-size: 12px; color: var(--text-2); overflow-wrap: anywhere; word-break: break-word; }
.sec li.error { color: var(--bad); }
.sec li.warning { color: var(--warn); }
.render-btn { width: 100%; margin-top: 4px; white-space: normal; }
.cost-preview { min-width: 0; overflow: hidden; border-style: dashed; }
.cost-row { min-width: 0; gap: 6px; }
.provider-badge { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.take-count { white-space: nowrap; }
.pending-check { padding: 12px; }
.pending-check p { margin: 4px 0 0; color: var(--text-2); font-size: 12px; }
.repair-prompt { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 8px; padding: 12px; border-color: color-mix(in srgb, var(--warn) 45%, var(--border)); background: color-mix(in srgb, var(--warn) 8%, var(--bg-2)); }
.repair-prompt div { min-width: 0; }
.repair-prompt p { margin: 4px 0 0; color: var(--text-2); font-size: 12px; }
.repair-prompt button { flex: none; }
</style>
