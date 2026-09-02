<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { Storyboard, StoryboardPanelCount, StoryboardProviderProfile } from '@h3mise/shared';
import { recommendedStoryboardPanelCount } from '@h3mise/shared';
import { get, mediaUrl, patch, post } from '../api/client';
import { confirmDialog } from '../stores/confirm';
import { useToastStore } from '../stores/toast';

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
    toasts.push({ kind: 'ok', text: `已免费生成 ${selectedCount.value} 格文字规划，尚未调用生图 API` });
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
    toasts.push({ kind: 'ok', text: '分格描述已保存' });
  } catch (error) {
    toasts.push({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
  }
}

function costText(): string {
  return provider.value?.estimatedCostCny == null ? '费用以 RunningHub 返回为准' : `预估约 ¥${provider.value.estimatedCostCny.toFixed(2)} / 次`;
}

async function generateSheet() {
  if (!storyboard.value || busy.value || active.value) return;
  const ok = await confirmDialog({
    title: `生成 ${storyboard.value.panelCount} 宫格 Storyboard`,
    message: `${costText()}。这会创建真实的 RunningHub 付费任务；拆图由本地 FFmpeg 完成，不另收费。`,
    confirmLabel: '确认付费生成',
  });
  if (!ok) return;
  busy.value = true;
  try {
    storyboard.value = await post<Storyboard>(`/api/storyboard/${storyboard.value.id}/generate`, { confirmed: true });
    toasts.push({ kind: 'info', text: 'Storyboard 生图已提交，可离开此页稍后查看' });
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
    title: `单独重生第 ${order} 格`,
    message: `${costText()}。旧版本会保留；成功后只替换这一格，并在本地重组黑边框宫格。`,
    confirmLabel: '确认付费重生',
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
        ? `Storyboard 已批准并接入 Shotboard：新建 ${sync.shotsCreated} 个 Shot，更新 ${sync.shotsUpdated} 个，绑定 ${sync.bindingsCreated} 张分格参考图`
        : 'Storyboard 已批准并接入 Shotboard',
    });
  } catch (error) {
    toasts.push({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
  }
}

function actualCost(): string | null {
  const cost = storyboard.value?.activeJob?.cost;
  if (!cost) return null;
  const money = cost.thirdPartyConsumeMoney ?? cost.consumeMoney;
  return [money != null ? `金额 ¥${money}` : null, cost.consumeCoins != null ? `${cost.consumeCoins} 币` : null, cost.taskCostTime != null ? `${cost.taskCostTime}s` : null].filter(Boolean).join(' · ');
}

onMounted(() => void load());
onUnmounted(() => { if (pollTimer) clearTimeout(pollTimer); });
</script>

<template>
  <div class="page storyboard-page">
    <div class="spread page-head">
      <div><h1>Storyboard（可选）</h1><p class="muted">先免费检查文字分格，再决定是否付费生图；不会改变现有 Shot / Take 流程。</p></div>
      <div class="row"><RouterLink class="button-link sm" to="/story">← 故事</RouterLink><RouterLink class="button-link sm" to="/shots">继续到 Shotboard →</RouterLink></div>
    </div>

    <div v-if="!storyboard" class="panel setup-panel">
      <div class="panel-title">先生成文字分格（免费）</div>
      <div class="panel-body col">
        <p>当前约 <strong>{{ segmentCount }} 个叙事段</strong>（项目约 {{ duration }} 秒），推荐首张使用 <strong>{{ recommended }} 格</strong>。每个 Shot 仍是独立的 2–15 秒视频。</p>
        <p v-if="segmentCount > 9" class="muted">超过 9 段会自动拆成多张 Storyboard，每一页单独确认、单独付费生成。</p>
        <div class="count-options">
          <label v-for="count in ([3, 6, 9] as const)" :key="count" :class="{ selected: selectedCount === count }">
            <input v-model="selectedCount" type="radio" :value="count" /><strong>{{ count }} 格</strong><span>{{ count === recommended ? '按段数推荐' : count === 3 ? '1–3 段' : count === 6 ? '4–6 段' : '7–9 段 / 每页' }}</span>
          </label>
        </div>
        <button class="primary" :disabled="busy" @click="prepare">{{ busy ? '准备中…' : '生成文字 Storyboard（免费）' }}</button>
      </div>
    </div>

    <template v-else>
      <div class="panel status-panel">
        <div class="panel-body spread">
          <div class="row wrap">
            <span class="badge">第 {{ storyboard.pageNumber }}/{{ storyboard.totalPages }} 页 · {{ storyboard.panelCount }} 格</span>
            <span class="muted">覆盖叙事段 {{ storyboard.sourceStartIndex + 1 }}–{{ storyboard.sourceEndIndex }} · 项目约 {{ storyboard.sourceDurationSeconds }}s</span>
            <span class="badge" :class="storyboard.status === 'failed' ? 'bad' : storyboard.status === 'approved' ? 'ok' : active ? 'warn' : ''">{{ active ? 'AI 正在生成…' : storyboard.status === 'approved' ? '已批准' : storyboard.status === 'failed' ? '生成失败' : storyboard.status === 'ready' ? '图片已就绪' : '文字规划' }}</span>
            <span v-if="actualCost()" class="muted">本次消耗：{{ actualCost() }}</span>
            <span v-if="storyboard.activeJob?.error" class="bad-text">{{ storyboard.activeJob.error }}</span>
          </div>
          <div class="row"><select v-model="selectedCount"><option :value="3">3 格</option><option :value="6">6 格</option><option :value="9">9 格</option></select><button class="sm" :disabled="busy || active" @click="prepare">重新准备</button></div>
        </div>
      </div>

      <nav v-if="pages.length > 1" class="page-tabs" aria-label="Storyboard pages">
        <button v-for="page in pages" :key="page.id" class="page-tab" :class="{ active: page.id === storyboard.id }" @click="selectPage(page.id)">
          第 {{ page.pageNumber }} 页
          <span :class="page.status === 'failed' ? 'bad-text' : 'muted'">{{ page.status === 'approved' ? '已批准' : page.panels.every(panel => panel.assetId) ? '已生成' : page.status === 'generating' ? '生成中' : '待生成' }}</span>
        </button>
      </nav>

      <div class="storyboard-grid">
        <article v-for="panel in storyboard.panels" :key="panel.id" class="storyboard-panel">
          <div class="panel-image"><img v-if="panel.assetId" :src="mediaUrl(panel.assetId)" :alt="`Storyboard ${panel.order}`" /><span v-else>{{ panel.order }}</span></div>
          <div class="panel-editor">
            <div class="spread"><strong>第 {{ storyboard.pageNumber }} 页 · 第 {{ panel.order }} 格</strong><span class="muted">v{{ panel.version }}</span></div>
            <textarea v-model="panelDrafts[panel.id]" rows="4" :disabled="active"></textarea>
            <div class="row"><button class="sm" :disabled="panelDrafts[panel.id]?.trim() === panel.description" @click="savePanel(panel.id)">保存描述</button><button v-if="panel.assetId" class="sm" :disabled="busy || active || !providerReady" @click="regeneratePanel(panel.id, panel.order)">AI 单独重生</button></div>
          </div>
        </article>
      </div>

      <div class="action-bar panel">
        <div><strong>{{ providerReady ? costText() : '生图 Provider 尚未检测' }}</strong><p class="muted">固定黑边框；整张生成后在本地按 3×1 / 3×2 / 3×3 精确拆分。</p></div>
        <div class="row wrap"><RouterLink v-if="!providerReady" class="button-link sm" to="/settings">去设置生图 API</RouterLink><button class="primary" :disabled="busy || active || !providerReady" @click="generateSheet">{{ active ? 'AI 正在生成…' : storyboard.sheetAssetId ? '重新生成本页' : `付费生成第 ${storyboard.pageNumber} 页` }}</button><button v-if="nextPage && storyboard.panels.every(panel => panel.assetId)" class="sm" :disabled="active" @click="selectPage(nextPage.id)">进入下一页 →</button><button v-if="allPagesReady" class="sm" :disabled="active" @click="approve">批准全部并继续</button></div>
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
