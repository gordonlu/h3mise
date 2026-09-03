<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { Storyboard, StoryboardPanelCount, StoryboardProviderProfile } from '@h3mise/shared';
import { recommendedStoryboardPanelCount } from '@h3mise/shared';
import { get, mediaUrl, patch, post } from '../api/client';
import { confirmDialog } from '../stores/confirm';
import { useToastStore } from '../stores/toast';
import { t } from '../stores/locale';

const storyboard = ref<Storyboard | null>(null);
const pages = ref<Storyboard[]>([]);
const selectedPageId = ref('');
const provider = ref<StoryboardProviderProfile | null>(null);
const story = ref<{ plannedDurationSeconds: number; synopsis: string; body: string } | null>(null);
const beats = ref<Array<{ durationSeconds: number }>>([]);
const selectedCount = ref<StoryboardPanelCount>(6);
const busy = ref(false);
const panelDrafts = ref<Record<string, string>>({});
const toasts = useToastStore();
let pollTimer: ReturnType<typeof setTimeout> | null = null;

const duration = computed(() => {
  const planned = Number(story.value?.plannedDurationSeconds ?? 0);
  return planned > 0 ? planned : beats.value.reduce((sum, beat) => sum + Number(beat.durationSeconds || 0), 0) || 5;
});
const segmentCount = computed(() => {
  if (beats.value.length) return beats.value.length;
  const text = [story.value?.synopsis, story.value?.body].filter(Boolean).join('\n');
  return Math.max(1, text.split(/(?<=[。！？.!?])|\n+/u).map((item) => item.trim()).filter(Boolean).length);
});
const recommended = computed(() => recommendedStoryboardPanelCount(segmentCount.value));
const active = computed(() => Boolean(storyboard.value?.activeJob && ['SUBMITTING', 'QUEUED', 'RUNNING'].includes(storyboard.value.activeJob.status)));
const providerReady = computed(() => Boolean(provider.value?.enabled && ['nodes_detected', 'verified'].includes(provider.value.verification.status)));
const nextPage = computed(() => pages.value.find((page) => page.pageNumber === (storyboard.value?.pageNumber ?? 0) + 1) ?? null);
const allPagesReady = computed(() => pages.value.length > 0 && pages.value.every((page) => page.panels.every((panel) => panel.assetId)));

function syncDrafts() {
  panelDrafts.value = Object.fromEntries((storyboard.value?.panels ?? []).map((panel) => [panel.id, panel.description]));
}

async function load(showError = true) {
  try {
    const [board, profile, storyDoc, storyBeats] = await Promise.all([
      get<Storyboard | null>(selectedPageId.value ? `/api/storyboard?id=${encodeURIComponent(selectedPageId.value)}` : '/api/storyboard'),
      get<StoryboardProviderProfile>('/api/providers/runninghub/storyboard-profile'),
      get<{ plannedDurationSeconds: number; synopsis: string; body: string }>('/api/story'),
      get<Array<{ durationSeconds: number }>>('/api/story/beats'),
    ]);
    storyboard.value = board;
    provider.value = profile;
    story.value = storyDoc;
    beats.value = storyBeats;
    pages.value = await get<Storyboard[]>('/api/storyboard/pages');
    if (board) {
      selectedPageId.value = board.id;
      pages.value = pages.value.map((page) => page.id === board.id ? board : page);
    }
    if (!board) selectedCount.value = recommended.value;
    syncDrafts();
    schedulePoll();
  } catch (error) {
    if (showError) toasts.push({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
  }
}

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  if (!active.value) return;
  pollTimer = setTimeout(() => void load(false), 4000);
}

async function prepare() {
  busy.value = true;
  try {
    storyboard.value = await post<Storyboard>('/api/storyboard/prepare', { panelCount: selectedCount.value });
    selectedPageId.value = storyboard.value.id;
    pages.value = await get<Storyboard[]>('/api/storyboard/pages');
    syncDrafts();
    toasts.push({ kind: 'ok', text: t('workflow.storyboard.createdAFreeValuePanelTextPlan', { v0: selectedCount.value }) });
  } catch (error) {
    toasts.push({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
  } finally {
    busy.value = false;
  }
}

async function selectPage(id: string) {
  if (id === storyboard.value?.id) return;
  selectedPageId.value = id;
  await load();
}

async function savePanel(panelId: string) {
  try {
    storyboard.value = await patch<Storyboard>(`/api/storyboard/panels/${panelId}`, { description: panelDrafts.value[panelId] });
    syncDrafts();
    toasts.push({ kind: 'ok', text: t('workflow.storyboard.panelDescriptionSaved') });
  } catch (error) {
    toasts.push({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
  }
}

function costText(): string {
  return provider.value?.estimatedCostCny == null ? t('workflow.storyboard.costIsDeterminedByRunningHub') : t('workflow.storyboard.estimatedValuePerRun', { v0: provider.value.estimatedCostCny.toFixed(2) });
}

async function generateSheet() {
  if (!storyboard.value || busy.value || active.value) return;
  const ok = await confirmDialog({
    title: t('workflow.storyboard.generateAValuePanelStoryboard', { v0: storyboard.value.panelCount }),
    message: t('workflow.storyboard.valueThisCreatesARealPaidRunningHub', { v0: costText() }),
    confirmLabel: t('workflow.storyboard.confirmPaidGeneration'),
  });
  if (!ok) return;
  busy.value = true;
  try {
    storyboard.value = await post<Storyboard>(`/api/storyboard/${storyboard.value.id}/generate`, { confirmed: true });
    toasts.push({ kind: 'info', text: t('workflow.storyboard.storyboardGenerationSubmittedYouMayLeaveAnd') });
    schedulePoll();
  } catch (error) {
    toasts.push({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
  } finally {
    busy.value = false;
  }
}

async function regeneratePanel(panelId: string, order: number) {
  if (!storyboard.value || busy.value || active.value) return;
  const ok = await confirmDialog({
    title: t('workflow.storyboard.regeneratePanelValue', { v0: order }),
    message: t('workflow.storyboard.valueTheOldVersionIsKeptOnly', { v0: costText() }),
    confirmLabel: t('workflow.storyboard.confirmPaidRegeneration'),
  });
  if (!ok) return;
  busy.value = true;
  try {
    storyboard.value = await post<Storyboard>(`/api/storyboard/${storyboard.value.id}/panels/${panelId}/regenerate`, { confirmed: true });
    schedulePoll();
  } catch (error) {
    toasts.push({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
  } finally {
    busy.value = false;
  }
}

async function approve() {
  if (!storyboard.value) return;
  try {
    storyboard.value = await post<Storyboard>(`/api/storyboard/${storyboard.value.id}/approve`, {});
    pages.value = await get<Storyboard[]>('/api/storyboard/pages');
    const sync = storyboard.value.sync;
    toasts.push({
      kind: 'ok',
      text: sync
        ? t('workflow.storyboard.storyboardApprovedAndSyncedToShotboardValue', { v0: sync.shotsCreated, v1: sync.shotsUpdated, v2: sync.bindingsCreated })
        : t('workflow.storyboard.storyboardApprovedAndSyncedToShotboard'),
    });
  } catch (error) {
    toasts.push({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
  }
}

function actualCost(): string | null {
  const cost = storyboard.value?.activeJob?.cost;
  if (!cost) return null;
  const money = cost.thirdPartyConsumeMoney ?? cost.consumeMoney;
  return [money != null ? t('workflow.storyboard.amountValue', { v0: Number(money) }) : null, cost.consumeCoins != null ? t('workflow.storyboard.valueCoins', { v0: Number(cost.consumeCoins) }) : null, cost.taskCostTime != null ? `${cost.taskCostTime}s` : null].filter(Boolean).join(' · ');
}

onMounted(() => void load());
onUnmounted(() => { if (pollTimer) clearTimeout(pollTimer); });
</script>

<template>
  <div class="page storyboard-page">
    <div class="spread page-head">
      <div><h1>{{ t('workflow.storyboard.storyboardOptional') }}</h1><p class="muted">{{ t('workflow.storyboard.reviewTheTextPanelsForFreeBefore') }}</p></div>
      <div class="row"><RouterLink class="button-link sm" to="/story">← {{ t('workflow.storyboard.story') }}</RouterLink><RouterLink class="button-link sm" to="/shots">{{ t('workflow.storyboard.continueToShotboard') }}</RouterLink></div>
    </div>

    <div v-if="!storyboard" class="panel setup-panel">
      <div class="panel-title">{{ t('workflow.storyboard.createTextPanelsFirstFree') }}</div>
      <div class="panel-body col">
        <p>{{ t('workflow.storyboard.about') }} <strong>{{ segmentCount }} {{ t('workflow.storyboard.narrativeSegments') }}</strong>（{{ t('workflow.storyboard.projectApprox') }} {{ duration }} {{ t('workflow.storyboard.sec') }}），{{ t('workflow.storyboard.recommendedFirstPage') }} <strong>{{ recommended }} {{ t('workflow.storyboard.panels') }}</strong>。{{ t('workflow.storyboard.eachShotRemainsAnIndependent215') }}</p>
        <p v-if="segmentCount > 9" class="muted">{{ t('workflow.storyboard.moreThanNineSegmentsAreSplitAcross') }}</p>
        <div class="count-options">
          <label v-for="count in ([3, 6, 9] as const)" :key="count" :class="{ selected: selectedCount === count }">
            <input v-model="selectedCount" type="radio" :value="count" /><strong>{{ count }} {{ t('workflow.storyboard.panels2') }}</strong><span>{{ count === recommended ? t('workflow.storyboard.recommended') : count === 3 ? t('workflow.storyboard.13Segments') : count === 6 ? t('workflow.storyboard.46Segments') : t('workflow.storyboard.79SegmentsPage') }}</span>
          </label>
        </div>
        <button class="primary" :disabled="busy" @click="prepare">{{ busy ? t('workflow.storyboard.preparing') : t('workflow.storyboard.createTextStoryboardFree') }}</button>
      </div>
    </div>

    <template v-else>
      <div class="panel status-panel">
        <div class="panel-body spread">
          <div class="row wrap">
            <span class="badge">{{ t('workflow.storyboard.page') }} {{ storyboard.pageNumber }}/{{ storyboard.totalPages }} · {{ storyboard.panelCount }} {{ t('workflow.storyboard.panels3') }}</span>
            <span class="muted">{{ t('workflow.storyboard.coversSegments') }} {{ storyboard.sourceStartIndex + 1 }}–{{ storyboard.sourceEndIndex }} · {{ t('workflow.storyboard.projectApprox2') }} {{ storyboard.sourceDurationSeconds }}s</span>
            <span class="badge" :class="storyboard.status === 'failed' ? 'bad' : storyboard.status === 'approved' ? 'ok' : active ? 'warn' : ''">{{ active ? t('workflow.storyboard.aiGenerating') : storyboard.status === 'approved' ? t('workflow.storyboard.approved') : storyboard.status === 'failed' ? t('workflow.storyboard.generationFailed') : storyboard.status === 'ready' ? t('workflow.storyboard.imagesReady') : t('workflow.storyboard.textPlan') }}</span>
            <span v-if="actualCost()" class="muted">{{ t('workflow.storyboard.thisRun') }}{{ actualCost() }}</span>
            <span v-if="storyboard.activeJob?.error" class="bad-text">{{ storyboard.activeJob.error }}</span>
          </div>
          <div class="row"><select v-model="selectedCount"><option :value="3">3</option><option :value="6">6</option><option :value="9">9</option></select><button class="sm" :disabled="busy || active" @click="prepare">{{ t('workflow.storyboard.prepareAgain') }}</button></div>
        </div>
      </div>

      <nav v-if="pages.length > 1" class="page-tabs" aria-label="Storyboard pages">
        <button v-for="page in pages" :key="page.id" class="page-tab" :class="{ active: page.id === storyboard.id }" @click="selectPage(page.id)">
          {{ t('workflow.storyboard.page2') }} {{ page.pageNumber }}
          <span :class="page.status === 'failed' ? 'bad-text' : 'muted'">{{ page.status === 'approved' ? t('workflow.storyboard.approved2') : page.panels.every(panel => panel.assetId) ? t('workflow.storyboard.generated') : page.status === 'generating' ? t('workflow.storyboard.generating') : t('workflow.storyboard.pending') }}</span>
        </button>
      </nav>

      <div class="storyboard-grid">
        <article v-for="panel in storyboard.panels" :key="panel.id" class="storyboard-panel">
          <div class="panel-image"><img v-if="panel.assetId" :src="mediaUrl(panel.assetId)" :alt="`Storyboard ${panel.order}`" /><span v-else>{{ panel.order }}</span></div>
          <div class="panel-editor">
            <div class="spread"><strong>{{ t('workflow.storyboard.page3') }} {{ storyboard.pageNumber }} · {{ t('workflow.storyboard.panel') }} {{ panel.order }}</strong><span class="muted">v{{ panel.version }}</span></div>
            <textarea v-model="panelDrafts[panel.id]" rows="4" :disabled="active"></textarea>
            <div class="row"><button class="sm" :disabled="panelDrafts[panel.id]?.trim() === panel.description" @click="savePanel(panel.id)">{{ t('workflow.storyboard.saveDescription') }}</button><button v-if="panel.assetId" class="sm" :disabled="busy || active || !providerReady" @click="regeneratePanel(panel.id, panel.order)">{{ t('workflow.storyboard.regenerateThisPanel') }}</button></div>
          </div>
        </article>
      </div>

      <div class="action-bar panel">
        <div><strong>{{ providerReady ? costText() : t('workflow.storyboard.imageProviderNotDetected') }}</strong><p class="muted">{{ t('workflow.storyboard.fixedBlackFramesTheGeneratedSheetIs') }}</p></div>
        <div class="row wrap"><RouterLink v-if="!providerReady" class="button-link sm" to="/settings">{{ t('workflow.storyboard.setUpImageAPI') }}</RouterLink><button class="primary" :disabled="busy || active || !providerReady" @click="generateSheet">{{ active ? t('workflow.storyboard.aiGenerating2') : storyboard.sheetAssetId ? t('workflow.storyboard.regenerateThisPage') : t('workflow.storyboard.generatePageValuePaid', { v0: storyboard.pageNumber }) }}</button><button v-if="nextPage && storyboard.panels.every(panel => panel.assetId)" class="sm" :disabled="active" @click="selectPage(nextPage.id)">{{ t('workflow.storyboard.nextPage') }}</button><button v-if="allPagesReady" class="sm" :disabled="active" @click="approve">{{ t('workflow.storyboard.approveAllAndContinue') }}</button></div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.storyboard-page { padding: 24px 32px 90px; max-width: 1240px; margin: 0 auto; }
.page-head h1 { margin: 0 0 6px; font-size: 22px; }.page-head p,.action-bar p { margin: 0; }.setup-panel { max-width: 760px; margin: 36px auto; }
.count-options { display: grid; grid-template-columns: repeat(3,1fr); gap: 10px; }.count-options label { display: grid; gap: 5px; padding: 14px; border: 1px solid var(--line-2); border-radius: var(--radius); cursor: pointer; }.count-options label.selected { border-color: var(--accent); background: var(--accent-soft); }.count-options input { position: absolute; opacity: 0; }.count-options span { color: var(--muted); font-size: 12px; }
.status-panel { margin: 18px 0 12px; }.storyboard-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 12px; }.storyboard-panel { min-width: 0; overflow: hidden; background: var(--bg-1); border: 1px solid var(--line-2); border-radius: var(--radius); }.panel-image { aspect-ratio: 3/2; display: grid; place-items: center; overflow: hidden; color: #fff; background: #050505; border: 8px solid #050505; font-size: 38px; font-weight: 700; }.panel-image img { width: 100%; height: 100%; object-fit: contain; background: #050505; }.panel-editor { display: grid; gap: 9px; padding: 12px; }.panel-editor textarea { width: 100%; resize: vertical; }
.page-tabs { display: flex; gap: 8px; overflow-x: auto; margin: 0 0 12px; padding: 2px 0; }.page-tab { display: grid; gap: 2px; min-width: 104px; text-align: left; }.page-tab.active { border-color: var(--accent); background: var(--accent-soft); }
.action-bar { position: sticky; bottom: 14px; display: flex; justify-content: space-between; align-items: center; gap: 20px; margin-top: 16px; padding: 14px 16px; box-shadow: 0 12px 36px rgb(0 0 0 / 18%); }.bad-text { color: var(--danger); font-size: 12px; }
@media (max-width: 880px) { .storyboard-grid { grid-template-columns: 1fr; }.action-bar { align-items: stretch; flex-direction: column; } }
</style>
