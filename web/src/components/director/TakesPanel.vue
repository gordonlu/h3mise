<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, toRaw } from 'vue';
import type { Take, VisualContinuityState } from '@h3mise/shared';
import { FAILURE_TAGS } from '@h3mise/shared';
import { takeVideoUrl, fileUrl } from '../../api/client';
import { confirmDialog } from '../../stores/confirm';
import VideoPlayer from '../VideoPlayer.vue';
import VideoAnalysisFilmstrip from '../VideoAnalysisFilmstrip.vue';

interface EntityLite {
  id: string;
  name: string;
  kind: string;
}
interface StateLite {
  id: string;
  characterId: string;
  name: string;
}

const props = defineProps<{
  takes: Take[];
  selectedTakeId: string | null;
  aiEnabled: boolean;
  /** Latest committed actual visual continuity (prefill for select+commit). */
  actualState: VisualContinuityState | null;
  committedTakeId: string | null;
  entities: EntityLite[];
  characterStates: StateLite[];
  onImport: (file: File) => Promise<Take>;
  onSelect: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onUpdate: (id: string, patch: Partial<Take>) => Promise<void>;
  onAiDiagnose: (takeId: string) => Promise<void>;
  onAiContinuity: (takeId: string) => Promise<{ state: VisualContinuityState }>;
  onSelectCommit: (takeId: string, state: VisualContinuityState) => Promise<void>;
  onUseLastFrame: (takeId: string) => Promise<void>;
  onUseFirstFrame: (takeId: string) => Promise<void>;
}>();

/** Currently focused take (click cover) — player + keyboard shortcut target. */
const active = ref<string | null>(null);
/** Explicit A/B compare slots. */
const slotA = ref<string | null>(null);
const slotB = ref<string | null>(null);
const syncPlay = ref(true);
const playerA = ref<InstanceType<typeof VideoPlayer> | null>(null);
const playerB = ref<InstanceType<typeof VideoPlayer> | null>(null);
const tagOpen = ref<Record<string, boolean>>({});
const noteEdit = ref<string | null>(null);
const busyId = ref<string | null>(null);
const importInput = ref<HTMLInputElement | null>(null);
const importBusy = ref(false);
const importError = ref('');

const activeTake = computed(() => props.takes.find((t) => t.id === active.value) ?? null);
const takeA = computed(() => props.takes.find((t) => t.id === slotA.value) ?? null);
const takeB = computed(() => props.takes.find((t) => t.id === slotB.value) ?? null);
const compareMode = computed(() => !!(takeA.value && takeB.value));

async function run(id: string, fn: () => Promise<void>) {
  busyId.value = id;
  try {
    await fn();
  } finally {
    busyId.value = null;
  }
}

async function removeRejectedTake(take: Take) {
  const ok = await confirmDialog({
    title: `删除 ${take.id}？`,
    message: '将删除这个 Rejected Take 的本地视频、海报和未被引用的帧文件。渲染任务与费用记录会保留。',
    confirmLabel: '删除 Take',
    danger: true,
  });
  if (!ok) return;
  await run(take.id, () => props.onDelete(take.id));
  if (active.value === take.id) active.value = null;
  if (slotA.value === take.id) slotA.value = null;
  if (slotB.value === take.id) slotB.value = null;
}

async function onImportPick(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  importBusy.value = true;
  importError.value = '';
  try {
    await props.onImport(file);
  } catch (error) {
    importError.value = error instanceof Error ? error.message : String(error);
  } finally {
    importBusy.value = false;
    input.value = '';
  }
}

// --- A/B sync ---------------------------------------------------------------
let mirroring = false;
function mirror(src: 'A' | 'B', action: 'play' | 'pause' | 'seek') {
  if (!syncPlay.value || mirroring) return;
  const from = src === 'A' ? playerA.value : playerB.value;
  const to = src === 'A' ? playerB.value : playerA.value;
  if (!from || !to) return;
  mirroring = true;
  try {
    if (action === 'play') {
      to.seek(from.currentTime());
      to.play();
    } else if (action === 'pause') to.pause();
    else to.seek(from.currentTime());
  } finally {
    setTimeout(() => (mirroring = false), 60);
  }
}

function assignSlot(takeId: string, slot: 'A' | 'B') {
  if (slot === 'A') slotA.value = slotA.value === takeId ? null : takeId;
  else slotB.value = slotB.value === takeId ? null : takeId;
  if (slotA.value && slotA.value === slotB.value) slotB.value = null;
}

function swapSlots() {
  const a = slotA.value;
  slotA.value = slotB.value;
  slotB.value = a;
}

// --- failure tags -----------------------------------------------------------
function toggleTag(take: Take, tag: string) {
  const next = take.failureTags.includes(tag as never) ? take.failureTags.filter((t) => t !== tag) : [...take.failureTags, tag as never];
  void props.onUpdate(take.id, { failureTags: next });
}

// --- rating -----------------------------------------------------------------
function setRating(take: Take, n: number) {
  void props.onUpdate(take.id, { rating: take.rating === n ? null : n });
}

// --- continuity commit form --------------------------------------------------
const emptyState = (): VisualContinuityState => ({
  characterStates: {}, costume: {}, hair: {}, injury: {}, heldItems: {}, location: '', timeOfDay: '',
  weather: '', wind: '', screenDirection: '', facing: '', vehicleState: {}, notes: '',
});

const commitTarget = ref<string | null>(null);
const commitPanel = ref<HTMLElement | null>(null);
const commitBusy = ref(false);
const aiContinuityBusy = ref(false);
const commitForm = ref<VisualContinuityState>(emptyState());
const heldItemsText = ref<Record<string, string>>({});

const characters = computed(() => props.entities.filter((e) => e.kind === 'character' || e.kind === 'creature'));
const vehicles = computed(() => props.entities.filter((e) => e.kind === 'vehicle'));
const needsContinuity = computed(() => Boolean(props.selectedTakeId && props.committedTakeId !== props.selectedTakeId));

function statesOf(characterId: string): StateLite[] {
  return props.characterStates.filter((s) => s.characterId === characterId);
}

function appearanceLabel(character: EntityLite, field: 'costume' | 'hair'): string {
  if (character.kind !== 'creature') return field === 'costume' ? '服装' : '发型';
  return field === 'costume' ? '穿戴 / 外观变化' : '毛发 / 表面变化';
}

async function openCommit(takeId: string) {
  commitTarget.value = takeId;
  commitForm.value = structuredClone(toRaw(props.actualState ?? emptyState()));
  // heldItems edited as comma-separated text per character.
  const ht: Record<string, string> = {};
  for (const [k, v] of Object.entries(commitForm.value.heldItems ?? {})) ht[k] = v.join(', ');
  heldItemsText.value = ht;
  await nextTick();
  commitPanel.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function selectAndOpenCommit(takeId: string) {
  await run(takeId, () => props.onSelect(takeId));
  await openCommit(takeId);
}

function syncHeldItems(state: VisualContinuityState) {
  const text: Record<string, string> = {};
  for (const [entityId, items] of Object.entries(state.heldItems ?? {})) text[entityId] = items.join(', ');
  heldItemsText.value = text;
}

async function fillContinuityFromLastFrame() {
  if (!commitTarget.value) return;
  aiContinuityBusy.value = true;
  try {
    const result = await props.onAiContinuity(commitTarget.value);
    commitForm.value = structuredClone(result.state);
    syncHeldItems(commitForm.value);
  } finally {
    aiContinuityBusy.value = false;
  }
}

async function doSelectCommit() {
  if (!commitTarget.value) return;
  commitBusy.value = true;
  try {
    const form = structuredClone(toRaw(commitForm.value));
    form.heldItems = {};
    for (const [k, v] of Object.entries(heldItemsText.value)) {
      const items = v.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      if (items.length) form.heldItems[k] = items;
    }
    await props.onSelectCommit(commitTarget.value, form);
    commitTarget.value = null;
  } finally {
    commitBusy.value = false;
  }
}

// --- keyboard shortcuts ------------------------------------------------------
function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable;
}

function onKey(e: KeyboardEvent) {
  if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = activeTake.value;
  if (!t) return;
  const k = e.key.toLowerCase();
  if (k === 's' && t.status !== 'selected') { e.preventDefault(); void selectAndOpenCommit(t.id); }
  else if (k === 'r' && t.status !== 'rejected') { e.preventDefault(); void run(t.id, () => props.onReject(t.id)); }
  else if (k === 'a') { e.preventDefault(); assignSlot(t.id, 'A'); }
  else if (k === 'b') { e.preventDefault(); assignSlot(t.id, 'B'); }
}

onMounted(() => {
  window.addEventListener('keydown', onKey);
  if (needsContinuity.value && props.selectedTakeId) void openCommit(props.selectedTakeId);
});
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="col">
    <div class="panel import-take-bar">
      <input
        ref="importInput"
        class="file-input"
        type="file"
        accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov"
        @change="onImportPick"
      />
      <div>
        <strong>已经在其他工具生成了视频？</strong>
        <span>导入后会成为这个 Shot 的 Candidate Take，不会发起渲染或产生费用。</span>
        <span v-if="importError" class="import-error">导入失败：{{ importError }}</span>
      </div>
      <button class="sm" :disabled="importBusy" @click="importInput?.click()">
        {{ importBusy ? '正在读取并抽帧…' : '导入已有视频' }}
      </button>
    </div>

    <!-- A/B compare tray -->
    <div v-if="slotA || slotB" class="panel compare-tray">
      <div class="panel-title spread">
        <span>A/B Compare</span>
        <div class="row">
          <label class="row muted sync-toggle" title="两个播放器同步播放/暂停/seek">
            <input type="checkbox" v-model="syncPlay" /> 同步播放
          </label>
          <button class="sm ghost" title="交换 A/B" @click="swapSlots">⇄ 交换</button>
          <button class="sm ghost" @click="slotA = null; slotB = null">清空</button>
        </div>
      </div>
      <div class="compare-grid">
        <div class="cmp-slot">
          <template v-if="takeA">
            <VideoPlayer
              ref="playerA"
              :src="takeVideoUrl(takeA.id)"
              :poster="takeA.posterPath ? fileUrl(takeA.posterPath) : undefined"
              :label="takeA.id"
              @play="mirror('A', 'play')"
              @pause="mirror('A', 'pause')"
              @seeked="mirror('A', 'seek')"
            />
            <div class="row cmp-label">
              <span class="badge accent no-dot">A</span>
              <span class="mono">{{ takeA.id }}</span>
              <span class="muted">{{ takeA.duration.toFixed(1) }}s</span>
              <span class="grow" />
              <button class="sm ghost" @click="slotA = null">✕</button>
            </div>
          </template>
          <div v-else class="cmp-empty muted">在 Take 卡片上点 <span class="kbd">A</span> 设定对比项 A</div>
        </div>
        <div class="cmp-slot">
          <template v-if="takeB">
            <VideoPlayer
              ref="playerB"
              :src="takeVideoUrl(takeB.id)"
              :poster="takeB.posterPath ? fileUrl(takeB.posterPath) : undefined"
              :label="takeB.id"
              @play="mirror('B', 'play')"
              @pause="mirror('B', 'pause')"
              @seeked="mirror('B', 'seek')"
            />
            <div class="row cmp-label">
              <span class="badge info no-dot">B</span>
              <span class="mono">{{ takeB.id }}</span>
              <span class="muted">{{ takeB.duration.toFixed(1) }}s</span>
              <span class="grow" />
              <button class="sm ghost" @click="slotB = null">✕</button>
            </div>
          </template>
          <div v-else class="cmp-empty muted">在 Take 卡片上点 <span class="kbd">B</span> 设定对比项 B</div>
        </div>
      </div>
    </div>

    <!-- focused single player -->
    <div v-else-if="activeTake" class="panel">
      <div class="panel-title spread">
        <span>播放 Take <span class="mono">{{ activeTake.id }}</span></span>
        <button class="sm ghost" @click="active = null">关闭</button>
      </div>
      <div class="panel-body">
        <VideoPlayer :src="takeVideoUrl(activeTake.id)" :poster="activeTake.posterPath ? fileUrl(activeTake.posterPath) : undefined" :max-height="420" />
        <VideoAnalysisFilmstrip :take-id="activeTake.id" />
      </div>
    </div>

    <div v-if="!takes.length" class="muted takes-empty">还没有 Take。可以生成新视频，也可以导入已有视频。</div>

    <div v-if="needsContinuity && !commitTarget" class="panel continuity-next-step">
      <div>
        <strong>下一步：记录 Selected Take 的最后一帧</strong>
        <span>下一镜头会用这里的角色外观、位置和环境状态保持衔接。</span>
      </div>
      <button class="primary sm" @click="selectedTakeId && openCommit(selectedTakeId)">填写连续性</button>
    </div>

    <!-- Select + Commit continuity form -->
    <div v-if="commitTarget" ref="commitPanel" class="panel commit-panel">
      <div class="panel-title">记录最后一帧状态 <span class="mono">{{ commitTarget }}</span></div>
      <div class="panel-body col">
        <p class="commit-intro">把这条视频结束时实际看到的内容记下来，下一镜头才能接得上。不确定时先让 AI 读取尾帧，再检查结果。</p>
        <div class="grid commit-grid">
          <label class="field">地点<input v-model="commitForm.location" placeholder="如：窄巷 / 天台 / 车内" /></label>
          <label class="field">时间<input v-model="commitForm.timeOfDay" placeholder="如 dusk / 03:00" /></label>
          <label class="field">天气<input v-model="commitForm.weather" placeholder="如：暴雨 / 晴 / 雾" /></label>
          <label class="field">风<input v-model="commitForm.wind" placeholder="如：3 级 / 无" /></label>
          <label class="field">银幕方向<input v-model="commitForm.screenDirection" placeholder="left-to-right" /></label>
          <label class="field">朝向<input v-model="commitForm.facing" placeholder="如：profile right" /></label>
        </div>

        <div v-if="aiEnabled" class="ai-continuity-assist">
          <div>
            <strong>推荐：让 AI 先填写</strong>
            <span>AI 读取真实尾帧生成草稿，你检查后才会保存。</span>
          </div>
          <button class="sm" :disabled="aiContinuityBusy || commitBusy" @click="fillContinuityFromLastFrame">
            {{ aiContinuityBusy ? '正在识别尾帧…' : 'AI 读取尾帧并填写' }}
          </button>
        </div>

        <template v-if="characters.length">
          <div class="muted sec-caption">角色视觉状态（服装 / 发型 / 伤势 / 手持物 / CharacterState）</div>
          <div v-for="ch in characters" :key="ch.id" class="char-block">
            <div class="row char-head">
              <span class="badge accent no-dot">{{ ch.name }}</span>
              <select
                :value="commitForm.characterStates[ch.id] ?? ''"
                title="关联 CharacterState"
                @change="commitForm.characterStates[ch.id] = ($event.target as HTMLSelectElement).value || undefined as never"
              >
                <option value="">— CharacterState —</option>
                <option v-for="st in statesOf(ch.id)" :key="st.id" :value="st.id">{{ st.name }}</option>
              </select>
            </div>
            <div class="grid commit-grid">
              <label class="field">{{ appearanceLabel(ch, 'costume') }}<input :value="commitForm.costume[ch.id] ?? ''" :placeholder="ch.kind === 'creature' ? '仅填写新增服饰、泥污等变化' : 'wet_white_shirt'" @input="commitForm.costume[ch.id] = ($event.target as HTMLInputElement).value" /></label>
              <label class="field">{{ appearanceLabel(ch, 'hair') }}<input :value="commitForm.hair[ch.id] ?? ''" :placeholder="ch.kind === 'creature' ? '仅填写湿毛、破损等变化' : 'wet'" @input="commitForm.hair[ch.id] = ($event.target as HTMLInputElement).value" /></label>
              <label class="field">伤势<input :value="commitForm.injury[ch.id] ?? ''" placeholder="forehead_cut" @input="commitForm.injury[ch.id] = ($event.target as HTMLInputElement).value" /></label>
              <label class="field">手持物（逗号分隔）<input :value="heldItemsText[ch.id] ?? ''" placeholder="umbrella, phone" @input="heldItemsText[ch.id] = ($event.target as HTMLInputElement).value" /></label>
            </div>
          </div>
        </template>

        <template v-if="vehicles.length">
          <div class="muted sec-caption">载具可见状态</div>
          <div class="grid commit-grid">
            <label v-for="v in vehicles" :key="v.id" class="field">
              {{ v.name }}
              <input :value="commitForm.vehicleState[v.id] ?? ''" placeholder="如 door_open / muddy" @input="commitForm.vehicleState[v.id] = ($event.target as HTMLInputElement).value" />
            </label>
          </div>
        </template>

        <label class="field">备注<textarea v-model="commitForm.notes" rows="2" placeholder="连续性备注：本 Take 实际结束状态与计划的偏差…"></textarea></label>

        <div class="row">
          <button class="primary sm" :disabled="commitBusy || aiContinuityBusy" @click="doSelectCommit">{{ commitBusy ? '保存中…' : '确认并保存连续性' }}</button>
          <button class="sm" @click="commitTarget = null">取消</button>
        </div>
        <p class="muted">这里只记录画面结束状态，不会改动故事内容。</p>
      </div>
    </div>

    <!-- take cards -->
    <div class="takes grid">
      <div
        v-for="t in takes"
        :key="t.id"
        class="panel take"
        :class="{ selected: t.status === 'selected', rejected: t.status === 'rejected', focused: active === t.id }"
      >
        <div class="take-cover" @click="active = active === t.id ? null : t.id">
          <img v-if="t.posterPath" :src="fileUrl(t.posterPath)" :alt="t.id" />
          <span v-else class="muted mono">no poster</span>
          <span class="badge status-badge" :class="{ ok: t.status === 'selected', bad: t.status === 'rejected' }">
            {{ t.status === 'selected' ? 'SELECTED' : t.status === 'rejected' ? 'REJECTED' : 'CANDIDATE' }}
          </span>
          <span class="dur-chip mono">{{ t.duration.toFixed(1) }}s</span>
          <span class="play-hint">▶</span>
        </div>
        <div class="take-body col">
          <div class="spread">
            <div class="row take-identity">
              <span class="mono take-id">{{ t.id }}</span>
              <span v-if="t.source === 'import'" class="badge info no-dot" :title="t.provenance.originalFileName">IMPORTED</span>
            </div>
            <div class="stars" :title="`评分 ${t.rating ?? '—'}`">
              <span v-for="i in 5" :key="i" class="star" :class="{ on: (t.rating ?? 0) >= i }" @click="setRating(t, i)">★</span>
            </div>
          </div>

          <!-- contextual primary actions -->
          <div class="row wrap">
            <template v-if="t.status === 'candidate'">
              <button class="sm primary" :disabled="busyId === t.id" title="选中后继续填写尾帧连续性；快捷键 S" @click="selectAndOpenCommit(t.id)">选用此条</button>
              <button class="sm" @click="openCommit(t.id)">选用并填写连续性</button>
              <button class="sm danger ghost" title="快捷键 R" @click="run(t.id, () => onReject(t.id))">Reject</button>
            </template>
            <template v-else-if="t.status === 'selected'">
              <button class="sm primary" @click="openCommit(t.id)">{{ committedTakeId === t.id ? '查看 / 更新连续性' : '下一步：填写连续性' }}</button>
              <button class="sm danger ghost" @click="run(t.id, () => onReject(t.id))">取消选择</button>
            </template>
            <template v-else>
              <button class="sm primary" :disabled="busyId === t.id" @click="run(t.id, () => onSelect(t.id))">改选此条</button>
              <button class="sm danger" :disabled="busyId === t.id" @click="removeRejectedTake(t)">删除</button>
            </template>
          </div>

          <div class="row wrap take-tools">
            <button class="sm" :class="{ 'slot-a': slotA === t.id }" title="设为对比 A（快捷键 A）" @click="assignSlot(t.id, 'A')">A</button>
            <button class="sm" :class="{ 'slot-b': slotB === t.id }" title="设为对比 B（快捷键 B）" @click="assignSlot(t.id, 'B')">B</button>
            <button class="sm ghost" title="把本 Take 的最后一帧作为下一镜头的首帧（Frame Bridge）" @click="onUseLastFrame(t.id)">↗ 尾帧作首帧</button>
            <button class="sm ghost" title="把本 Take 的首帧作为首帧参考" @click="onUseFirstFrame(t.id)">↗ 首帧作参考</button>
            <button v-if="aiEnabled" class="sm ghost" @click="onAiDiagnose(t.id)">AI 诊断</button>
          </div>

          <!-- failure tags, collapsible -->
          <div class="tag-area">
            <div class="row tag-head" @click="tagOpen[t.id] = !tagOpen[t.id]">
              <span class="muted">失败标记</span>
              <span v-if="t.failureTags.length" class="badge bad no-dot">{{ t.failureTags.length }}</span>
              <span class="muted chev-sm">{{ tagOpen[t.id] ? '▾' : '▸' }}</span>
            </div>
            <div v-if="tagOpen[t.id]" class="tags">
              <span
                v-for="tag in FAILURE_TAGS"
                :key="tag"
                class="tag"
                :class="{ active: t.failureTags.includes(tag) }"
                @click="toggleTag(t, tag)"
              >{{ tag }}</span>
            </div>
            <div v-else-if="t.failureTags.length" class="tags static">
              <span v-for="tag in t.failureTags" :key="tag" class="tag active">{{ tag }}</span>
            </div>
          </div>

          <textarea
            v-if="noteEdit === t.id"
            :value="t.notes"
            rows="2"
            placeholder="笔记 / 失败原因…"
            @blur="noteEdit = null"
            @input="onUpdate(t.id, { notes: ($event.target as HTMLTextAreaElement).value })"
          />
          <button v-else class="sm ghost note-btn" @click="noteEdit = t.id">{{ t.notes || '＋ 笔记' }}</button>
        </div>
      </div>
    </div>

    <div class="muted shortcuts">
      快捷键：点击封面聚焦 Take 后，<span class="kbd">S</span> 选片 · <span class="kbd">R</span> 拒片 · <span class="kbd">A</span>/<span class="kbd">B</span> 设定对比
    </div>
  </div>
</template>

<style scoped>
.file-input { display: none; }
.import-take-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px; border-style: dashed; }
.import-take-bar > div { display: grid; gap: 3px; min-width: 0; }
.import-take-bar strong { font-size: 13px; }
.import-take-bar span { color: var(--text-2); font-size: 11.5px; }
.import-take-bar button { flex: none; }
.import-take-bar .import-error { color: var(--bad); }
.takes { grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); }
.take { overflow: hidden; transition: border-color 0.15s, box-shadow 0.15s; }
.take.selected { border-color: var(--ok); box-shadow: 0 0 0 1px var(--ok), var(--shadow-1); }
.take.focused { border-color: var(--accent); }
.take.rejected { opacity: 0.55; }
.take.rejected:hover { opacity: 0.85; }
.take-cover { position: relative; height: 132px; background: var(--inset); display: flex; align-items: center; justify-content: center; cursor: pointer; overflow: hidden; }
.take-cover img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.25s; }
.take-cover:hover img { transform: scale(1.03); }
.status-badge { position: absolute; top: 6px; left: 6px; background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(2px); }
.dur-chip { position: absolute; bottom: 6px; right: 6px; font-size: 10.5px; color: #fff; background: rgba(0, 0, 0, 0.55); padding: 1px 6px; border-radius: 4px; }
.play-hint { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 26px; color: rgba(255,255,255,0.9); opacity: 0; transition: opacity 0.15s; text-shadow: 0 2px 8px rgba(0,0,0,0.6); }
.take-cover:hover .play-hint { opacity: 1; }
.take-body { padding: 10px 12px; }
.take-id { font-size: 11.5px; color: var(--text-2); }
.take-identity { min-width: 0; }
.stars { display: flex; gap: 1px; }
.star { color: var(--line-2); cursor: pointer; font-size: 14px; transition: color 0.1s, transform 0.1s; }
.star:hover { transform: scale(1.2); }
.star.on { color: var(--accent); }
.wrap { flex-wrap: wrap; }
.take-tools { gap: 4px; }
.slot-a { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); font-weight: 700; }
.slot-b { border-color: var(--info); color: var(--info); background: var(--info-soft); font-weight: 700; }
.tag-area { border-top: 1px dashed var(--line); padding-top: 6px; }
.tag-head { cursor: pointer; user-select: none; gap: 6px; }
.tag-head:hover .muted { color: var(--text); }
.chev-sm { font-size: 10px; }
.tags { display: flex; flex-wrap: wrap; margin-top: 4px; }
.note-btn { text-align: left; justify-content: flex-start; }
.takes-empty { padding: 20px 0; }
.compare-tray { border-color: var(--line-2); }
.compare-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; padding: 14px; }
.cmp-label { margin-top: 6px; }
.cmp-empty { display: flex; align-items: center; justify-content: center; min-height: 140px; border: 1.5px dashed var(--line-2); border-radius: var(--radius-sm); gap: 4px; }
.sync-toggle { gap: 5px; cursor: pointer; font-size: 12px; }
.sync-toggle input { width: auto; }
.commit-panel { border-color: var(--accent); }
.commit-intro { margin: 0; padding: 9px 11px; border-radius: var(--radius-sm); background: var(--accent-soft); color: var(--text-2); font-size: 12px; line-height: 1.55; }
.continuity-next-step { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 14px; border-color: var(--accent); background: var(--accent-soft); }
.continuity-next-step div { display: grid; gap: 3px; min-width: 0; }
.continuity-next-step span { color: var(--text-2); font-size: 12px; }
.continuity-next-step button { flex: none; }
.commit-grid { grid-template-columns: 1fr 1fr 1fr; }
.ai-continuity-assist { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid var(--info); border-radius: var(--radius-sm); background: var(--info-soft); }
.ai-continuity-assist div { display: grid; gap: 2px; min-width: 0; }
.ai-continuity-assist strong { font-size: 12.5px; }
.ai-continuity-assist span { color: var(--text-2); font-size: 11.5px; }
.ai-continuity-assist button { flex: none; }
.sec-caption { font-weight: 600; color: var(--text-2); margin-top: 4px; }
.char-block { border: 1px dashed var(--line); border-radius: var(--radius-sm); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.char-head select { width: auto; }
.shortcuts { display: flex; align-items: center; gap: 4px; padding-top: 4px; }
</style>
