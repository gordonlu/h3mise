<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, toRaw } from 'vue';
import type { Take, VisualContinuityState } from '@h3mise/shared';
import { FAILURE_TAGS } from '@h3mise/shared';
import { takeVideoUrl, fileUrl } from '../../api/client';
import VideoPlayer from '../VideoPlayer.vue';

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
  entities: EntityLite[];
  characterStates: StateLite[];
  onSelect: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
  onUpdate: (id: string, patch: Partial<Take>) => Promise<void>;
  onAiDiagnose: (takeId: string) => Promise<void>;
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
const commitBusy = ref(false);
const commitForm = ref<VisualContinuityState>(emptyState());
const heldItemsText = ref<Record<string, string>>({});

const characters = computed(() => props.entities.filter((e) => e.kind === 'character'));
const vehicles = computed(() => props.entities.filter((e) => e.kind === 'vehicle'));

function statesOf(characterId: string): StateLite[] {
  return props.characterStates.filter((s) => s.characterId === characterId);
}

function openCommit(takeId: string) {
  commitTarget.value = takeId;
  commitForm.value = structuredClone(toRaw(props.actualState ?? emptyState()));
  // heldItems edited as comma-separated text per character.
  const ht: Record<string, string> = {};
  for (const [k, v] of Object.entries(commitForm.value.heldItems ?? {})) ht[k] = v.join(', ');
  heldItemsText.value = ht;
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
  if (k === 's' && t.status !== 'selected') { e.preventDefault(); void run(t.id, () => props.onSelect(t.id)); }
  else if (k === 'r' && t.status !== 'rejected') { e.preventDefault(); void run(t.id, () => props.onReject(t.id)); }
  else if (k === 'a') { e.preventDefault(); assignSlot(t.id, 'A'); }
  else if (k === 'b') { e.preventDefault(); assignSlot(t.id, 'B'); }
}

onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="col">
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
      </div>
    </div>

    <div v-if="!takes.length" class="muted takes-empty">还没有 Take。渲染完成后会出现在这里。</div>

    <!-- Select + Commit continuity form -->
    <div v-if="commitTarget" class="panel commit-panel">
      <div class="panel-title">选片 <span class="mono">{{ commitTarget }}</span> 并提交 Actual Visual Continuity</div>
      <div class="panel-body col">
        <div class="grid commit-grid">
          <label class="field">地点<input v-model="commitForm.location" placeholder="如：窄巷 / 天台 / 车内" /></label>
          <label class="field">时间<input v-model="commitForm.timeOfDay" placeholder="如 dusk / 03:00" /></label>
          <label class="field">天气<input v-model="commitForm.weather" placeholder="如：暴雨 / 晴 / 雾" /></label>
          <label class="field">风<input v-model="commitForm.wind" placeholder="如：3 级 / 无" /></label>
          <label class="field">银幕方向<input v-model="commitForm.screenDirection" placeholder="left-to-right" /></label>
          <label class="field">朝向<input v-model="commitForm.facing" placeholder="如：profile right" /></label>
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
              <label class="field">服装<input :value="commitForm.costume[ch.id] ?? ''" placeholder="wet_white_shirt" @input="commitForm.costume[ch.id] = ($event.target as HTMLInputElement).value" /></label>
              <label class="field">发型<input :value="commitForm.hair[ch.id] ?? ''" placeholder="wet" @input="commitForm.hair[ch.id] = ($event.target as HTMLInputElement).value" /></label>
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
          <button class="primary sm" :disabled="commitBusy" @click="doSelectCommit">{{ commitBusy ? '提交中…' : 'Select + Commit（选片并提交连续性）' }}</button>
          <button class="sm" @click="commitTarget = null">取消</button>
        </div>
        <p class="muted">只有 Selected Take 才能提交 Actual Continuity；NarrativeState 不受影响。</p>
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
            <span class="mono take-id">{{ t.id }}</span>
            <div class="stars" :title="`评分 ${t.rating ?? '—'}`">
              <span v-for="i in 5" :key="i" class="star" :class="{ on: (t.rating ?? 0) >= i }" @click="setRating(t, i)">★</span>
            </div>
          </div>

          <!-- contextual primary actions -->
          <div class="row wrap">
            <template v-if="t.status === 'candidate'">
              <button class="sm primary" :disabled="busyId === t.id" title="快捷键 S" @click="run(t.id, () => onSelect(t.id))">Select</button>
              <button class="sm" @click="openCommit(t.id)">选片+提交</button>
              <button class="sm danger ghost" title="快捷键 R" @click="run(t.id, () => onReject(t.id))">Reject</button>
            </template>
            <template v-else-if="t.status === 'selected'">
              <button class="sm" @click="openCommit(t.id)">提交连续性</button>
              <button class="sm danger ghost" @click="run(t.id, () => onReject(t.id))">取消选择</button>
            </template>
            <template v-else>
              <button class="sm" :disabled="busyId === t.id" @click="run(t.id, () => onUpdate(t.id, { status: 'candidate' }))">恢复为候选</button>
              <button class="sm primary" :disabled="busyId === t.id" @click="run(t.id, () => onSelect(t.id))">改选此条</button>
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
.commit-grid { grid-template-columns: 1fr 1fr 1fr; }
.sec-caption { font-weight: 600; color: var(--text-2); margin-top: 4px; }
.char-block { border: 1px dashed var(--line); border-radius: var(--radius-sm); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.char-head select { width: auto; }
.shortcuts { display: flex; align-items: center; gap: 4px; padding-top: 4px; }
</style>
