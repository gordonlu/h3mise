<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, toRaw, watch } from 'vue';
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router';
import { useShot } from '../composables/useShot';
import { useProjectStore } from '../stores/project';
import { useToastStore } from '../stores/toast';
import { useRenderStore } from '../stores/render';
import { confirmDialog } from '../stores/confirm';
import { get, post, del, takeVideoUrl, fileUrl, subscribeEvents } from '../api/client';
import { H3_MODE_LABEL, H3_MODES, SHOT_STATUS_LABEL, SHOT_USER_STATUS, SHOT_USER_STATUS_LABEL, emptyDirectorPlan } from '@h3mise/shared';
import type { DirectorPlan, MediaAsset, NextAction } from '@h3mise/shared';
import PlanEditor from '../components/director/PlanEditor.vue';
import PromptPanel from '../components/director/PromptPanel.vue';
import PreflightPanel from '../components/director/PreflightPanel.vue';
import TakesPanel from '../components/director/TakesPanel.vue';
import ReferencesPanel from '../components/director/ReferencesPanel.vue';
import VideoPlayer from '../components/VideoPlayer.vue';
import GuideStepper from '../components/GuideStepper.vue';
import WorkspacePanel from '../components/director/WorkspacePanel.vue';

const route = useRoute();
const router = useRouter();
const shotId = route.params.id as string;
const project = useProjectStore();
const toasts = useToastStore();
const renderStore = useRenderStore();
const emptyPlan = () => emptyDirectorPlan();
function aiText(v: unknown): string {
  return (v as { text?: string })?.text ?? '';
}

const s = useShot(shotId);

const {
  detail: sDetail,
  shot: sShot,
  latestPlan: sPlan,
  selectedTake: sSelected,
  loading: sLoading,
  error: sError,
} = s;

const tab = ref<'workspace' | 'plan' | 'references' | 'prompt' | 'preflight' | 'external'>('workspace');
const media = ref<MediaAsset[]>([]);
const aiJobs = ref<Record<string, string>>({}); // actionKey -> jobId
const aiResults = ref<Record<string, unknown>>({});
const externalTask = ref('Plan Shot');
const pasteText = ref('');
const parseResult = ref<{ ok: boolean; plan?: DirectorPlan; error?: string } | null>(null);
const planDirty = ref(false);
const takesSection = ref<HTMLElement | null>(null);

// P1: AI availability comes from /api/ai/status, NOT from whether a render
// provider is configured — the two are independent features.
const aiEnabled = ref(false);
async function refreshAiStatus() {
  try {
    const s = await get<{ aiConfigured?: boolean }>('/api/ai/status');
    aiEnabled.value = Boolean(s.aiConfigured);
  } catch {
    aiEnabled.value = false;
  }
}

/** Active render provider: prefer the real RunningHub when configured, else
 * whatever the server exposes (e.g. mock in offline mode). */
const activeProvider = computed(() => {
  const rh = project.providers.find((p) => p.id === 'runninghub' && p.configured);
  return rh ?? project.providers[0] ?? null;
});
const providerId = computed(() => activeProvider.value?.id ?? 'runninghub');

/** PRD §15: UI only opens modes the current provider profile actually supports.
 * Unknown capability = nothing offered (P1), never a theoretical fallback. */
const availableModes = computed(() => {
  const caps = activeProvider.value?.capabilities;
  return caps?.supportedModes ?? [];
});

const userStatus = computed(() => (sShot.value ? SHOT_USER_STATUS[sShot.value.status] : 'draft'));

const guideActionLabel = computed(() => {
  const kind = sDetail.value?.guide.nextAction.kind;
  if (kind === 'design_shot') return '编辑镜头设计';
  if (kind === 'add_reference') return '添加参考素材';
  if (kind === 'review_prompt') return '准备 Prompt';
  if (kind === 'run_preflight') return '开始生成检查';
  if (kind === 'render') return '确认生成参数';
  if (kind === 'wait_render') return '查看生成任务';
  if (kind === 'select_take') return '比较 Takes';
  if (kind === 'continue_next_shot') return '继续下一个镜头';
  if (kind === 'open_timeline') return '进入成片编排';
  return '前往导出';
});

function openGuideAction(action: NextAction) {
  if (action.kind === 'wait_render') {
    renderStore.drawerOpen = true;
    return;
  }
  if (action.kind === 'select_take') {
    takesSection.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (action.kind === 'design_shot') tab.value = 'plan';
  else if (action.kind === 'add_reference') tab.value = 'references';
  else if (action.kind === 'review_prompt') tab.value = 'prompt';
  else if (action.kind === 'run_preflight' || action.kind === 'render') tab.value = 'preflight';
  else void router.push(action.to);
}

function applyGuideQuery() {
  const target = route.query.guide;
  if (target === 'design') tab.value = 'plan';
  else if (target === 'references') tab.value = 'references';
  else if (target === 'prompt') tab.value = 'prompt';
  else if (target === 'preflight') tab.value = 'preflight';
}

const EXTERNAL_TASKS = [
  { id: 'Plan Shot', key: 'plan_shot' },
  { id: 'Improve Camera', key: 'improve_camera' },
  { id: 'Improve Performance', key: 'improve_performance' },
  { id: 'Reality Check', key: 'reality_check' },
  { id: 'Continuity Check', key: 'continuity_check' },
  { id: 'Compile H3 Prompt', key: 'compile_prompt' },
  { id: 'Diagnose Failed Take', key: 'diagnose_take' },
];

function latestPrompt() {
  return sDetail.value?.prompts.at(-1) ?? null;
}

function mediaOf(assetId: string): MediaAsset | null {
  return media.value.find((m) => m.id === assetId) ?? null;
}

function thumbOf(assetId: string): string | null {
  const m = mediaOf(assetId);
  if (!m) return null;
  if (m.kind === 'image') return `/api/media/${m.id}`;
  if (m.posterPath) return fileUrl(m.posterPath);
  return null;
}

/** First-frame binding preview for the empty stage. */
const firstFrameThumb = computed(() => {
  const b = sDetail.value?.bindings.find((x) => x.roles.includes('first_frame'));
  return b ? thumbOf(b.assetId) : null;
});

async function loadMedia() {
  media.value = await get<MediaAsset[]>('/api/assets/media');
}

/** Run an AI action as a background job; poll until done; return result. */
async function runAi(action: string, body: Record<string, unknown>): Promise<unknown> {
  const key = `${action}:${JSON.stringify(body).slice(0, 40)}`;
  const res = await post<{ jobId: string; status: string }>(`/api/ai/actions/${action}`, body);
  aiJobs.value[key] = res.jobId;
  toasts.push({ kind: 'info', text: `AI 任务已提交，后台处理中（通常 10–60 秒，最长 3 分钟），结果会即时提示…` });
  let waited = 0;
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    waited += 1.5;
    const job = await get<{ status: string; result: unknown; error: string | null }>(`/api/jobs/${res.jobId}`);
    if (job.status === 'done') {
      delete aiJobs.value[key];
      return job.result;
    }
    if (job.status === 'failed') {
      delete aiJobs.value[key];
      throw new Error(job.error ?? 'AI job failed');
    }
    if (waited >= 30 && waited < 32) toasts.push({ kind: 'info', text: 'AI 仍在处理，请稍候…（超过 3 分钟会提示超时）' });
  }
  throw new Error('AI job timeout');
}

const aiBusy = computed(() => Object.keys(aiJobs.value).length > 0);

async function deleteThisShot() {
  const ok = await confirmDialog({
    title: `删除 Shot「${sShot.value?.title || shotId}」？`,
    message: '将同时删除其导演计划、Prompt 版本、Takes、生成任务和 Timeline 片段，不可恢复。',
    confirmLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await del(`/api/shots/${shotId}`);
    toasts.push({ kind: 'ok', text: 'Shot 已删除' });
    router.push('/shots');
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  }
}

async function guarded(fn: () => Promise<unknown>, okMsg?: string) {
  try {
    await fn();
    if (okMsg) toasts.push({ kind: 'ok', text: okMsg });
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  }
}

async function aiSuggest(section: string) {
  const body: Record<string, unknown> = { shotId };
  const action = section === 'full' ? 'plan_shot' : section === 'camera' ? 'improve_camera' : section === 'performance' ? 'improve_performance' : 'plan_shot';
  await guarded(async () => {
    if (section === 'reality') {
      aiResults.value.reality = await runAi('reality_check', body);
      toasts.push({ kind: 'info', text: 'Reality check 完成，结果见计划分区下方' });
      return;
    }
    const result = await runAi(action, body);
    const plan = (result as { plan?: DirectorPlan })?.plan;
    if (plan) {
      await s.savePlan(plan, 'builtin_ai');
      toasts.push({ kind: 'ok', text: `AI 建议已保存为新 DirectorPlan 版本（${action}），可继续手工调整` });
    } else {
      toasts.push({ kind: 'err', text: 'AI 未返回可用的计划' });
    }
  });
}

async function aiCompile() {
  await guarded(async () => {
    const result = await runAi('compile_prompt', { shotId });
    const text = (result as { text?: string })?.text;
    if (text) {
      await s.importRawPrompt(text, sShot.value?.h3Mode ?? 't2va');
      toasts.push({ kind: 'ok', text: 'AI 编译的 Prompt 已保存为新 PromptVersion' });
    }
  });
}

async function aiDiagnose(takeId: string) {
  await guarded(async () => {
    const result = await runAi('diagnose_take', { takeId });
    aiResults.value[`diag:${takeId}`] = result;
    toasts.push({ kind: 'ok', text: 'AI 诊断完成，见 Take 区域下方' });
  });
}

async function aiPreflight(_promptId: string) {
  const prompt = latestPrompt();
  if (!prompt) return null;
  let report: Awaited<ReturnType<typeof s.runPreflight>> | null = null;
  await guarded(async () => {
    const result = await runAi('continuity_check', { shotId });
    aiResults.value.continuity = result;
    report = await s.runPreflight(prompt.id);
    toasts.push({ kind: 'ok', text: 'Basic Preflight + AI 语义检查完成' });
  });
  return report;
}

async function doRender(promptId: string) {
  await guarded(async () => {
    const confirmed = await confirmDialog({
      title: '确认生成 1 个新 Take？',
      message: `${activeProvider.value?.name ?? '当前 Provider'} · ${H3_MODE_LABEL[sShot.value?.h3Mode ?? 't2va']} · ${sShot.value?.durationSeconds ?? 5}s · ${sShot.value?.aspectRatio ?? '16:9'}。提交后将创建一次生成任务。`,
      confirmLabel: '确认生成',
    });
    if (!confirmed) return;
    const job = await s.render(promptId, providerId.value, sShot.value?.durationSeconds);
    toasts.push({ kind: 'ok', text: `渲染任务 ${job.id} 已提交 — 状态实时推送` });
  });
}

function openWorkspaceTarget(target: 'plan' | 'references' | 'prompt' | 'preflight' | 'takes') {
  if (target === 'takes') {
    takesSection.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  tab.value = target;
}

async function copyContextPackage() {
  await guarded(async () => {
    const pkg = await s.contextPackage(externalTask.value);
    await navigator.clipboard.writeText(JSON.stringify(pkg, null, 2));
    toasts.push({ kind: 'ok', text: 'Context Package 已复制到剪贴板（未调用任何 API）' });
  });
}

async function parsePaste() {
  parseResult.value = await post(`/api/shots/${shotId}/plans/parse`, { text: pasteText.value });
}

async function applyParsed() {
  if (parseResult.value?.plan) {
    await s.savePlan(parseResult.value.plan, 'external_ai');
    toasts.push({ kind: 'ok', text: '外部 AI 的 DirectorPlan 已应用为新版本' });
    parseResult.value = null;
    pasteText.value = '';
    tab.value = 'plan';
  }
}

/** Frame Bridge "inherit continuity only" (PRD §32): fold the previous
 * shot's committed actual visual continuity into this shot's planned start. */
async function inheritContinuity() {
  const actual = sDetail.value?.continuityLatest?.visualActual?.state;
  if (!actual) {
    toasts.push({ kind: 'err', text: '没有已提交的 Actual Continuity 可继承（先在上一镜头 Select + Commit）' });
    return;
  }
  const plan = sPlan.value?.plan ? structuredClone(toRaw(sPlan.value.plan)) : emptyPlan();
  const parts = [
    actual.location && `location: ${actual.location}`,
    actual.timeOfDay && `time: ${actual.timeOfDay}`,
    actual.weather && `weather: ${actual.weather}`,
    actual.wind && `wind: ${actual.wind}`,
    actual.screenDirection && `screen direction: ${actual.screenDirection}`,
    actual.facing && `facing: ${actual.facing}`,
    ...Object.entries(actual.costume).map(([k, v]) => `${k} costume: ${v}`),
    ...Object.entries(actual.heldItems).map(([k, v]) => `${k} held: ${v.join(', ')}`),
    actual.notes && `notes: ${actual.notes}`,
  ].filter(Boolean);
  plan.continuity.plannedStartState = `Inherited from previous shot actual: ${parts.join('; ')}`;
  await s.savePlan(plan);
  toasts.push({ kind: 'ok', text: '已将上一镜头的 Actual Continuity 继承为本镜头的 Planned Start State' });
}

async function useTakeFrame(takeId: string, which: 'first' | 'last') {
  const target = media.value.find((m) => m.label.includes(`Take ${takeId} ${which} frame`));
  if (!target) {
    toasts.push({ kind: 'err', text: `未找到 Take ${takeId} 的${which === 'last' ? '尾' : '首'}帧资产` });
    return;
  }
  await s.addBinding({
    assetId: target.id,
    roles: ['first_frame'],
    label: `Frame bridge from ${takeId} (${which === 'last' ? 'last' : 'first'} frame)`,
  });
  toasts.push({ kind: 'ok', text: `已把 Take ${takeId} 的${which === 'last' ? '尾' : '首'}帧绑定为本镜头的 First Frame` });
}

/** Drag an asset from the rail library onto the shot → bind as reference. */
async function quickBind(assetId: string, roles: string[]) {
  const m = mediaOf(assetId);
  await s.addBinding({ assetId, roles, label: m?.label });
  toasts.push({ kind: 'ok', text: `已绑定 ${m?.label ?? assetId}（${roles.join(', ')}）` });
}

// --- unsaved-plan guards -----------------------------------------------------
function beforeUnload(e: BeforeUnloadEvent) {
  if (planDirty.value) e.preventDefault();
}

onBeforeRouteLeave(async () => {
  if (!planDirty.value) return true;
  return confirmDialog({
    title: '放弃未保存的修改？',
    message: 'DirectorPlan 有未保存的编辑。离开此页面将丢弃这些修改（不会生成新版本）。',
    confirmLabel: '放弃修改',
    danger: true,
  });
});

let off: (() => void) | null = null;

onMounted(async () => {
  await s.load();
  applyGuideQuery();
  await loadMedia();
  await project.refreshProviders();
  await refreshAiStatus();
  window.addEventListener('beforeunload', beforeUnload);
  off = subscribeEvents((e) => {
    if (e.type === 'take.created' || e.type === 'shot.updated' || e.type === 'render.job.succeeded') void s.load();
    if (e.type === 'take.created') void loadMedia();
  });
});

// Deep links (?guide=…) switch tabs without remounting the page, so
// unsaved editor drafts survive (v-show tab bodies stay alive).
watch(() => route.query.guide, applyGuideQuery);

onUnmounted(() => {
  off?.();
  window.removeEventListener('beforeunload', beforeUnload);
});

const TABS = [
  { id: 'workspace', cn: '工作台', en: 'Workspace' },
  { id: 'plan', cn: '导演计划', en: 'DirectorPlan' },
  { id: 'references', cn: '参考素材', en: 'References' },
  { id: 'prompt', cn: 'Prompt', en: 'Prompt' },
  { id: 'preflight', cn: '生成检查', en: 'Preflight' },
  { id: 'external', cn: '外部 AI', en: 'External AI' },
] as const;
</script>

<template>
  <div v-if="sLoading" class="page muted">加载中…</div>
  <div v-else-if="sError" class="page badge bad">{{ sError }}</div>

  <div v-else-if="sShot" class="desk">
    <!-- Breadcrumb + header -->
    <div class="crumbs">
      <router-link to="/shots" class="crumb-link">← Shotboard</router-link>
      <span class="muted">/</span>
      <span class="mono muted">{{ sShot.id }}</span>
    </div>
    <header class="desk-header">
      <div class="row wrap">
        <h1>{{ sShot.title || sShot.id }}</h1>
        <span :class="['st', `st-${userStatus}`]" :title="`内部状态：${SHOT_STATUS_LABEL[sShot.status]}（${sShot.status}）`">
          <i />{{ SHOT_USER_STATUS_LABEL[userStatus] }}
        </span>
        <span class="badge accent no-dot">{{ H3_MODE_LABEL[sShot.h3Mode ?? 't2va'] }}</span>
        <span class="badge no-dot">{{ sShot.durationSeconds }}s</span>
        <span class="badge no-dot">{{ sShot.aspectRatio }}</span>
        <span class="badge no-dot">{{ sShot.shotFunction }}</span>
        <span v-if="sShot.sequenceId" class="badge info no-dot">{{ sDetail?.sequences.find((x) => x.id === sShot?.sequenceId)?.title }}</span>
      </div>
      <div class="row controls">
        <button class="sm danger ghost" title="删除此 Shot 及其全部子数据" @click="deleteThisShot">删除 Shot</button>
        <label class="ctl">
          <span class="ctl-label">H3 Mode</span>
          <select v-model="sShot.h3Mode" @change="s.updateShot({ h3Mode: sShot?.h3Mode ?? 't2va' })">
            <option v-for="m in availableModes" :key="m" :value="m">{{ H3_MODE_LABEL[m] }}</option>
          </select>
        </label>
        <label class="ctl">
          <span class="ctl-label">时长</span>
          <input v-model.number="sShot.durationSeconds" type="number" min="1" max="15" class="dur" title="时长（秒，1–15）" placeholder="5" @change="s.updateShot({ durationSeconds: sShot?.durationSeconds ?? 5 })" />
        </label>
        <label class="ctl">
          <span class="ctl-label">StoryBeat</span>
          <select v-model="sShot.storyBeatId" @change="s.updateShot({ storyBeatId: sShot?.storyBeatId })">
            <option :value="null">— 未关联 —</option>
            <option v-for="b in sDetail?.beats ?? []" :key="b.id" :value="b.id">{{ b.title }}</option>
          </select>
        </label>
        <label class="ctl">
          <span class="ctl-label">主角色</span>
          <select v-model="sShot.primaryCharacterId" @change="s.updateShot({ primaryCharacterId: sShot?.primaryCharacterId })">
            <option :value="null">— 未设定 —</option>
            <option v-for="e in sDetail?.entities.filter((x) => x.kind === 'character') ?? []" :key="e.id" :value="e.id">{{ e.name }}</option>
          </select>
        </label>
        <label class="ctl">
          <span class="ctl-label">场景</span>
          <select v-model="sShot.sceneId" @change="s.updateShot({ sceneId: sShot?.sceneId })">
            <option :value="null">— 未设定 —</option>
            <option v-for="e in sDetail?.entities.filter((x) => x.kind === 'scene') ?? []" :key="e.id" :value="e.id">{{ e.name }}</option>
          </select>
        </label>
      </div>
    </header>

    <section v-if="sDetail?.guide" class="panel shot-guide">
      <GuideStepper :stages="sDetail.guide.state.steps" class="shot-guide-steps" />
      <div class="next-action">
        <div class="next-copy">
          <span class="next-kicker">下一步</span>
          <strong>{{ sDetail.guide.nextAction.title }}</strong>
          <span class="muted">{{ sDetail.guide.nextAction.description }}</span>
        </div>
        <button class="primary" @click="openGuideAction(sDetail.guide.nextAction)">{{ guideActionLabel }}</button>
      </div>
    </section>

    <!-- Three-column core -->
    <div class="core">
      <!-- Assets rail -->
      <aside class="rail">
        <div class="panel">
          <div class="panel-title">资产需求</div>
          <div class="panel-body col">
            <div v-for="r in sDetail?.requirements ?? []" :key="r.kind" class="req-row">
              <span :class="['badge', r.level === 'ok' ? 'ok' : r.level === 'required' ? 'bad' : 'no-dot muted']">
                {{ r.level === 'ok' ? '✓' : r.level === 'required' ? '⚠' : '' }} {{ r.label }}
              </span>
              <div class="muted req-detail">{{ r.detail }}</div>
            </div>
            <router-link to="/assets" class="rail-link">＋ 去资产库导入 / 建状态</router-link>
          </div>
        </div>

        <div class="panel">
          <div class="panel-title spread">
            <span>已绑定参考</span>
            <button class="sm ghost" @click="tab = 'references'">管理 →</button>
          </div>
          <div class="panel-body col">
            <div v-if="!sDetail?.bindings.length" class="muted">未绑定（T2VA 不需要；I2VA/FL2VA 需要首帧）</div>
            <div v-for="b in sDetail?.bindings ?? []" :key="b.id" class="ref-card">
              <div class="ref-thumb">
                <img v-if="thumbOf(b.assetId)" :src="thumbOf(b.assetId)!" :alt="b.label" />
                <span v-else class="mono muted">{{ b.type === 'audio' ? '♪' : '▶' }}</span>
              </div>
              <div class="ref-meta">
                <div class="ref-label" :title="b.label">{{ b.label || b.id }}</div>
                <div class="ref-roles">{{ b.roles.join(' · ') }}</div>
              </div>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-title">连续性</div>
          <div class="panel-body col">
            <div class="row"><span class="status-dot" :style="{ background: sDetail?.continuityLatest?.visualActual?.state ? 'var(--ok)' : 'var(--line-2)' }"></span><span class="muted">Actual（已提交）</span></div>
            <div class="row"><span class="status-dot" :style="{ background: sPlan?.plan.continuity.plannedStartState ? 'var(--info)' : 'var(--line-2)' }"></span><span class="muted">Planned（计划）</span></div>
            <div v-if="sDetail?.continuityLatest?.visualActual?.state" class="muted mono state-box">
              {{ JSON.stringify(sDetail.continuityLatest.visualActual.state, null, 1).slice(0, 500) }}
            </div>
            <button class="sm" @click="tab = 'plan'">编辑计划连续性 →</button>
            <button class="sm" :disabled="!sDetail?.continuityLatest?.visualActual?.state" @click="inheritContinuity">
              继承上一镜头 Actual → Planned
            </button>
          </div>
        </div>
      </aside>

      <!-- Stage -->
      <section class="stage panel">
        <div class="panel-title spread">
          <span>Stage / 导演监视器</span>
          <span v-if="sSelected" class="badge ok no-dot">SELECTED {{ sSelected.id }}</span>
        </div>
        <div class="panel-body">
          <VideoPlayer
            v-if="sSelected"
            :src="takeVideoUrl(sSelected.id)"
            :poster="sSelected.posterPath ? fileUrl(sSelected.posterPath) : undefined"
            :label="`Selected take ${sSelected.id}`"
            :max-height="520"
          />
          <div v-else class="empty-stage">
            <img v-if="firstFrameThumb" :src="firstFrameThumb" class="ff-preview" alt="first frame" />
            <div class="empty-stage-text">
              <template v-if="(sDetail?.takes.length ?? 0) > 0">
                已有 {{ sDetail?.takes.length }} 条 Take，<b>待选片</b>。<br />在下方 Takes 区域选片后，这里播放 Selected Take。
              </template>
              <template v-else>
                舞台待命。<br />
                <span class="muted">导演计划 → Prompt → 预检 → 渲染，第一条 Take 将出现在这里。</span>
              </template>
            </div>
          </div>
          <div v-if="sSelected" class="muted selected-info">
            当前 Selected：<span class="mono">{{ sSelected.id }}</span> · {{ sSelected.duration.toFixed(1) }}s
            <button class="sm ghost" @click="guarded(() => s.rejectTake(sSelected!.id), '已取消选择')">取消选择</button>
          </div>
        </div>
      </section>

      <!-- Inspector -->
      <section class="inspector panel">
        <div class="tabs">
          <button v-for="t in TABS" :key="t.id" :class="['tab', { active: tab === t.id }]" @click="tab = t.id">
            {{ t.cn }}
            <span v-if="t.id === 'plan' && planDirty" class="dirty-dot" title="未保存">●</span>
          </button>
        </div>

        <!-- keep-alive via v-show: unsaved drafts survive tab switches -->
        <div v-show="tab === 'workspace'" class="tab-body workspace-body">
          <WorkspacePanel
            v-if="sDetail?.guide"
            :shot="sShot"
            :plan="sPlan"
            :bindings="sDetail.bindings"
            :requirements="sDetail.requirements"
            :prompt="latestPrompt()"
            :reports="sDetail.preflights"
            :provider="activeProvider"
            :takes="sDetail.takes"
            :selected-take="sSelected"
            :guide="sDetail.guide.state"
            :next-action="sDetail.guide.nextAction"
            :next-action-label="guideActionLabel"
            @open="openWorkspaceTarget"
            @action="openGuideAction"
          />
        </div>

        <div v-show="tab === 'plan'" class="tab-body">
          <PlanEditor
            :plan="sPlan?.plan ?? { ...emptyPlan(), version: 0 }"
            :ai-enabled="aiEnabled"
            :ai-busy="aiBusy"
            :on-ai-suggest="aiSuggest"
            @save="(p: DirectorPlan) => guarded(() => s.savePlan(p), 'DirectorPlan 已保存为新版本')"
            @paste="tab = 'external'"
            @dirty-change="(d: boolean) => (planDirty = d)"
          />
        </div>

        <div v-show="tab === 'references'" class="tab-body">
          <ReferencesPanel
            :bindings="sDetail?.bindings ?? []"
            :media="media"
            :on-add="(input) => guarded(() => s.addBinding(input), '已绑定参考')"
            :on-update="s.updateBinding"
            :on-remove="(id: string) => guarded(() => s.removeBinding(id), '已移除绑定')"
          />
        </div>

        <div v-show="tab === 'prompt'" class="tab-body">
          <PromptPanel
            :prompts="sDetail?.prompts ?? []"
            :current-mode="sShot.h3Mode"
            :available-modes="availableModes"
            :ai-enabled="aiEnabled"
            :on-compile="(m: string) => guarded(() => s.compilePrompt(m), 'Prompt 已编译为新版本')"
            :on-raw="(t: string, m: string) => guarded(() => s.importRawPrompt(t, m), 'Raw Prompt 已导入')"
            :on-ai-compile="aiCompile"
          />
        </div>

        <div v-show="tab === 'preflight'" class="tab-body">
          <PreflightPanel
            :reports="sDetail?.preflights ?? []"
            :prompt="latestPrompt()"
            :provider="activeProvider"
            :duration-seconds="sShot.durationSeconds"
            :aspect-ratio="sShot.aspectRatio"
            :ai-enabled="aiEnabled"
            :on-basic="(pid: string) => guarded(() => s.runPreflight(pid), 'Basic Preflight 完成') as never"
            :on-ai-check="aiPreflight"
            :on-render="doRender"
          />
          <div v-if="aiResults.continuity" class="panel ai-note">
            <div class="panel-title">AI Continuity Check</div>
            <pre class="ai-text">{{ aiText(aiResults.continuity) }}</pre>
          </div>
        </div>

        <div v-show="tab === 'external'" class="tab-body">
          <div class="col">
            <label class="field">
              任务模板
              <select v-model="externalTask">
                <option v-for="t in EXTERNAL_TASKS" :key="t.id" :value="t.id">{{ t.id }}</option>
              </select>
            </label>
            <p class="muted">Copy Context Package = 只复制上下文，不调用任何 API。把内容丢给 ChatGPT / Claude 等外部 AI。</p>
            <div>
              <button class="primary sm" @click="copyContextPackage">Copy Context Package</button>
            </div>

            <div class="sep" />
            <label class="field">
              粘贴外部 AI 返回的 DirectorPlan（YAML / JSON）
              <textarea v-model="pasteText" rows="8" placeholder="intent:&#10;  shot_function: wide&#10;  visual_thesis: …"></textarea>
            </label>
            <div class="row">
              <button class="sm" @click="parsePaste">解析预览</button>
              <button v-if="parseResult?.ok" class="primary sm" @click="applyParsed">应用为新版本</button>
            </div>
            <div v-if="parseResult && !parseResult.ok" class="badge bad">解析失败：{{ parseResult.error }} — 可手工搬字段</div>
            <div v-if="parseResult?.ok" class="muted">解析成功，应用后作为新 DirectorPlan 版本保存。</div>
          </div>
        </div>
      </section>
    </div>

    <!-- Takes -->
    <section id="takes" ref="takesSection" class="takes-section filmstrip">
      <div class="spread takes-head">
        <h2>Takes <span class="muted">{{ sDetail?.takes.length ?? 0 }} 条</span></h2>
        <span class="muted">Shot 是意图，Take 是生成结果</span>
      </div>
      <TakesPanel
        :takes="sDetail?.takes ?? []"
        :selected-take-id="sSelected?.id ?? null"
        :ai-enabled="aiEnabled"
        :actual-state="sDetail?.continuityLatest?.visualActual?.state ?? null"
        :entities="sDetail?.entities ?? []"
        :character-states="sDetail?.characterStates ?? []"
        :on-select="s.selectTake"
        :on-reject="s.rejectTake"
        :on-update="s.updateTake"
        :on-ai-diagnose="aiDiagnose"
        :on-select-commit="(tid: string, st: import('@h3mise/shared').VisualContinuityState) => s.selectAndCommit(tid, st)"
        :on-use-last-frame="(tid: string) => useTakeFrame(tid, 'last')"
        :on-use-first-frame="(tid: string) => useTakeFrame(tid, 'first')"
      />
      <div v-for="(v, k) in aiResults" :key="k" v-show="k.startsWith('diag:')" class="panel ai-note">
        <div class="panel-title">AI 诊断 — {{ k }}</div>
        <pre class="ai-text">{{ aiText(v) }}</pre>
      </div>
    </section>
  </div>
</template>

<style scoped>
.desk { padding: 18px 28px 40px; max-width: 1720px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.crumbs { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
.crumb-link { color: var(--text-2); }
.crumb-link:hover { color: var(--accent-text); text-decoration: none; }
.desk-header { display: flex; flex-direction: column; gap: 10px; }
.desk-header h1 { font-size: 22px; margin: 0; font-family: var(--serif); letter-spacing: 0.01em; }
.shot-guide { padding: 16px 20px; display: grid; grid-template-columns: minmax(420px, 0.9fr) minmax(360px, 1.1fr); gap: 28px; align-items: center; border-color: var(--accent-line); }
.shot-guide-steps { --guide-count: 4; }
.next-action { min-width: 0; padding-left: 24px; border-left: 1px solid var(--line); display: flex; align-items: center; justify-content: space-between; gap: 18px; }
.next-copy { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.next-copy strong { font-size: 14px; }
.next-kicker { color: var(--accent-text); font-size: 10.5px; font-weight: 800; letter-spacing: 0.12em; }
.next-action button { flex: none; }
.wrap { flex-wrap: wrap; }
.controls { flex-wrap: wrap; gap: 10px; }
.ctl { display: flex; align-items: center; gap: 6px; }
.ctl-label { font-size: 11.5px; color: var(--text-3); white-space: nowrap; }
.ctl select, .ctl input { max-width: 150px; }
.dur { width: 60px; }
.core { display: grid; grid-template-columns: 264px 1fr 460px; gap: 14px; align-items: start; }
.rail { position: sticky; top: 124px; display: flex; flex-direction: column; gap: 12px; }
.stage, .inspector { min-width: 0; }
.req-row { display: flex; flex-direction: column; gap: 2px; }
.req-detail { padding-left: 4px; }
.rail-link { font-size: 12px; }
.ref-card { display: flex; gap: 8px; align-items: center; }
.ref-thumb { width: 56px; height: 38px; flex: none; border-radius: 5px; overflow: hidden; background: var(--inset); display: flex; align-items: center; justify-content: center; }
.ref-thumb img { width: 100%; height: 100%; object-fit: cover; }
.ref-meta { min-width: 0; }
.ref-label { font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ref-roles { font-size: 10.5px; color: var(--text-3); }
.stage .empty-stage { min-height: 300px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; color: var(--text-2); text-align: center; }
.ff-preview { max-height: 260px; max-width: 80%; border-radius: var(--radius-sm); box-shadow: var(--shadow-2); opacity: 0.85; }
.empty-stage-text { line-height: 1.7; }
.selected-info { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.tabs { display: flex; border-bottom: 1px solid var(--line); padding: 0 6px; }
.tab { border: none; background: transparent; border-radius: 0; border-bottom: 2px solid transparent; color: var(--text-2); padding: 11px 10px; box-shadow: none; white-space: nowrap; }
.tab:hover { color: var(--text); }
.tab.active { color: var(--accent-text); border-bottom-color: var(--accent); font-weight: 600; }
.dirty-dot { color: var(--warn); font-size: 9px; margin-left: 3px; }
.tab-body { padding: 14px; max-height: calc(100vh - 230px); overflow: auto; }
.workspace-body { padding: 12px; }
.takes-section { border-top: 1px solid var(--line); margin-top: 4px; }
.takes-head { padding: 4px 2px 10px; }
.takes-head h2 { margin: 0; font-size: 16px; font-family: var(--serif); }
.sep { border-top: 1px dashed var(--line); margin: 8px 0; }
.state-box { font-size: 11px; white-space: pre-wrap; background: var(--inset); border-radius: 4px; padding: 6px; max-height: 180px; overflow: auto; }
.ai-note { margin-top: 10px; }
.ai-text { font-family: var(--mono); font-size: 12px; white-space: pre-wrap; padding: 10px; margin: 0; color: var(--text-2); }
</style>
