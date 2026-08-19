<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useShot } from '../composables/useShot';
import { useProjectStore } from '../stores/project';
import { get, post, takeVideoUrl, subscribeEvents } from '../api/client';
import { H3_MODE_LABEL, H3_MODES, SHOT_STATUS_LABEL, emptyDirectorPlan } from '@h3mise/shared';
import type { DirectorPlan, MediaAsset } from '@h3mise/shared';
import PlanEditor from '../components/director/PlanEditor.vue';
import PromptPanel from '../components/director/PromptPanel.vue';
import PreflightPanel from '../components/director/PreflightPanel.vue';
import TakesPanel from '../components/director/TakesPanel.vue';
import ReferencesPanel from '../components/director/ReferencesPanel.vue';
import VideoPlayer from '../components/VideoPlayer.vue';

const route = useRoute();
const shotId = route.params.id as string;
const project = useProjectStore();
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

const tab = ref<'plan' | 'references' | 'prompt' | 'preflight' | 'external'>('plan');
const media = ref<MediaAsset[]>([]);
const aiJobs = ref<Record<string, string>>({}); // actionKey -> jobId
const aiResults = ref<Record<string, unknown>>({});
const aiError = ref('');
const externalTask = ref('Plan Shot');
const externalPkg = ref<Record<string, unknown> | null>(null);
const pasteText = ref('');
const parseResult = ref<{ ok: boolean; plan?: DirectorPlan; error?: string } | null>(null);
const notice = ref('');

const aiEnabled = computed(() => project.providers.some((p) => p.configured));

/** Active render provider: prefer the real RunningHub when configured, else
 * whatever the server exposes (e.g. mock in offline mode). */
const activeProvider = computed(() => {
  const rh = project.providers.find((p) => p.id === 'runninghub' && p.configured);
  return rh ?? project.providers[0] ?? null;
});
const providerId = computed(() => activeProvider.value?.id ?? 'runninghub');

/** PRD §15: UI only opens modes the current provider profile actually supports. */
const availableModes = computed(() => {
  const caps = activeProvider.value?.capabilities;
  if (caps?.supportedModes?.length) return caps.supportedModes;
  return H3_MODES;
});

const STATUS_BADGE: Record<string, string> = {
  DRAFT: '', PLANNED: 'info', ASSETS_READY: 'info', DIRECTED: 'info', PREFLIGHT_READY: 'accent',
  RENDERING: 'warn', HAS_TAKES: '', SELECTED: 'ok', CONTINUITY_COMMITTED: 'ok', LOCKED: 'accent',
};

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

function statusOf(shot: { status: string }): string {
  return SHOT_STATUS_LABEL[shot.status as keyof typeof SHOT_STATUS_LABEL] ?? shot.status;
}

async function loadMedia() {
  media.value = await get<MediaAsset[]>('/api/assets/media');
}

/** Run an AI action as a background job; poll until done; return result. */
async function runAi(action: string, body: Record<string, unknown>): Promise<unknown> {
  aiError.value = '';
  const key = `${action}:${JSON.stringify(body).slice(0, 40)}`;
  const res = await post<{ jobId: string; status: string }>(`/api/ai/actions/${action}`, body);
  aiJobs.value[key] = res.jobId;
  for (let i = 0; i < 180; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const job = await get<{ status: string; result: unknown; error: string | null }>(`/api/jobs/${res.jobId}`);
    if (job.status === 'done') {
      delete aiJobs.value[key];
      return job.result;
    }
    if (job.status === 'failed') {
      delete aiJobs.value[key];
      throw new Error(job.error ?? 'AI job failed');
    }
  }
  throw new Error('AI job timeout');
}

async function aiSuggest(section: string) {
  const body: Record<string, unknown> = { shotId };
  const action = section === 'full' ? 'plan_shot' : section === 'camera' ? 'improve_camera' : section === 'performance' ? 'improve_performance' : 'plan_shot';
  if (section === 'reality') {
    aiResults.value.reality = await runAi('reality_check', body);
    notice.value = 'Reality check 结果见下方';
    return;
  }
  const result = await runAi(action, body);
  const plan = (result as { plan?: DirectorPlan })?.plan;
  if (plan) {
    await s.savePlan(plan, 'builtin_ai');
    notice.value = `AI 建议已生成（${action}），已保存为新 DirectorPlan 版本 — 可继续手工调整`;
  } else {
    notice.value = 'AI 未返回可用的计划';
  }
}

async function aiCompile() {
  const result = await runAi('compile_prompt', { shotId });
  const text = (result as { text?: string })?.text;
  if (text) {
    const pv = await s.importRawPrompt(text, sShot.value?.h3Mode ?? 't2va');
    void pv;
    notice.value = 'AI 编译的 Prompt 已保存为新 PromptVersion';
  }
}

async function aiDiagnose(takeId: string) {
  const result = await runAi('diagnose_take', { takeId });
  aiResults.value[`diag:${takeId}`] = result;
  notice.value = '诊断完成，见 Take 区域下方';
}

async function aiPreflight(_promptId: string) {
  const prompt = latestPrompt();
  if (!prompt) return null;
  const result = await runAi('continuity_check', { shotId });
  aiResults.value.continuity = result;
  const report = await s.runPreflight(prompt.id);
  notice.value = 'Basic Preflight 已运行；AI 语义检查结果见 Preflight 面板下方';
  return report;
}

async function doRender(promptId: string) {
  const job = await s.render(promptId, providerId.value, sShot.value?.durationSeconds);
  notice.value = `已提交渲染任务 ${job.id} — 状态会实时推送，见渲染队列`;
}

async function copyContextPackage() {
  const pkg = await s.contextPackage(externalTask.value);
  externalPkg.value = pkg;
  await navigator.clipboard.writeText(JSON.stringify(pkg, null, 2));
  notice.value = 'Context Package 已复制到剪贴板（未调用任何 API）';
}

async function parsePaste() {
  parseResult.value = await post(`/api/shots/${shotId}/plans/parse`, { text: pasteText.value });
}

async function applyParsed() {
  if (parseResult.value?.plan) {
    await s.savePlan(parseResult.value.plan, 'external_ai');
    notice.value = '外部 AI 的 DirectorPlan 已应用为新版本';
    parseResult.value = null;
    pasteText.value = '';
  }
}

/** Frame Bridge "inherit continuity only" (PRD §32): fold the previous
 * shot's committed actual visual continuity into this shot's planned start. */
async function inheritContinuity() {
  const actual = sDetail.value?.continuityLatest?.visualActual?.state;
  if (!actual) {
    notice.value = '没有已提交的 Actual Continuity 可继承（先在上一镜头 Select + Commit）';
    return;
  }
  const plan = sPlan.value?.plan ? structuredClone(sPlan.value.plan) : emptyPlan();
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
  notice.value = '已将上一镜头的 Actual Continuity 继承为本镜头的 Planned Start State（新计划版本）';
}

async function useTakeFrame(takeId: string, which: 'first' | 'last') {
  const target = media.value.find((m) => m.label.includes(`Take ${takeId} ${which} frame`));
  if (!target) {
    notice.value = `未找到 Take ${takeId} 的${which === 'last' ? '尾' : '首'}帧资产`;
    return;
  }
  await s.addBinding({
    assetId: target.id,
    roles: ['first_frame'],
    label: `Frame bridge from ${takeId} (${which === 'last' ? 'last' : 'first'} frame)`,
  });
  notice.value = `已把 Take ${takeId} 的${which === 'last' ? '尾' : '首'}帧绑定为本镜头的 First Frame`;
}

let off: (() => void) | null = null;

onMounted(async () => {
  await s.load();
  await loadMedia();
  await project.refreshProviders();
  off = subscribeEvents((e) => {
    if (e.type === 'take.created' || e.type === 'shot.updated' || e.type === 'render.job.succeeded') void s.load();
    if (e.type === 'take.created') void loadMedia();
  });
});

onUnmounted(() => off?.());
</script>

<template>
  <div v-if="sLoading" class="page muted">加载中…</div>
  <div v-else-if="sError" class="page badge bad">{{ sError }}</div>

  <div v-else-if="sShot" class="desk">
    <!-- Header -->
    <header class="desk-header">
      <div class="row wrap">
        <h1 class="mono">{{ sShot.id }}</h1>
        <h1>{{ sShot.title }}</h1>
        <span :class="['badge', STATUS_BADGE[sShot.status]]">{{ statusOf(sShot) }}</span>
        <span class="badge accent">{{ H3_MODE_LABEL[sShot.h3Mode ?? 't2va'] }}</span>
        <span class="badge">{{ sShot.durationSeconds }}s</span>
        <span class="badge">{{ sShot.aspectRatio }}</span>
        <span class="badge">{{ sShot.shotFunction }}</span>
        <span v-if="sShot.sequenceId" class="badge info">{{ sDetail?.sequences.find((x) => x.id === sShot?.sequenceId)?.title }}</span>
      </div>
      <div class="row controls">
        <select v-model="sShot.h3Mode" class="mode-select" @change="s.updateShot({ h3Mode: sShot?.h3Mode ?? 't2va' })">
          <option v-for="m in availableModes" :key="m" :value="m">{{ m.toUpperCase() }}</option>
        </select>
        <input v-model.number="sShot.durationSeconds" type="number" min="1" max="15" class="dur" title="时长" @change="s.updateShot({ durationSeconds: sShot?.durationSeconds ?? 5 })" />
        <select v-model="sShot.storyBeatId" class="beat-select" @change="s.updateShot({ storyBeatId: sShot?.storyBeatId })">
          <option :value="null">— StoryBeat —</option>
          <option v-for="b in sDetail?.beats ?? []" :key="b.id" :value="b.id">{{ b.title }}</option>
        </select>
        <select v-model="sShot.primaryCharacterId" @change="s.updateShot({ primaryCharacterId: sShot?.primaryCharacterId })">
          <option :value="null">— 主角色 —</option>
          <option v-for="e in sDetail?.entities.filter((x) => x.kind === 'character') ?? []" :key="e.id" :value="e.id">{{ e.name }}</option>
        </select>
        <select v-model="sShot.sceneId" @change="s.updateShot({ sceneId: sShot?.sceneId })">
          <option :value="null">— 场景 —</option>
          <option v-for="e in sDetail?.entities.filter((x) => x.kind === 'scene') ?? []" :key="e.id" :value="e.id">{{ e.name }}</option>
        </select>
      </div>
      <p v-if="notice" class="notice">{{ notice }}</p>
    </header>

    <!-- Three-column core -->
    <div class="core">
      <!-- Assets rail -->
      <aside class="rail panel">
        <div class="panel-title">Assets / 需求</div>
        <div class="panel-body col">
          <div v-for="r in sDetail?.requirements ?? []" :key="r.kind" class="row">
            <span :class="['badge', r.level === 'ok' ? 'ok' : r.level === 'required' ? 'bad' : 'muted']">
              {{ r.level === 'ok' ? '✓' : r.level === 'required' ? '⚠' : '○' }} {{ r.label }}
            </span>
            <span class="muted">{{ r.detail }}</span>
          </div>
          <div class="sep" />
          <div class="muted">
            <div class="row"><span class="status-dot" style="background: var(--ok)"></span>已提交 Actual Continuity</div>
            <div class="row"><span class="status-dot" style="background: var(--info)"></span>Planned Continuity</div>
          </div>
          <div v-if="sDetail?.continuityLatest?.visualActual?.state" class="muted mono state-box">
            {{ JSON.stringify(sDetail.continuityLatest.visualActual.state, null, 1).slice(0, 500) }}
          </div>
          <button class="sm" @click="tab = 'plan'">编辑计划连续性 →</button>
          <button class="sm" :disabled="!sDetail?.continuityLatest?.visualActual?.state" @click="inheritContinuity">
            继承上一镜头 Actual → Planned
          </button>
        </div>
      </aside>

      <!-- Stage -->
      <section class="stage panel">
        <div class="panel-title">Stage / Preview</div>
        <div class="panel-body">
          <VideoPlayer
            v-if="sSelected"
            :src="takeVideoUrl(sSelected.id)"
            :poster="sSelected.posterPath ? `/api/file/${encodeURIComponent(sSelected.posterPath)}` : undefined"
            :label="`Selected take ${sSelected.id}`"
          />
          <div v-else class="empty-stage muted">还没有 Selected Take。<br />下方 Take 区域选择后这里播放。</div>
          <div v-if="sSelected" class="muted selected-info">
            当前 Selected：{{ sSelected.id }} · {{ sSelected.duration.toFixed(1) }}s
            <button class="sm" @click="s.rejectTake(sSelected.id)">取消选择</button>
          </div>
        </div>
      </section>

      <!-- Inspector -->
      <section class="inspector panel">
        <div class="tabs">
          <button v-for="t in ([{ id: 'plan', label: 'DirectorPlan' }, { id: 'references', label: 'References' }, { id: 'prompt', label: 'Prompt' }, { id: 'preflight', label: 'Preflight' }, { id: 'external', label: 'External AI' }] as const)" :key="t.id" :class="['tab', { active: tab === t.id }]" @click="tab = t.id">
            {{ t.label }}
          </button>
        </div>

        <div v-if="tab === 'plan'" class="tab-body">
          <PlanEditor
            :plan="sPlan?.plan ?? { ...emptyPlan(), version: 0 }"
            :ai-enabled="aiEnabled"
            :on-ai-suggest="aiSuggest"
            @save="(p: DirectorPlan) => s.savePlan(p)"
            @paste="tab = 'external'"
          />
        </div>

        <div v-else-if="tab === 'references'" class="tab-body">
          <ReferencesPanel
            :bindings="sDetail?.bindings ?? []"
            :media="media"
            :on-add="s.addBinding"
            :on-update="s.updateBinding"
            :on-remove="s.removeBinding"
          />
        </div>

        <div v-else-if="tab === 'prompt'" class="tab-body">
          <PromptPanel
            :prompts="sDetail?.prompts ?? []"
            :current-mode="sShot.h3Mode"
            :ai-enabled="aiEnabled"
            :on-compile="(m: string) => s.compilePrompt(m)"
            :on-raw="(t: string, m: string) => s.importRawPrompt(t, m)"
            :on-ai-compile="aiCompile"
          />
        </div>

        <div v-else-if="tab === 'preflight'" class="tab-body">
          <PreflightPanel
            :reports="sDetail?.preflights ?? []"
            :prompt="latestPrompt()"
            :provider-id="providerId"
            :ai-enabled="aiEnabled"
            :on-basic="(pid: string) => s.runPreflight(pid)"
            :on-ai-check="aiPreflight"
            :on-render="doRender"
          />
          <div v-if="aiResults.continuity" class="panel ai-note">
            <div class="panel-title">AI Continuity Check</div>
            <pre class="ai-text">{{ aiText(aiResults.continuity) }}</pre>
          </div>
        </div>

        <div v-else-if="tab === 'external'" class="tab-body">
          <div class="col">
            <label class="field">
              任务模板
              <select v-model="externalTask">
                <option v-for="t in EXTERNAL_TASKS" :key="t.id" :value="t.id">{{ t.id }}</option>
              </select>
            </label>
            <p class="muted">Copy Context Package = 只复制上下文，不调用任何 API。把内容丢给 ChatGPT / Claude 等外部 AI。</p>
            <button class="primary sm" @click="copyContextPackage">Copy Context Package</button>

            <div class="sep" />
            <label class="field">
              粘贴外部 AI 返回的 DirectorPlan（YAML / JSON）
              <textarea v-model="pasteText" rows="8" placeholder="intent:&#10;  shot_function: wide&#10;  visual_thesis: …"></textarea>
            </label>
            <div class="row">
              <button class="sm" @click="parsePaste">解析预览</button>
              <button v-if="parseResult?.ok" class="primary sm" @click="applyParsed">Preview Diff → Apply</button>
            </div>
            <div v-if="parseResult && !parseResult.ok" class="badge bad">解析失败：{{ parseResult.error }} — 可保存为 Note 手工搬字段</div>
            <div v-if="parseResult?.ok" class="muted">解析成功，Apply 后作为新 DirectorPlan 版本保存。</div>
          </div>
        </div>
      </section>
    </div>

    <!-- Takes -->
    <section class="takes-section">
      <div class="panel-title">Takes / Render Variants</div>
      <div class="panel-body">
        <TakesPanel
          :takes="sDetail?.takes ?? []"
          :selected-take-id="sSelected?.id ?? null"
          :ai-enabled="aiEnabled"
          :actual-state="sDetail?.continuityLatest?.visualActual?.state ?? null"
          :on-select="s.selectTake"
          :on-reject="s.rejectTake"
          :on-update="s.updateTake"
          :on-ai-diagnose="aiDiagnose"
          :on-select-commit="(tid: string, st: import('@h3mise/shared').VisualContinuityState) => s.selectAndCommit(tid, st)"
          :on-use-last-frame="(tid: string) => useTakeFrame(tid, 'last')"
          :on-use-first-frame="(tid: string) => useTakeFrame(tid, 'first')"
        />
        <div v-for="(v, k) in aiResults" :key="k" v-show="k.startsWith('diag:')" class="panel ai-note">
          <div class="panel-title">AI Diagnosis — {{ k }}</div>
          <pre class="ai-text">{{ aiText(v) }}</pre>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.desk { padding: 20px 28px 40px; max-width: 1600px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.desk-header { display: flex; flex-direction: column; gap: 8px; }
.desk-header h1 { font-size: 19px; margin: 0; }
.wrap { flex-wrap: wrap; }
.mode-select { width: 100px; }
.dur { width: 64px; }
.beat-select { max-width: 180px; }
.controls { flex-wrap: wrap; }
.controls select, .controls input { max-width: 180px; }
.notice { margin: 0; color: var(--accent); font-size: 13px; }
.core { display: grid; grid-template-columns: 200px 1fr 420px; gap: 14px; align-items: start; }
@media (max-width: 1200px) { .core { grid-template-columns: 1fr; } }
.rail { position: sticky; top: 66px; }
.stage .empty-stage { padding: 60px 0; text-align: center; color: var(--text-3); }
.selected-info { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.tabs { display: flex; border-bottom: 1px solid var(--line); }
.tab { border: none; background: transparent; border-radius: 0; border-bottom: 2px solid transparent; color: var(--text-2); padding: 10px 12px; }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.tab-body { padding: 12px; max-height: calc(100vh - 240px); overflow: auto; }
.takes-section { border-top: 1px solid var(--line); padding-top: 10px; }
.sep { border-top: 1px dashed var(--line); margin: 8px 0; }
.state-box { font-size: 11px; white-space: pre-wrap; background: var(--bg); border-radius: 4px; padding: 6px; max-height: 180px; overflow: auto; }
.ai-note { margin-top: 10px; }
.ai-text { font-family: var(--mono); font-size: 12px; white-space: pre-wrap; padding: 10px; margin: 0; color: var(--text-2); }
</style>
