<script setup lang="ts">
import { computed, ref } from 'vue';
import type { PreflightReport, PromptVersion, ProviderStatus } from '@h3mise/shared';
import { H3_MODE_LABEL } from '@h3mise/shared';
import { t } from '../../stores/locale';

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
function riskLabel(risk: string): string {
  return t(`shot.preflight.risk.${risk.toLowerCase()}`);
}

function modeLabel(mode: string): string {
  return t(`shot.mode.${mode}`);
}
</script>

<template>
  <div class="col">
    <div class="row preflight-actions">
      <button class="primary sm check-action" :disabled="busy !== '' || !prompt" @click="run('basic')">{{ t('shot.preflight.runCheck') }}</button>
      <button v-if="aiEnabled" class="sm ai-check-action" :disabled="busy !== '' || !prompt" @click="run('ai')">{{ t('shot.preflight.aiContinuityCheck') }}</button>
      <span v-if="busy === 'basic'" class="muted">{{ t('shot.preflight.checking') }}</span>
      <span v-if="busy === 'ai'" class="muted">{{ t('shot.preflight.aiChecking') }}</span>
    </div>

    <div v-if="!prompt" class="muted">{{ t('shot.preflight.promptRequired') }}</div>
    <div v-else-if="!latestMatchingReport" class="panel pending-check">
      <strong>{{ t('shot.preflight.noCurrentReport') }}</strong>
      <p>{{ t('shot.preflight.oldReportsNotReused') }}</p>
    </div>

    <div v-for="r in visibleReports" :key="r.id" class="panel preflight">
      <div class="spread report-head">
        <span class="muted mono report-meta">{{ r.id }} · {{ new Date(r.createdAt).toLocaleString() }}</span>
        <div class="row report-status">
          <span v-if="r.aiSemanticRun" class="badge info">{{ t('shot.preflight.aiCheckRun') }}</span>
          <span v-else class="muted">{{ t('shot.preflight.aiCheckNotRun') }}</span>
          <span :class="['badge', RISK_COLOR[r.risk]]">{{ t('shot.preflight.riskLabel') }}{{ riskLabel(r.risk) }}</span>
          <span :class="['badge', r.blocked ? 'bad' : 'ok']">{{ r.blocked ? t('shot.preflight.notPassed') : t('shot.preflight.canGenerate') }}</span>
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
    <div v-if="matchingReportCount > 1" class="muted">{{ t('shot.preflight.historyCount', { n: matchingReportCount - 1 }) }}</div>

    <div v-if="needsPromptRefresh" class="panel repair-prompt">
      <div>
        <strong>{{ t('shot.preflight.referencesUpdated') }}</strong>
        <p>{{ t('shot.preflight.promptNeedsReferences') }}</p>
      </div>
      <button class="primary sm" :disabled="busy !== ''" @click="refreshPrompt">
        {{ busy === 'refresh-prompt' ? t('shot.common.processing') : t('shot.preflight.regenerateAndRecheck') }}
      </button>
    </div>

    <!-- PRD §41 cost protection: show exactly what one Generate will spend. -->
    <div class="panel cost-preview">
      <div class="panel-title">{{ t('shot.preflight.costPreview') }}</div>
      <div class="panel-body row wrap cost-row">
        <span class="badge accent no-dot provider-badge" :title="provider?.name">{{ providerDisplayName }}</span>
        <span class="badge no-dot">{{ prompt ? modeLabel(prompt.h3Mode) : '—' }}</span>
        <span class="badge no-dot">{{ durationSeconds }}s</span>
        <span class="badge no-dot">{{ aspectRatio }}</span>
        <span v-if="provider?.id !== 'mock'" class="badge no-dot">{{ megapixelsLabel }}</span>
        <span class="muted take-count">{{ t('shot.workspace.oneNewTake') }}</span>
      </div>
    </div>

    <button class="primary render-btn" :disabled="busy !== '' || !prompt || !renderReady" @click="render">
      {{ busy === 'render' ? t('shot.preflight.submitting') : renderReady ? t('shot.workspace.generateOneTake') : !latestMatchingReport ? t('shot.preflight.runCurrentCheckFirst') : canRender && !providerSupportsPrompt ? t('shot.workspace.providerModeUnsupported') : t('shot.preflight.generateAfterPass') }}
    </button>
    <p class="muted">{{ t('shot.preflight.finalConfirmationNote') }}</p>
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
