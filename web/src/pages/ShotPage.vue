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
import type { DirectorPlan, MediaAsset, NextAction, ReferenceBinding } from '@h3mise/shared';
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

type VisionStatus = { mode: 'multimodal' | 'text_fallback' | 'text_only'; imageCount: number };
function showVisionStatus(result: unknown) {
  const vision = (result as { vision?: VisionStatus } | null)?.vision;
  if (!vision) return;
  if (vision.mode === 'multimodal') {
    toasts.push({ kind: 'ok', text: `图片请求成功：AI 已接收 ${vision.imageCount} 张参考图` });
  } else if (vision.mode === 'text_fallback') {
    toasts.push({ kind: 'info', text: `识图请求失败，已自动降级为纯文字（原计划发送 ${vision.imageCount} 张图）`, timeout: 8000 });
  } else {
    toasts.push({ kind: 'info', text: '本次 AI 请求未附带可读取的镜头参考图，使用纯文字处理', timeout: 8000 });
  }
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
// Keep the unsaved first-plan object stable across parent re-renders. Passing
// a freshly-created fallback from the template resets the editor on every
// dirty-state emission and makes typed text appear to vanish.
const editorPlan = computed(() => sPlan.value?.plan ?? emptyPlan());

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
    const status = await get<{ configured?: boolean }>('/api/ai/status');
    aiEnabled.value = Boolean(status.configured);
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

const missingFrameRole = computed<'first_frame' | 'last_frame' | null>(() => {
  const mode = sShot.value?.h3Mode ?? 't2va';
  const roles = new Set(sDetail.value?.bindings.flatMap((binding) => binding.roles) ?? []);
  if ((mode === 'i2va' || mode === 'fl2va') && !roles.has('first_frame')) return 'first_frame';
  if ((mode === 'l2va' || mode === 'fl2va') && !roles.has('last_frame')) return 'last_frame';
  return null;
});
const assetUploadRoute = computed(() => ({
  path: '/assets',
  query: {
    tab: 'media',
    returnTo: `/shots/${shotId}?guide=references`,
    shotId,
    mode: sShot.value?.h3Mode ?? 't2va',
    ...(missingFrameRole.value ? { role: missingFrameRole.value } : {}),
  },
}));
const assetUploadPath = computed(() => router.resolve(assetUploadRoute.value).fullPath);
const primaryEntity = computed(() => sDetail.value?.entities.find((entity) => entity.id === sShot.value?.primaryCharacterId) ?? null);
const primaryState = computed(() => {
  const characterId = primaryEntity.value?.id;
  if (!characterId) return null;
  const state = sDetail.value?.continuityLatest?.visualPlanned?.state ?? sDetail.value?.continuityLatest?.visualActual?.state;
  const stateId = state?.characterStates[characterId];
  return sDetail.value?.characterStates.find((item) => item.id === stateId) ?? null;
});
const primaryVisualImage = computed(() => {
  const assetId = primaryState.value?.effectiveImageAssetId ?? primaryEntity.value?.imageAssetId;
  return media.value.find((asset) => asset.id === assetId && asset.kind === 'image') ?? null;
});
const primaryVisualLabel = computed(() => primaryState.value?.imageAssetId ? `${primaryState.value.name}状态图` : `${primaryEntity.value?.name ?? '实体'}主图`);
const hasRefImageBinding = computed(() => sDetail.value?.bindings.some((binding) => binding.type === 'image' && !binding.roles.includes('first_frame') && !binding.roles.includes('last_frame')) ?? false);
const canUsePrimaryAsRefImage = computed(() => sShot.value?.h3Mode === 'ref2va' && Boolean(primaryVisualImage.value) && !hasRefImageBinding.value);

async function usePrimaryVisualAsRefImage() {
  const asset = primaryVisualImage.value;
  if (!asset || !canUsePrimaryAsRefImage.value) return;
  await guarded(() => s.addBinding({ assetId: asset.id, roles: [], label: primaryVisualLabel.value }), '已绑定角色图为 RefImage');
}

async function correctToRef2va() {
  const asset = primaryVisualImage.value;
  const needsBinding = !hasRefImageBinding.value && Boolean(asset);
  await guarded(async () => {
    await s.updateShot({ h3Mode: 'ref2va' });
    if (needsBinding && asset) await s.addBinding({ assetId: asset.id, roles: [], label: primaryVisualLabel.value });
  }, needsBinding ? '已切换 Ref2VA，并绑定角色图为 RefImage' : '已切换为 Ref2VA 参考图模式');
}

/** PRD §15: UI only opens modes the current provider profile actually supports.
 * Unknown capability = nothing offered (P1), never a theoretical fallback. */
const availableModes = computed(() => {
  const caps = activeProvider.value?.capabilities;
  return caps?.supportedModes ?? [];
});
const canCorrectReferenceMode = computed(() =>
  sShot.value?.h3Mode === 'i2va'
  && missingFrameRole.value === 'first_frame'
  && availableModes.value.includes('ref2va')
  && (Boolean(primaryVisualImage.value) || hasRefImageBinding.value),
);

const userStatus = computed(() => (sShot.value ? SHOT_USER_STATUS[sShot.value.status] : 'draft'));
const referenceModeHint = computed(() => ({
  t2va: '当前为 T2VA，无需参考素材',
  i2va: '当前为 I2VA，需要首帧图',
  l2va: '当前为 L2VA，需要尾帧图',
  fl2va: '当前为 FL2VA，需要首帧图和尾帧图',
  ref2va: '当前为 Ref2VA，需要参考图；参考音频可选',
})[sShot.value?.h3Mode ?? 't2va']);

const guideActionLabel = computed(() => {
  const kind = sDetail.value?.guide.nextAction.kind;
  if (kind === 'design_shot') return '编辑镜头设计';
  if (kind === 'add_reference') return '添加参考素材';
  if (kind === 'review_prompt') return '准备提示词';
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
  { id: 'Plan Shot', label: '生成完整镜头设计' },
  { id: 'Improve Camera', label: '优化摄影机设计' },
  { id: 'Improve Performance', label: '优化表演设计' },
];

const DIRECTOR_PLAN_EXAMPLE = `intent:
  visualThesis: "空荡的放映室里，MISE 在应急灯下显得孤独而渺小"
  endState: "停在 MISE 抬头望向墙上时钟的中近景"
subject:
  action: "MISE 低着头静止片刻，然后缓慢抬头"
camera:
  dominantBehavior: "中景固定机位，缓慢推近 MISE"`;

const EXTERNAL_TASK_INSTRUCTION: Record<string, string> = {
  'Plan Shot': '为当前 Shot 生成清晰、可执行的镜头设计。',
  'Improve Camera': '保留现有镜头意图和主体动作，重点优化摄影机设计。',
  'Improve Performance': '保留现有镜头意图和摄影机设计，重点优化主体动作与表演。',
};

const parsedMissingFields = computed(() => {
  const plan = parseResult.value?.plan;
  if (!plan) return [];
  return [
    ['镜头目标', plan.intent.visualThesis],
    ['主体动作', plan.subject.action],
    ['摄影机', plan.camera.dominantBehavior],
    ['结束画面', plan.intent.endState],
  ].filter(([, value]) => !String(value ?? '').trim()).map(([label]) => label);
});

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
  let longRunningReminderShown = false;
  try {
    for (let i = 0; i < 180; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      waited += 1.5;
      const job = await get<{ status: string; result: unknown; error: string | null }>(`/api/jobs/${res.jobId}`);
      if (job.status === 'done') {
        showVisionStatus(job.result);
        return job.result;
      }
      if (job.status === 'failed') throw new Error(job.error ?? 'AI job failed');
      // The old 30 <= waited < 32 window matched both the 30s and 31.5s
      // polls, producing two consecutive "still processing" toasts.
      if (!longRunningReminderShown && waited >= 30) {
        longRunningReminderShown = true;
        toasts.push({ kind: 'info', text: 'AI 仍在处理，请稍候…（超过 3 分钟会提示超时）' });
      }
    }
    throw new Error('AI job timeout');
  } finally {
    delete aiJobs.value[key];
  }
}

const aiBusy = computed(() => Object.keys(aiJobs.value).length > 0);

async function deleteThisShot() {
  const ok = await confirmDialog({
    title: `删除 Shot「${sShot.value?.title || shotId}」？`,
    message: '将同时删除其导演计划、提示词版本、成片、生成任务和时间线片段，不可恢复。',
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

async function aiSuggest(currentPlan: DirectorPlan) {
  const body: Record<string, unknown> = { shotId, plan: currentPlan };
  await guarded(async () => {
    const result = await runAi('plan_shot', body);
    const plan = (result as { plan?: DirectorPlan })?.plan;
    if (plan) {
      await s.savePlan(plan, 'builtin_ai');
      toasts.push({ kind: 'ok', text: 'AI 建议已保存为新的导演计划版本，可继续手工调整' });
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
      await s.importRawPrompt(text, sShot.value?.h3Mode ?? 't2va', 'ai_compiler');
      toasts.push({ kind: 'ok', text: 'AI 优化后的提示词已保存为新版本' });
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

async function aiPreflight(promptId: string) {
  const prompt = latestPrompt();
  if (!prompt) return null;
  let report: Awaited<ReturnType<typeof s.runPreflight>> | null = null;
  await guarded(async () => {
    report = sDetail.value?.preflights.find((item) => item.promptVersionId === promptId) ?? null;
    if (!report) report = await s.runPreflight(prompt.id);
    const result = await runAi('continuity_check', { shotId });
    report = await s.attachSemanticReview(report.id, aiText(result));
    toasts.push({ kind: 'ok', text: 'AI 连续性检查已加入当前生成检查记录' });
  });
  return report;
}

async function doRender(promptId: string) {
  await guarded(async () => {
    const mode = sShot.value?.h3Mode ?? 't2va';
    const submittedBindings = (sDetail.value?.bindings ?? []).filter((binding: ReferenceBinding) => {
      const first = binding.roles.includes('first_frame');
      const last = binding.roles.includes('last_frame');
      if (mode === 'ref2va') return !first && !last;
      if (mode === 'i2va') return first;
      if (mode === 'l2va') return last;
      if (mode === 'fl2va') return first || last;
      return false;
    });
    const referenceSummary = submittedBindings.length
      ? `\n实际提交的参考素材：${submittedBindings.map((binding) => binding.label || binding.id).join('、')}`
      : '\n当前模式不提交参考素材。';
    const confirmed = await confirmDialog({
      title: '确认生成 1 个新 Take？',
      message: `${activeProvider.value?.name ?? '当前生成服务'} · ${H3_MODE_LABEL[mode]} · ${sShot.value?.durationSeconds ?? 5}s · ${sShot.value?.aspectRatio ?? '16:9'}。${referenceSummary}\n提交后将创建一次生成任务。`,
      confirmLabel: '确认生成',
    });
    if (!confirmed) return;
    const job = await s.render(promptId, providerId.value, sShot.value?.durationSeconds);
    toasts.push({ kind: 'ok', text: `渲染任务 ${job.id} 已提交 — 状态实时推送` });
  });
}

async function refreshPromptReferences() {
  await guarded(async () => {
    const prompt = await s.compilePrompt(sShot.value?.h3Mode ?? 't2va');
    await s.runPreflight(prompt.id);
    toasts.push({ kind: 'ok', text: '提示词已纳入最新参考素材，生成检查已通过' });
  });
}

function openWorkspaceTarget(target: 'plan' | 'references' | 'prompt' | 'preflight' | 'takes') {
  if (target === 'takes') {
    takesSection.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  tab.value = target;
}

async function contextPackage(): Promise<Record<string, unknown>> {
  return s.contextPackage(externalTask.value);
}

async function copyExternalAiPrompt() {
  await guarded(async () => {
    const pkg = await contextPackage();
    const prompt = `你是 H3Mise 的镜头导演助手。

任务：${EXTERNAL_TASK_INSTRUCTION[externalTask.value] ?? EXTERNAL_TASK_INSTRUCTION['Plan Shot']}

请根据下面的 Context Package 返回一个 DirectorPlan。

输出要求：
1. 只返回 YAML 或 JSON，不要解释，不要使用 Markdown 代码围栏。
2. 必须包含这 4 个字段：intent.visualThesis、subject.action、camera.dominantBehavior、intent.endState。
3. 可以补充其他 DirectorPlan 字段，但不确定的内容请省略，不要编造事实。
4. 最简有效格式如下：

${DIRECTOR_PLAN_EXAMPLE}

Context Package：
${JSON.stringify(pkg, null, 2)}`;
    await navigator.clipboard.writeText(prompt);
    toasts.push({ kind: 'ok', text: '完整提示词已复制，可直接粘贴给任意外部 AI' });
  });
}

async function copyContextPackageOnly() {
  await guarded(async () => {
    await navigator.clipboard.writeText(JSON.stringify(await contextPackage(), null, 2));
    toasts.push({ kind: 'ok', text: '仅 Context Package 已复制' });
  });
}

function insertDirectorPlanExample() {
  pasteText.value = DIRECTOR_PLAN_EXAMPLE;
  parseResult.value = null;
}

async function parsePaste() {
  parseResult.value = await post(`/api/shots/${shotId}/plans/parse`, { text: pasteText.value });
}

async function applyParsed() {
  if (parseResult.value?.plan && parsedMissingFields.value.length === 0) {
    await s.savePlan(parseResult.value.plan, 'external_ai');
    toasts.push({ kind: 'ok', text: '外部 AI 的导演计划已应用为新版本' });
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
  // Frame Bridge semantics: a take's LAST frame is the NEXT shot's first
  // frame (continuity chaining); its FIRST frame references this shot.
  let bindShotId = shotId;
  let where = '本镜头';
  if (which === 'last') {
    const shots = await get<Array<{ id: string; sequenceId: string | null; order: number; title: string }>>('/api/shots');
    const cur = shots.find((x) => x.id === shotId);
    if (!cur) {
      toasts.push({ kind: 'err', text: '找不到当前镜头' });
      return;
    }
    const next = shots
      .filter((x) => x.sequenceId === cur.sequenceId && x.order > cur.order)
      .sort((a, b) => a.order - b.order)[0];
    if (!next) {
      toasts.push({ kind: 'err', text: '当前序列没有下一镜头，无法做尾帧桥接' });
      return;
    }
    bindShotId = next.id;
    where = `下一镜「${next.title || next.id}」`;
  }
  await post('/api/assets/bindings', {
    assetId: target.id,
    roles: ['first_frame'],
    label: `Frame bridge from ${takeId} (${which === 'last' ? 'last' : 'first'} frame)`,
    shotId: bindShotId,
  });
  toasts.push({ kind: 'ok', text: `已把 Take ${takeId} 的${which === 'last' ? '尾' : '首'}帧绑定为${where}的 First Frame` });
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
    message: '导演计划有未保存的编辑。离开此页面将丢弃这些修改（不会生成新版本）。',
    confirmLabel: '放弃修改',
    danger: true,
  });
});

let off: (() => void) | null = null;
let shotRefresh: Promise<void> | null = null;

const ACTIVE_RENDER_STATUSES = new Set(['UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING']);

/**
 * A preflight report is an immutable audit record. If its only error says an
 * older render was active, repair the UI gate after that job reaches a
 * terminal state by creating a fresh report. Other failures stay blocked.
 */
function refreshShotAndRepairExpiredDuplicateGate(): Promise<void> {
  if (shotRefresh) return shotRefresh;
  shotRefresh = (async () => {
    await s.load();
    const detail = sDetail.value;
    const prompt = detail?.prompts.at(-1);
    const matchingReport = prompt
      ? detail?.preflights.find((item) => item.promptVersionId === prompt.id)
      : null;
    const report = matchingReport ?? detail?.preflights[0] ?? null;
    const hasActiveJob = detail?.jobs.some((job) => ACTIVE_RENDER_STATUSES.has(job.status)) ?? false;
    const errors = report?.basic.flatMap((section) => section.checks).filter((check) => check.severity === 'error') ?? [];
    if (prompt && report?.blocked && !hasActiveJob && errors.length > 0 && errors.every((check) => check.key === 'duplicate.active')) {
      await s.runPreflight(prompt.id);
    }
  })().finally(() => {
    shotRefresh = null;
  });
  return shotRefresh;
}

onMounted(async () => {
  await refreshShotAndRepairExpiredDuplicateGate();
  applyGuideQuery();
  await loadMedia();
  await project.refreshProviders();
  await refreshAiStatus();
  window.addEventListener('beforeunload', beforeUnload);
  off = subscribeEvents((e) => {
    const renderEvent = e.type.startsWith('render.job.') && 'shotId' in e && e.shotId === shotId;
    if (e.type === 'take.created' || e.type === 'shot.updated' || renderEvent) void refreshShotAndRepairExpiredDuplicateGate();
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
  { id: 'prompt', cn: '提示词', en: 'Prompt' },
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
        <label class="ctl mode-ctl">
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

    <section v-if="sDetail?.guide" :class="['panel', 'shot-guide', { 'guide-workspace': tab === 'workspace' }]">
      <GuideStepper :stages="sDetail.guide.state.steps" class="shot-guide-steps" />
      <div v-if="tab !== 'workspace'" class="next-action">
        <div class="next-copy">
          <span class="next-kicker">下一步</span>
          <strong>{{ sDetail.guide.nextAction.title }}</strong>
          <span class="muted">{{ sDetail.guide.nextAction.description }}</span>
        </div>
        <button class="primary" @click="openGuideAction(sDetail.guide.nextAction)">{{ guideActionLabel }}</button>
      </div>
    </section>

    <!-- Three-column core -->
    <div :class="['core', { 'workspace-mode': tab === 'workspace' }]">
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
            <button v-if="canCorrectReferenceMode" class="sm primary" @click="correctToRef2va">
              这是参考图：切换 Ref2VA{{ hasRefImageBinding ? '' : '并绑定' }}
            </button>
            <button v-if="canUsePrimaryAsRefImage" class="sm" @click="usePrimaryVisualAsRefImage">
              使用「{{ primaryVisualLabel }}」作为 RefImage
            </button>
            <router-link :to="assetUploadRoute" class="rail-link">
              {{ missingFrameRole ? `＋ 上传并绑定${missingFrameRole === 'first_frame' ? '首帧' : '尾帧'}` : '＋ 上传图片 / 参考音频' }}
            </router-link>
          </div>
        </div>

        <div class="panel">
          <div class="panel-title spread">
            <span>已绑定参考</span>
            <button class="sm ghost" @click="tab = 'references'">管理 →</button>
          </div>
          <div class="panel-body col">
            <div v-if="!sDetail?.bindings.length" class="muted">{{ referenceModeHint }}</div>
            <div v-for="b in sDetail?.bindings ?? []" :key="b.id" class="ref-card">
              <div class="ref-thumb">
                <img v-if="thumbOf(b.assetId)" :src="thumbOf(b.assetId)!" :alt="b.label" />
                <span v-else class="mono muted">{{ b.type === 'audio' ? '♪' : '▶' }}</span>
              </div>
              <div class="ref-meta">
                <div class="ref-label" :title="b.label">{{ b.label || b.id }}</div>
                <div class="ref-roles">{{ b.roles.join(' · ') || (b.type === 'audio' ? 'RefAudio' : 'RefImage') }}</div>
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
      <section v-show="tab !== 'workspace'" class="stage panel">
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
                <span class="muted">导演计划 → 提示词 → 生成检查 → 渲染，第一条成片将出现在这里。</span>
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
            :plan="editorPlan"
            :ai-enabled="aiEnabled"
            :ai-busy="aiBusy"
            :on-ai-suggest="aiSuggest"
            @save="(p: DirectorPlan) => guarded(() => s.savePlan(p), '导演计划已保存为新版本')"
            @paste="tab = 'external'"
            @dirty-change="(d: boolean) => (planDirty = d)"
          />
        </div>

        <div v-show="tab === 'references'" class="tab-body">
          <ReferencesPanel
            :bindings="sDetail?.bindings ?? []"
            :media="media"
            :current-mode="sShot.h3Mode ?? 't2va'"
            :upload-path="assetUploadPath"
            :on-add="(input) => guarded(() => s.addBinding(input), '已绑定参考')"
            :on-update="s.updateBinding"
            :on-remove="(id: string) => guarded(() => s.removeBinding(id), '已移除绑定')"
          />
        </div>

        <div v-show="tab === 'prompt'" class="tab-body">
          <PromptPanel
            :prompts="sDetail?.prompts ?? []"
            :current-mode="sShot.h3Mode"
            :ai-enabled="aiEnabled"
            :on-compile="(m: string) => guarded(() => s.compilePrompt(m), '提示词已编译为新版本')"
            :on-raw="(t: string, m: string) => guarded(() => s.importRawPrompt(t, m), '提示词已保存为新版本')"
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
            :on-basic="(pid: string) => guarded(() => s.runPreflight(pid), '生成检查完成') as never"
            :on-ai-check="aiPreflight"
            :on-refresh-prompt="refreshPromptReferences"
            :on-render="doRender"
          />
        </div>

        <div v-show="tab === 'external'" class="tab-body">
          <div class="external-flow">
            <header class="external-intro">
              <strong>用任意外部 AI 完成镜头设计</strong>
              <span>适用于 ChatGPT、Claude 等。H3Mise 只负责复制和解析，不会自动调用外部服务。</span>
            </header>

            <section class="external-step">
              <span class="step-number">1</span>
              <div class="step-content">
                <label class="field">
                  <span><strong>选择要 AI 做什么</strong></span>
                  <select v-model="externalTask">
                    <option v-for="t in EXTERNAL_TASKS" :key="t.id" :value="t.id">{{ t.label }}</option>
                  </select>
                </label>
              </div>
            </section>

            <section class="external-step">
              <span class="step-number">2</span>
              <div class="step-content">
                <strong>复制提示词，粘贴给外部 AI</strong>
                <p class="muted">提示词已包含当前故事、镜头、参考素材、四项必填要求和返回格式。</p>
                <div class="row">
                  <button class="primary sm" @click="copyExternalAiPrompt">复制给 AI 的完整提示词</button>
                  <button class="sm ghost" @click="copyContextPackageOnly">仅复制数据包</button>
                </div>
              </div>
            </section>

            <section class="external-step">
              <span class="step-number">3</span>
              <div class="step-content">
                <div class="spread">
                  <strong>把 AI 返回的内容整段贴回来</strong>
                  <button class="sm ghost" @click="insertDirectorPlanExample">填入示例</button>
                </div>
                <p class="muted">支持 YAML 或 JSON、camelCase 或 snake_case，也兼容 AI 常见的 Markdown 代码围栏。</p>
                <details class="format-example">
                  <summary>查看最简有效格式</summary>
                  <pre>{{ DIRECTOR_PLAN_EXAMPLE }}</pre>
                </details>
                <label class="field paste-field">
                  <span class="sr-only">外部 AI 返回的 DirectorPlan</span>
                  <textarea v-model="pasteText" rows="9" :placeholder="DIRECTOR_PLAN_EXAMPLE"></textarea>
                </label>
                <div class="row">
                  <button class="sm" :disabled="!pasteText.trim()" @click="parsePaste">检查格式</button>
                  <button v-if="parseResult?.ok && parsedMissingFields.length === 0" class="primary sm" @click="applyParsed">应用为新版本</button>
                </div>
                <div v-if="parseResult && !parseResult.ok" class="parse-message bad">格式无法识别：{{ parseResult.error }}</div>
                <div v-else-if="parseResult?.ok && parsedMissingFields.length" class="parse-message warn">格式可识别，但还缺：{{ parsedMissingFields.join('、') }}</div>
                <div v-else-if="parseResult?.ok" class="parse-message ok">格式正确，四项必填内容完整，可以应用。</div>
              </div>
            </section>
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
        :on-delete="s.deleteTake"
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
.mode-ctl select { width: 210px; max-width: 210px; }
.dur { width: 60px; }
.core { display: grid; grid-template-columns: 264px 1fr 460px; gap: 14px; align-items: start; }
.core.workspace-mode { grid-template-columns: 264px minmax(0, 1fr); }
.core.workspace-mode .inspector { grid-column: 2; }
.core.workspace-mode .tab-body { max-height: none; overflow: visible; }
.guide-workspace { grid-template-columns: 1fr; }
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
.external-flow { display: grid; gap: 10px; }
.external-intro { display: flex; flex-direction: column; gap: 3px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
.external-intro strong { font-size: 15px; }
.external-intro span { color: var(--text-2); font-size: 11.5px; line-height: 1.5; }
.external-step { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 10px; padding: 11px 0; border-bottom: 1px solid var(--line); }
.external-step:last-child { border-bottom: 0; }
.step-number { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-text); font-size: 12px; font-weight: 800; }
.step-content { min-width: 0; display: grid; gap: 8px; }
.step-content p { margin: 0; line-height: 1.5; }
.format-example { border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg-subtle); overflow: hidden; }
.format-example summary { padding: 8px 10px; cursor: pointer; color: var(--text-2); font-size: 11.5px; }
.format-example pre { margin: 0; padding: 10px; border-top: 1px solid var(--line); overflow: auto; color: var(--text-2); font: 11px/1.5 var(--mono); white-space: pre-wrap; }
.paste-field { margin: 0; }
.paste-field textarea { width: 100%; min-height: 190px; font-family: var(--mono); font-size: 11.5px; line-height: 1.5; }
.parse-message { padding: 8px 10px; border-radius: var(--radius-sm); font-size: 11.5px; }
.parse-message.bad { background: var(--bad-soft); color: var(--bad); }
.parse-message.warn { background: var(--warn-soft); color: var(--warn); }
.parse-message.ok { background: var(--ok-soft); color: var(--ok); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.takes-section { border-top: 1px solid var(--line); margin-top: 4px; }
.takes-head { padding: 4px 2px 10px; }
.takes-head h2 { margin: 0; font-size: 16px; font-family: var(--serif); }
.sep { border-top: 1px dashed var(--line); margin: 8px 0; }
.state-box { font-size: 11px; white-space: pre-wrap; background: var(--inset); border-radius: 4px; padding: 6px; max-height: 180px; overflow: auto; }
.ai-note { margin-top: 10px; }
.ai-text { font-family: var(--mono); font-size: 12px; white-space: pre-wrap; padding: 10px; margin: 0; color: var(--text-2); }
</style>
