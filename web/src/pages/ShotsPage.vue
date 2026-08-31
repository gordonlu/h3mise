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
const newShot = ref({ title: '', purpose: '', shotFunction: 'wide', durationSeconds: 5, h3Mode: 't2va' });
const pasteText = ref('');
const busy = ref(false);
const filter = ref('');
const statusFilter = ref('');
const batchPlan = ref<RenderBatchPlan | null>(null);
const batchBusy = ref(false);
const batchOpen = ref(false);

const batchProviderId = computed(() => project.current?.config.default_provider ?? 'runninghub');
const batchMegapixels = computed(() => batchProviderId.value === 'runninghub' ? 0.6 : undefined);
const BATCH_STAGE: Record<RenderBatchShotStage, { label: string; cls: string }> = {
  ready: { label: '可生成', cls: 'ok' },
  active: { label: '进行中', cls: 'warn' },
  done: { label: '已完成', cls: 'ok' },
  needs_selection: { label: '待选片', cls: 'violet' },
  waiting_dependency: { label: '等上一镜', cls: 'warn' },
  needs_assets: { label: '缺素材', cls: 'bad' },
  needs_prompt: { label: '待生成 Prompt', cls: 'info' },
  needs_preflight: { label: '待检查', cls: 'info' },
  blocked: { label: '被阻塞', cls: 'bad' },
};

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
    <div class="spread page-head">
      <h1>{{ t('pages.shots.title') }} <span class="muted">{{ t('pages.shots.shotsCount', { n: shots.length }) }}</span></h1>
      <div class="row">
        <select v-model="statusFilter" class="status-filter" title="按状态筛选">
          <option value="">全部状态</option>
          <option v-for="(label, key) in SHOT_USER_STATUS_LABEL" :key="key" :value="key">{{ label }}</option>
        </select>
        <input v-model="filter" placeholder="搜索 Shot…" class="search" />
        <button @click="batchOpen ? batchOpen = false : analyzeBatch()">{{ batchOpen ? '收起批量生成' : '批量生成' }}</button>
        <button @click="showPaste = !showPaste; showCreate = false">粘贴 Shot List</button>
        <button class="primary" @click="showCreate = !showCreate; showPaste = false">+ 新建 Shot</button>
      </div>
    </div>

    <div v-if="batchOpen" class="panel batch-panel">
      <div class="panel-title spread">
        <span>项目生成调度 · {{ batchProviderId }}</span>
        <span v-if="batchPlan" class="muted">Provider 并发 {{ batchPlan.providerConcurrency }}{{ batchMegapixels !== undefined ? ` · ${batchMegapixels} MP` : '' }}</span>
      </div>
      <div class="panel-body col">
        <p class="muted">先分析依赖并准备 Prompt / Preflight；只有点击最后的确认按钮才会提交视频生成。</p>
        <div v-if="batchBusy && !batchPlan" class="muted">正在分析镜头…</div>
        <template v-if="batchPlan">
          <div class="row wrap batch-counts">
            <span v-for="(meta, stage) in BATCH_STAGE" :key="stage" v-show="batchPlan.counts[stage]" :class="['badge', meta.cls]">
              {{ meta.label }} {{ batchPlan.counts[stage] }}
            </span>
          </div>
          <div class="batch-list">
            <div v-for="item in batchPlan.shots" :key="item.shotId" class="batch-row">
              <span class="mono muted">{{ String(item.order).padStart(2, '0') }}</span>
              <router-link :to="`/shots/${item.shotId}`">{{ item.title || item.shotId }}</router-link>
              <span :class="['badge', BATCH_STAGE[item.stage].cls]">{{ BATCH_STAGE[item.stage].label }}</span>
              <span class="muted batch-reason" :title="item.reason">{{ item.reason }}</span>
            </div>
          </div>
          <div class="row batch-actions">
            <button :disabled="batchBusy" @click="analyzeBatch">重新分析</button>
            <button :disabled="batchBusy" @click="prepareBatch">{{ batchBusy ? '处理中…' : '批量准备（不生成视频）' }}</button>
            <button class="primary" :disabled="batchBusy || !batchPlan.counts.ready" @click="submitReadyBatch">
              确认并生成 {{ batchPlan.counts.ready }} 个 Ready Shot
            </button>
          </div>
        </template>
      </div>
    </div>

    <div v-if="showCreate" class="panel create-panel">
      <div class="panel-title">新建 Shot（一个 Shot = 一个连续电影事件）</div>
      <div class="panel-body col">
        <div class="row">
          <label class="field grow">
            标题
            <input v-model="newShot.title" placeholder="Shot 标题" @keyup.enter="createShot" />
          </label>
          <label class="field mode-field">
            H3 Mode
            <select v-model="newShot.h3Mode">
              <option v-for="m in availableModes" :key="m" :value="m">{{ H3_MODE_LABEL[m] }}</option>
            </select>
          </label>
          <label class="field">
            时长
            <input v-model.number="newShot.durationSeconds" type="number" min="1" max="15" title="时长（秒，1–15）" placeholder="5" />
          </label>
        </div>
        <label class="field">
          目的
          <textarea v-model="newShot.purpose" rows="2" placeholder="这个镜头要完成什么？"></textarea>
        </label>
        <div class="row">
          <button class="primary" :disabled="busy || !newShot.title.trim()" @click="createShot">创建并打开</button>
          <button @click="showCreate = false">取消</button>
        </div>
      </div>
    </div>

    <div v-if="showPaste" class="panel create-panel">
      <div class="panel-title">粘贴外部 AI / 手工 Shot List（每行一个，或 JSON 数组）</div>
      <div class="panel-body col">
        <textarea v-model="pasteText" rows="6" placeholder="1. 雨夜小巷，女子走入镜头&#10;2. 她在路灯下停步&#10;…"></textarea>
        <div class="row">
          <button class="primary" :disabled="busy || !pasteText.trim()" @click="pasteShots">导入 Shots</button>
          <button @click="showPaste = false">取消</button>
        </div>
      </div>
    </div>

    <div v-if="!shots.length" class="panel">
      <EmptyState icon="🎬" title="还没有 Shot" desc="Shot 是导演的第一等公民 — 新建一个，或从外部 AI 粘贴 Shot List 批量创建。">
        <button class="primary sm" @click="showCreate = true">+ 新建 Shot</button>
        <button class="sm" @click="showPaste = true">粘贴 Shot List</button>
      </EmptyState>
    </div>

    <div class="board">
      <router-link v-for="(s, i) in filtered" :key="s.id" :to="`/shots/${s.id}`" class="card panel">
        <div class="cover" :class="{ 'no-cover': !s.cover }">
          <img v-if="s.cover" :src="fileUrl(s.cover)" :alt="s.title" />
          <span v-else class="cover-idx">SHOT<br />{{ String(i + 1).padStart(2, '0') }}</span>
          <span v-if="s.activeJobs > 0" class="badge warn render-badge">生成中…</span>
          <span v-else-if="SHOT_USER_STATUS[s.status] === 'review'" class="badge violet review-badge">待选片</span>
        </div>
        <div class="card-body">
          <div class="spread">
            <span class="card-title">{{ s.title || s.id }}</span>
            <span :class="['st', `st-${SHOT_USER_STATUS[s.status]}`]" :title="`内部状态：${SHOT_STATUS_LABEL[s.status]}`">
              <i />{{ SHOT_USER_STATUS_LABEL[SHOT_USER_STATUS[s.status]] }}
            </span>
            <button class="sm danger shot-delete" title="删除 Shot（含其计划、Prompt、Takes 与任务）" @click.stop.prevent="deleteShot(s)">删除</button>
          </div>
          <div class="row wrap">
            <span class="badge accent no-dot">{{ H3_MODE_LABEL[s.h3Mode ?? 't2va'] }}</span>
            <span class="badge no-dot">{{ s.durationSeconds }}s</span>
            <span class="badge no-dot">{{ s.shotFunction }}</span>
            <span v-if="entityName(s.primaryCharacterId)" class="badge no-dot">{{ entityName(s.primaryCharacterId) }}</span>
            <span v-if="entityName(s.sceneId)" class="badge info no-dot">{{ entityName(s.sceneId) }}</span>
            <span :class="['badge', s.renderReadiness.ready ? 'ok' : 'warn']" :title="s.renderReadiness.reason">
              {{ s.renderReadiness.ready ? (s.renderReadiness.effectiveMode === 'previous_take' ? '尾帧已接通' : '可并行') : s.renderReadiness.reason }}
            </span>
          </div>
          <div class="muted purpose">{{ s.purpose || '—' }}</div>
          <!-- PRD §9 card fields: missing assets + risk flag -->
          <div v-if="s.missing?.length" class="missing-row">
            <span class="badge bad no-dot">⚠ 缺资产</span>
            <span class="muted">{{ s.missing.join('、') }}</span>
          </div>
          <div class="spread card-foot">
            <span class="muted">{{ s.takeCount }} Takes · {{ s.selectedTakeId ? '已选片' : '未选片' }}</span>
            <span v-if="s.risk" :class="['badge', RISK_BADGE[s.risk]]" title="最近一次 Preflight 风险">Risk {{ s.risk }}</span>
          </div>
        </div>
      </router-link>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 24px 32px; max-width: 1360px; margin: 0 auto; }
.page-head { margin-bottom: 4px; }
h1 { font-size: 22px; margin: 0; font-family: var(--serif); }
.search { width: 180px; }
.status-filter { width: 110px; }
.create-panel { margin: 16px 0; }
.batch-panel { margin: 16px 0; }
.batch-counts { gap: 7px; }
.batch-list { display: grid; gap: 6px; max-height: 320px; overflow: auto; }
.batch-row { display: grid; grid-template-columns: 28px minmax(130px, 0.8fr) max-content minmax(180px, 1.5fr); align-items: center; gap: 9px; padding: 7px 9px; border-radius: var(--radius-sm); background: var(--bg-subtle); font-size: 12px; }
.batch-reason { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.batch-actions { justify-content: flex-end; flex-wrap: wrap; }
.mode-field select { width: 220px; }
.board { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 16px; margin-top: 18px; }
.shot-delete { margin-left: auto; padding: 2px 10px; font-size: 11px; flex: none; }
.card { display: block; text-decoration: none; color: inherit; position: relative; overflow: hidden; transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s; }
.card:hover { border-color: var(--accent-line); transform: translateY(-2px); box-shadow: var(--shadow-2); text-decoration: none; }
.cover { position: relative; height: 142px; background: var(--inset); display: flex; align-items: center; justify-content: center; overflow: hidden; }
.cover img { width: 100%; height: 100%; object-fit: cover; }
.cover-idx { font-family: var(--mono); letter-spacing: 0.25em; color: var(--text-3); text-align: center; line-height: 1.8; font-size: 12px; }
.render-badge, .review-badge { position: absolute; top: 8px; right: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.25); }
.card-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 7px; }
.card-title { font-weight: 600; font-size: 14.5px; }
.purpose { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 36px; }
.wrap { flex-wrap: wrap; }
.missing-row { display: flex; align-items: center; gap: 6px; font-size: 11.5px; }
.card-foot { border-top: 1px dashed var(--line); padding-top: 7px; }
@media (max-width: 760px) {
  .batch-row { grid-template-columns: 24px minmax(100px, 1fr) max-content; }
  .batch-reason { grid-column: 2 / -1; white-space: normal; }
}
</style>
