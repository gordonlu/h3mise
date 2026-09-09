<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { get, post, del, fileUrl } from '../api/client';
import { useProjectStore } from '../stores/project';
import { useToastStore } from '../stores/toast';
import { useRenderStore } from '../stores/render';
import { confirmDialog } from '../stores/confirm';
import { t } from '../stores/locale';
import { H3_MODE_LABEL, H3_MODES, SHOT_STATUS_LABEL, SHOT_USER_STATUS, SHOT_USER_STATUS_LABEL } from '@h3mise/shared';
import type { RenderBatchPlan, RenderBatchPrepareResult, RenderBatchShotStage, RenderJob, Shot, ShotRenderReadiness, ShotStatus } from '@h3mise/shared';
import EmptyState from '../components/EmptyState.vue';

interface ShotCard extends Shot {
  renderReadiness: ShotRenderReadiness;
  takeCount: number;
  selectedTakeId: string | null;
  activeJobs: number;
  missing: string[];
  risk: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  cover: string | null;
}

const project = useProjectStore();
const router = useRouter();
const toasts = useToastStore();
const renderStore = useRenderStore();
const shots = ref<ShotCard[]>([]);
const entities = ref<Array<{ id: string; name: string; kind: string }>>([]);
const showCreate = ref(false);
const showPaste = ref(false);
const newShot = ref({ title: '', purpose: '', shotFunction: 'wide', durationSeconds: 12, h3Mode: 't2va' });
const pasteText = ref('');
const busy = ref(false);
const filter = ref('');
const statusFilter = ref('');
const batchPlan = ref<RenderBatchPlan | null>(null);
const batchBusy = ref(false);
const batchOpen = ref(false);

const batchProviderId = computed(() => project.current?.config.default_provider ?? 'runninghub');
const batchMegapixels = computed(() => batchProviderId.value === 'runninghub' ? 0.6 : undefined);
const BATCH_CLASS: Record<RenderBatchShotStage, string> = { ready: 'ok', active: 'warn', done: 'ok', needs_selection: 'violet', waiting_dependency: 'warn', needs_assets: 'bad', needs_prompt: 'info', needs_preflight: 'info', blocked: 'bad' };
function batchStageLabel(stage: RenderBatchShotStage): string {
  return ({ ready: t('workflow.shots.ready'), active: t('workflow.shots.active'), done: t('workflow.shots.complete'), needs_selection: t('workflow.shots.selectTake'), waiting_dependency: t('workflow.shots.waitingUpstream'), needs_assets: t('workflow.shots.missingAssets'), needs_prompt: t('workflow.shots.needsPrompt'), needs_preflight: t('workflow.shots.needsCheck'), blocked: t('workflow.shots.blocked') })[stage];
}
function modeLabel(mode: string): string {
  return ({ t2va: t('workflow.shots.textToVideoT2VA'), i2va: t('workflow.shots.imageToVideoI2VA'), fl2va: t('workflow.shots.firstLastFrameVideoFL2VA'), ref2va: t('workflow.shots.referenceVideoRef2VA') } as Record<string, string>)[mode] ?? H3_MODE_LABEL[mode as keyof typeof H3_MODE_LABEL] ?? mode;
}
function statusLabel(status: string): string {
  return ({ draft: t('workflow.shots.needsDirection'), ready: t('workflow.shots.ready2'), rendering: t('workflow.shots.generating'), review: t('workflow.shots.selectTake2'), done: t('workflow.shots.complete2') } as Record<string, string>)[status] ?? status;
}

/** PRD §15: only expose modes the active provider profile supports.
 * Unknown capability = nothing offered (P1), never a theoretical fallback. */
const availableModes = computed(() => {
  const rh = project.providers.find((p) => p.id === 'runninghub' && p.configured);
  const active = rh ?? project.providers[0];
  return active?.capabilities?.supportedModes ?? [];
});

const RISK_BADGE: Record<string, string> = { LOW: 'ok', MEDIUM: 'warn', HIGH: 'bad' };

const filtered = computed(() => {
  let list = shots.value;
  if (statusFilter.value) list = list.filter((s) => SHOT_USER_STATUS[s.status as ShotStatus] === statusFilter.value);
  const f = filter.value.trim().toLowerCase();
  if (f) list = list.filter((s) => s.title.toLowerCase().includes(f) || s.id.includes(f) || (s.purpose ?? '').toLowerCase().includes(f));
  return list;
});

const statusCounts = computed(() => shots.value.reduce((acc, shot) => {
  const status = SHOT_USER_STATUS[shot.status as ShotStatus];
  acc[status] = (acc[status] ?? 0) + 1;
  return acc;
}, {} as Record<string, number>));

function nextAction(shot: ShotCard): string {
  const status = SHOT_USER_STATUS[shot.status as ShotStatus];
  if (status === 'review') return t('workflow.shots.selectTake3');
  if (status === 'rendering') return t('workflow.shots.generating2');
  if (status === 'done') return '查看成片';
  if (shot.missing?.length) return '补充素材';
  return status === 'ready' ? '开始生成' : '继续设计';
}

function entityName(id: string | null): string {
  if (!id) return '';
  return entities.value.find((e) => e.id === id)?.name ?? id;
}

async function load() {
  shots.value = await get<ShotCard[]>('/api/shots');
  entities.value = await get<Array<{ id: string; name: string; kind: string }>>('/api/assets/entities');
}

async function analyzeBatch() {
  batchOpen.value = true;
  batchBusy.value = true;
  try {
    const params = new URLSearchParams({ providerId: batchProviderId.value });
    if (batchMegapixels.value !== undefined) params.set('megapixels', String(batchMegapixels.value));
    batchPlan.value = await get<RenderBatchPlan>(`/api/render/batch/plan?${params}`);
  } catch (e) {
    toasts.push({ kind: 'err', text: `分析生成计划失败：${e instanceof Error ? e.message : e}` });
  } finally {
    batchBusy.value = false;
  }
}

async function prepareBatch() {
  batchBusy.value = true;
  try {
    const result = await post<RenderBatchPrepareResult>('/api/render/batch/prepare', {
      providerId: batchProviderId.value,
      ...(batchMegapixels.value !== undefined ? { megapixels: batchMegapixels.value } : {}),
    });
    batchPlan.value = result.plan;
    await load();
    const ok = result.prepared.filter((item) => !item.blocked).length;
    const blocked = result.prepared.filter((item) => item.blocked).length;
    toasts.push({ kind: blocked ? 'info' : 'ok', text: `批量准备完成：${ok} 个就绪${blocked ? `，${blocked} 个检查未通过` : ''}；尚未提交视频生成` });
  } catch (e) {
    toasts.push({ kind: 'err', text: `批量准备失败：${e instanceof Error ? e.message : e}` });
  } finally {
    batchBusy.value = false;
  }
}

async function submitReadyBatch() {
  const ready = batchPlan.value?.shots.filter((item) => item.stage === 'ready' && item.promptVersionId) ?? [];
  if (!ready.length) return;
  const paid = batchProviderId.value === 'runninghub';
  const ok = await confirmDialog({
    title: `开始生成 ${ready.length} 个 Shot？`,
    message: `生成服务：${batchProviderId.value}\n并发上限：${batchPlan.value?.providerConcurrency ?? 1}${batchMegapixels.value !== undefined ? `\n输出像素：${batchMegapixels.value} MP` : ''}\n\n将提交 ${ready.length} 个独立生成任务。${paid ? 'RunningHub 可能分别计费；任务提交后云端通常无法真正取消。' : ''}`,
    confirmLabel: paid ? `确认并提交 ${ready.length} 个付费任务` : `加入 ${ready.length} 个任务`,
    danger: paid,
  });
  if (!ok) return;
  batchBusy.value = true;
  try {
    const results = await Promise.allSettled(ready.map((item) => post<RenderJob>('/api/render', {
      shotId: item.shotId,
      promptVersionId: item.promptVersionId,
      providerId: batchProviderId.value,
      ...(batchMegapixels.value !== undefined ? { megapixels: batchMegapixels.value } : {}),
    })));
    const submitted = results.filter((result) => result.status === 'fulfilled').length;
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    await Promise.all([load(), renderStore.refresh()]);
    await analyzeBatch();
    if (submitted) toasts.push({ kind: 'ok', text: `已将 ${submitted} 个 Shot 加入全局渲染队列` });
    if (failures.length) {
      const first = failures[0]?.reason;
      toasts.push({ kind: 'err', text: `${failures.length} 个 Shot 未能提交：${first instanceof Error ? first.message : String(first)}` });
    }
  } finally {
    batchBusy.value = false;
  }
}

async function createShot() {
  busy.value = true;
  try {
    const shot = await post<Shot>('/api/shots', { ...newShot.value, h3Mode: newShot.value.h3Mode || null });
    showCreate.value = false;
    toasts.push({ kind: 'ok', text: `Shot ${shot.id} 已创建` });
    router.push(`/shots/${shot.id}`);
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  } finally {
    busy.value = false;
  }
}

async function deleteShot(shot: ShotCard) {
  const ok = await confirmDialog({
    title: `删除 Shot「${shot.title || shot.id}」？`,
    message: '将同时删除其导演计划、Prompt 版本、Takes、生成任务和 Timeline 片段，不可恢复。',
    confirmLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await del(`/api/shots/${shot.id}`);
    toasts.push({ kind: 'ok', text: 'Shot 已删除' });
    await load();
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  }
}

async function pasteShots() {
  busy.value = true;
  try {
    // Accept plain text lines or JSON/YAML-ish arrays.
    let items: Array<Record<string, unknown>> = [];
    const text = pasteText.value.trim();
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      const lines = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && !l.startsWith('-'));
      // Guard: 段落式内容（每行以【】开头）更像单条 Prompt 而不是 Shot 列表，
      // 按行拆分会误建成多个 Shot —— 先让用户确认。
      if (lines.length > 1 && lines.every((l) => l.startsWith('【'))) {
        const proceed = await confirmDialog({
          title: '看起来像单条提示词？',
          message: `检测到 ${lines.length} 段以【】开头的段落，通常是同一条提示词的分段，而不是镜头列表。确认要按行拆分成 ${lines.length} 个镜头吗？\n\n如需整段输入提示词，请进入镜头制作页 → 提示词 → 手动输入提示词。`,
          confirmLabel: '仍要拆分',
          danger: true,
        });
        if (!proceed) return;
      }
      items = lines.map((l) => ({ title: l.replace(/^\d+[.、)\s]*/, '').slice(0, 60) }));
    }
    const res = await post<Shot[]>('/api/shots/bulk', { items });
    toasts.push({ kind: 'ok', text: `已创建 ${res.length} 个 Shot` });
    pasteText.value = '';
    showPaste.value = false;
    await load();
  } catch (e) {
    toasts.push({ kind: 'err', text: `解析失败：${e instanceof Error ? e.message : e}` });
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h1>{{ t('pages.shots.title') }}</h1>
        <p>以镜头为单位推进设计、生成与选片，下一步始终清晰可见。</p>
      </div>
      <div class="head-side">
        <div class="shot-summary" aria-label="镜头状态概览">
          <span>共 {{ shots.length }} 镜头</span>
          <span>制作中 {{ statusCounts.rendering ?? 0 }}</span>
          <span>待选片 {{ statusCounts.review ?? 0 }}</span>
          <span>已完成 {{ statusCounts.done ?? 0 }}</span>
        </div>
        <div class="row">
          <button @click="showPaste = !showPaste; showCreate = false">{{ t('workflow.shots.pasteShotList') }}</button>
          <button class="primary" @click="showCreate = !showCreate; showPaste = false">{{ t('workflow.shots.newShot') }}</button>
        </div>
      </div>
    </div>

    <div class="toolbar panel">
      <div class="toolbar-search">
        <svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5.5"/><path d="m13 13 4 4"/></svg>
        <input v-model="filter" :placeholder="t('workflow.shots.searchShots')" class="search" />
      </div>
      <select v-model="statusFilter" class="status-filter" :title="t('workflow.shots.filterByStatus')">
        <option value="">{{ t('workflow.shots.allStatuses') }}</option>
        <option v-for="(_, key) in SHOT_USER_STATUS_LABEL" :key="key" :value="key">{{ statusLabel(String(key)) }}</option>
      </select>
      <span class="toolbar-result">显示 {{ filtered.length }} 个</span>
      <button class="batch-trigger" @click="batchOpen ? batchOpen = false : analyzeBatch()">{{ batchOpen ? t('workflow.shots.hideBatchGeneration') : t('workflow.shots.batchGeneration') }}</button>
    </div>

    <div v-if="batchOpen" class="panel batch-panel">
      <div class="panel-title spread">
        <span>{{ t('workflow.shots.projectGenerationScheduler') }} · {{ batchProviderId }}</span>
        <span v-if="batchPlan" class="muted">Provider {{ t('workflow.shots.concurrency') }} {{ batchPlan.providerConcurrency }}{{ batchMegapixels !== undefined ? ` · ${batchMegapixels} MP` : '' }}</span>
      </div>
      <div class="panel-body col">
        <p class="muted">{{ t('workflow.shots.analyzeDependenciesAndPreparePromptPreflightFirst') }}</p>
        <div v-if="batchBusy && !batchPlan" class="muted">{{ t('workflow.shots.analyzingShots') }}</div>
        <template v-if="batchPlan">
          <div class="row wrap batch-counts">
            <span v-for="(cls, stage) in BATCH_CLASS" :key="stage" v-show="batchPlan.counts[stage]" :class="['badge', cls]">
              {{ batchStageLabel(stage) }} {{ batchPlan.counts[stage] }}
            </span>
          </div>
          <div class="batch-list">
            <div v-for="item in batchPlan.shots" :key="item.shotId" class="batch-row">
              <span class="mono muted">{{ String(item.order).padStart(2, '0') }}</span>
              <router-link :to="`/shots/${item.shotId}`">{{ item.title || item.shotId }}</router-link>
              <span :class="['badge', BATCH_CLASS[item.stage]]">{{ batchStageLabel(item.stage) }}</span>
              <span class="muted batch-reason" :title="item.reason">{{ item.reason }}</span>
            </div>
          </div>
          <div class="row batch-actions">
            <button :disabled="batchBusy" @click="analyzeBatch">{{ t('workflow.shots.analyzeAgain') }}</button>
            <button :disabled="batchBusy" @click="prepareBatch">{{ batchBusy ? t('workflow.shots.processing') : t('workflow.shots.batchPrepareNoVideoGeneration') }}</button>
            <button class="primary" :disabled="batchBusy || !batchPlan.counts.ready" @click="submitReadyBatch">
              {{ t('workflow.shots.confirmAndGenerateValueReadyShots', { v0: batchPlan.counts.ready }) }}
            </button>
          </div>
        </template>
      </div>
    </div>

    <div v-if="showCreate" class="panel create-panel">
      <div class="panel-title">{{ t('workflow.shots.newShotOneShotOneContinuousCinematic') }}</div>
      <div class="panel-body col">
        <div class="row">
          <label class="field grow">
            {{ t('workflow.shots.title') }}
            <input v-model="newShot.title" :placeholder="t('workflow.shots.shotTitle')" @keyup.enter="createShot" />
          </label>
          <label class="field mode-field">
            H3 Mode
            <select v-model="newShot.h3Mode">
              <option v-for="m in availableModes" :key="m" :value="m">{{ modeLabel(m) }}</option>
            </select>
          </label>
          <label class="field">
            {{ t('workflow.shots.duration') }}
            <input v-model.number="newShot.durationSeconds" type="number" min="1" max="15" :title="t('workflow.shots.durationSeconds115')" placeholder="12" />
          </label>
        </div>
        <label class="field">
          {{ t('workflow.shots.purpose') }}
          <textarea v-model="newShot.purpose" rows="2" :placeholder="t('workflow.shots.whatShouldThisShotAccomplish')"></textarea>
        </label>
        <div class="row">
          <button class="primary" :disabled="busy || !newShot.title.trim()" @click="createShot">{{ t('workflow.shots.createAndOpen') }}</button>
          <button @click="showCreate = false">{{ t('common.cancel') }}</button>
        </div>
      </div>
    </div>

    <div v-if="showPaste" class="panel create-panel">
      <div class="panel-title">{{ t('workflow.shots.pasteExternalAIManualShotListOne') }}</div>
      <div class="panel-body col">
        <textarea v-model="pasteText" rows="6" placeholder="1. 雨夜小巷，女子走入镜头&#10;2. 她在路灯下停步&#10;…"></textarea>
        <div class="row">
          <button class="primary" :disabled="busy || !pasteText.trim()" @click="pasteShots">{{ t('workflow.shots.importShots') }}</button>
          <button @click="showPaste = false">{{ t('common.cancel') }}</button>
        </div>
      </div>
    </div>

    <div v-if="!shots.length" class="panel">
      <EmptyState icon="🎬" :title="t('workflow.shots.noShotsYet')" :desc="t('workflow.shots.shotsAreTheDirectorSPrimaryUnit')">
        <button class="primary sm" @click="showCreate = true">{{ t('workflow.shots.newShot2') }}</button>
        <button class="sm" @click="showPaste = true">{{ t('workflow.shots.pasteShotList2') }}</button>
      </EmptyState>
    </div>

    <div class="board">
      <router-link v-for="(s, i) in filtered" :key="s.id" :to="`/shots/${s.id}`" class="card panel">
        <div class="cover" :class="{ 'no-cover': !s.cover }">
          <img v-if="s.cover" :src="fileUrl(s.cover)" :alt="s.title" />
          <span v-else class="cover-idx">SHOT<br />{{ String(i + 1).padStart(2, '0') }}</span>
          <span class="cover-duration">{{ s.durationSeconds }}s</span>
        </div>
        <div class="card-body">
          <div class="card-heading">
            <span class="shot-number">{{ String(i + 1).padStart(2, '0') }}</span>
            <span class="card-title">{{ s.title || s.id }}</span>
            <span :class="['st', `st-${SHOT_USER_STATUS[s.status]}`]" :title="`内部状态：${SHOT_STATUS_LABEL[s.status]}`">
              <i />{{ statusLabel(SHOT_USER_STATUS[s.status]) }}
            </span>
            <button class="ghost shot-delete" :title="t('workflow.shots.deleteShotIncludingItsPlanPromptsTakes')" @click.stop.prevent="deleteShot(s)">•••</button>
          </div>
          <div class="muted purpose">{{ s.purpose || '—' }}</div>
          <div class="shot-meta">
            <span>{{ modeLabel(s.h3Mode ?? 't2va') }}</span>
            <span>{{ s.shotFunction }}</span>
            <span v-if="entityName(s.primaryCharacterId)">{{ entityName(s.primaryCharacterId) }}</span>
            <span v-if="entityName(s.sceneId)">{{ entityName(s.sceneId) }}</span>
          </div>
          <div v-if="s.missing?.length" class="missing-row">
            <strong>{{ t('workflow.shots.missingAssets2') }}</strong>
            <span>{{ s.missing.join('、') }}</span>
          </div>
          <div class="spread card-foot">
            <span class="take-info">{{ s.takeCount }} Takes · {{ s.selectedTakeId ? t('workflow.shots.selected') : t('workflow.shots.notSelected') }}</span>
            <span v-if="s.risk" :class="['risk-text', `risk-${RISK_BADGE[s.risk]}`]" title="最近一次 Preflight 风险">Risk {{ s.risk }}</span>
            <span class="edit-link">{{ nextAction(s) }} <b>→</b></span>
          </div>
        </div>
      </router-link>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 30px 32px 48px; max-width: 1440px; margin: 0 auto; }
.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 32px; margin-bottom: 22px; }
h1 { font-size: 30px; line-height: 1.15; margin: 0; font-weight: 720; letter-spacing: -0.035em; }
.page-head p { margin: 8px 0 0; color: var(--text-2); font-size: 13px; }
.head-side { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; }
.shot-summary { display: flex; align-items: center; color: var(--text-3); font-size: 11.5px; }
.shot-summary span { padding: 0 10px; border-right: 1px solid var(--line-2); white-space: nowrap; }
.shot-summary span:first-child { padding-left: 0; }
.shot-summary span:last-child { padding-right: 0; border-right: 0; }
.toolbar { min-height: 58px; display: flex; align-items: center; gap: 10px; padding: 9px 10px; box-shadow: none; }
.toolbar-search { position: relative; flex: 1; min-width: 260px; }
.toolbar-search svg { position: absolute; left: 12px; top: 50%; width: 17px; height: 17px; transform: translateY(-50%); fill: none; stroke: var(--text-3); stroke-width: 1.6; pointer-events: none; }
.search { width: 100%; padding-left: 38px; background: var(--bg-subtle); border-color: transparent; }
.search:focus { background: var(--bg-2); }
.status-filter { width: 132px; }
.toolbar-result { padding: 0 6px; color: var(--text-3); font-size: 12px; white-space: nowrap; }
.batch-trigger { margin-left: auto; }
.create-panel { margin: 16px 0; }
.batch-panel { margin: 16px 0; }
.batch-counts { gap: 7px; }
.batch-list { display: grid; gap: 6px; max-height: 320px; overflow: auto; }
.batch-row { display: grid; grid-template-columns: 28px minmax(130px, 0.8fr) max-content minmax(180px, 1.5fr); align-items: center; gap: 9px; padding: 7px 9px; border-radius: var(--radius-sm); background: var(--bg-subtle); font-size: 12px; }
.batch-reason { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.batch-actions { justify-content: flex-end; flex-wrap: wrap; }
.mode-field select { width: 220px; }
.board { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; margin-top: 18px; }
.shot-delete { margin-left: 2px; padding: 3px 6px; font-size: 12px; letter-spacing: 1px; flex: none; }
.card { display: block; text-decoration: none; color: inherit; position: relative; overflow: hidden; box-shadow: none; transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s; }
.card:hover { border-color: var(--line-3); transform: translateY(-2px); box-shadow: var(--shadow-1); text-decoration: none; }
.cover { position: relative; aspect-ratio: 16 / 9; min-height: 220px; background: var(--inset); display: flex; align-items: center; justify-content: center; overflow: hidden; }
.cover img { width: 100%; height: 100%; object-fit: cover; }
.cover-idx { font-family: var(--mono); letter-spacing: 0.24em; color: var(--text-3); text-align: center; line-height: 1.8; font-size: 12px; }
.cover-duration {
  position: absolute; bottom: 8px; right: 8px;
  background: rgba(20,20,20,0.76); color: #fff; font-size: 11px; font-weight: 600;
  padding: 3px 8px; border-radius: 5px; font-variant-numeric: tabular-nums;
  pointer-events: none;
}
.card-body { padding: 15px 16px 14px; display: flex; flex-direction: column; gap: 9px; }
.card-heading { display: flex; align-items: center; gap: 10px; }
.shot-number { font-family: var(--mono); color: var(--text); font-size: 16px; font-weight: 700; padding-right: 10px; border-right: 1px solid var(--line-2); }
.card-title { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 680; font-size: 15px; }
.purpose { display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; min-height: 20px; color: var(--text-2); }
.shot-meta { display: flex; flex-wrap: wrap; gap: 0; color: var(--text-2); font-size: 11.5px; }
.shot-meta span { padding: 0 9px; border-right: 1px solid var(--line-2); }
.shot-meta span:first-child { padding-left: 0; }
.shot-meta span:last-child { border-right: 0; }
.wrap { flex-wrap: wrap; }
.missing-row { display: flex; align-items: center; gap: 7px; padding: 7px 9px; border-radius: 6px; color: var(--bad); background: var(--bad-soft); font-size: 11.5px; }
.missing-row span { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-foot { border-top: 1px solid var(--line); padding-top: 10px; }
.take-info { color: var(--text-3); font-size: 11.5px; }
.risk-text { font-size: 10.5px; font-weight: 700; letter-spacing: .03em; }
.risk-ok { color: var(--ok); }
.risk-warn { color: var(--warn); }
.risk-bad { color: var(--bad); }
.edit-link { margin-left: auto; font-size: 12.5px; color: var(--accent-text); font-weight: 600; white-space: nowrap; }
.edit-link b { margin-left: 4px; font-size: 14px; }
</style>
