<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { get, post, patch, del } from '../api/client';
import { useToastStore } from '../stores/toast';
import { confirmDialog } from '../stores/confirm';
import { t } from '../stores/locale';
import type { SkeletonRecommendation, SkeletonRecommendationResult, SkeletonSegmentCount, StoryBeat, StorySkeleton } from '@h3mise/shared';
import EmptyState from '../components/EmptyState.vue';

const toasts = useToastStore();
const story = ref<{ id: string; title: string; synopsis: string; body: string; plannedDurationSeconds: number } | null>(null);
const beats = ref<StoryBeat[]>([]);
const shots = ref<Array<{ id: string; title: string; storyBeatId: string | null }>>([]);
const aiEnabled = ref(false);
const aiBusy = ref(false);
const skeletonOpen = ref(false);
const skeletonBusy = ref(false);
const skeletonTheme = ref('');
const skeletonCount = ref<SkeletonSegmentCount>(6);
const skeletons = ref<StorySkeleton[]>([]);
const skeletonRecommendations = ref<SkeletonRecommendation[]>([]);
const skeletonMode = ref<SkeletonRecommendationResult['mode']>('local');

const CATEGORIES = ['setup', 'inciting_incident', 'rising_action', 'climax', 'falling_action', 'resolution', 'transition', 'other'];
const CATEGORY_LABEL: Record<string, string> = {
  setup: '铺垫',
  inciting_incident: '激励事件',
  rising_action: '上升行动',
  climax: '高潮',
  falling_action: '下降行动',
  resolution: '收束',
  transition: '过渡',
  other: '其他',
};

/** Beat → linked shots. */
const beatShots = computed(() => {
  const map = new Map<string, Array<{ id: string; title: string }>>();
  for (const s of shots.value) {
    if (!s.storyBeatId) continue;
    const arr = map.get(s.storyBeatId) ?? [];
    arr.push({ id: s.id, title: s.title });
    map.set(s.storyBeatId, arr);
  }
  return map;
});

/** AI split needs a non-empty story body. */
const canAiSplit = computed(() => Boolean(story.value?.body?.trim()) && !aiBusy.value);

async function load() {
  const [loadedStory, loadedBeats, loadedShots, aiStatus] = await Promise.all([
    get<typeof story.value>('/api/story'),
    get<StoryBeat[]>('/api/story/beats'),
    get<typeof shots.value>('/api/shots'),
    get<{ configured: boolean }>('/api/ai/status').catch(() => ({ configured: false })),
  ]);
  story.value = loadedStory;
  beats.value = loadedBeats;
  shots.value = loadedShots;
  aiEnabled.value = aiStatus.configured;
}

async function saveStory(patchData: Partial<NonNullable<typeof story.value>>) {
  try {
    story.value = await patch('/api/story', patchData);
    toasts.push({ kind: 'ok', text: '已保存' });
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : '保存失败' });
  }
}

async function addBeat() {
  const b = await post<StoryBeat>('/api/story/beats', { title: 'New Beat', category: 'other' });
  beats.value = [...beats.value, b];
}

async function updateBeat(id: string, patchData: Partial<StoryBeat>) {
  const before = beats.value;
  beats.value = beats.value.map((b) => (b.id === id ? { ...b, ...patchData } : b));
  try {
    const saved = await patch<StoryBeat & { shotsSynced?: number; shotsSkipped?: number }>(`/api/story/beats/${id}`, patchData);
    beats.value = beats.value.map((b) => (b.id === id ? saved : b));
    if (saved.shotsSynced != null) {
      const parts = [`已保存`];
      if (saved.shotsSynced > 0) parts.push(`同步 ${saved.shotsSynced} 个镜头时长`);
      if ((saved.shotsSkipped ?? 0) > 0) parts.push(`${saved.shotsSkipped} 个镜头为手动时长未动`);
      toasts.push({ kind: 'ok', text: parts.join('，') });
    }
  } catch (e) {
    beats.value = before;
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : '节拍保存失败' });
  }
}

/** Draft-based editing: inputs write into local drafts; an explicit save
 * button commits them. Avoids the invisible "saved on blur" behavior. */
const storyDraft = ref({ title: '', plannedDurationSeconds: '', synopsis: '', body: '' });
function syncStoryDraft() {
  storyDraft.value = {
    title: story.value?.title ?? '',
    plannedDurationSeconds: story.value?.plannedDurationSeconds != null ? String(story.value.plannedDurationSeconds) : '',
    synopsis: story.value?.synopsis ?? '',
    body: story.value?.body ?? '',
  };
}
watch(story, syncStoryDraft, { immediate: true });

const storyDirty = computed(() => {
  if (!story.value) return false;
  const d = storyDraft.value;
  return (
    d.title !== (story.value.title ?? '') ||
    (Number(d.plannedDurationSeconds) || 0) !== (story.value.plannedDurationSeconds ?? 0) ||
    d.synopsis !== (story.value.synopsis ?? '') ||
    d.body !== (story.value.body ?? '')
  );
});

async function saveStoryDraft() {
  await saveStory({
    title: storyDraft.value.title,
    plannedDurationSeconds: Number(storyDraft.value.plannedDurationSeconds) || 0,
    synopsis: storyDraft.value.synopsis,
    body: storyDraft.value.body,
  });
  syncStoryDraft();
}

const beatDrafts = ref<Record<string, { title?: string; category?: string; durationSeconds?: number }>>({});
function beatValue(b: StoryBeat) {
  const d = beatDrafts.value[b.id] ?? {};
  return { ...b, ...d } as StoryBeat;
}
function setBeatDraft(id: string, patch: { title?: string; category?: string; durationSeconds?: number }) {
  beatDrafts.value = { ...beatDrafts.value, [id]: { ...(beatDrafts.value[id] ?? {}), ...patch } };
}
function beatDirty(id: string): boolean {
  const d = beatDrafts.value[id];
  if (!d) return false;
  const b = beats.value.find((x) => x.id === id);
  if (!b) return false;
  return Object.entries(d).some(([k, v]) => (b as unknown as Record<string, unknown>)[k] !== v);
}
async function saveBeatDraft(id: string) {
  const d = beatDrafts.value[id];
  if (!d) return;
  await updateBeat(id, d as Partial<StoryBeat>);
  const rest = { ...beatDrafts.value };
  delete rest[id];
  beatDrafts.value = rest;
}

async function removeBeat(id: string) {
  const linked = beatShots.value.get(id)?.length ?? 0;
  const ok = await confirmDialog({
    title: t('pages.story.deleteBeatTitle'),
    message: linked
      ? `${t('pages.story.deleteBeatLinked', { n: linked })} ${t('pages.story.deleteBeatMsg')}`
      : t('pages.story.deleteBeatMsg'),
    confirmLabel: t('common.delete'),
    danger: true,
  });
  if (!ok) return;
  await del(`/api/story/beats/${id}`);
  beats.value = beats.value.filter((b) => b.id !== id);
  toasts.push({ kind: 'ok', text: t('pages.story.beatDeleted') });
}

async function moveBeat(id: string, dir: -1 | 1) {
  const idx = beats.value.findIndex((b) => b.id === id);
  const target = idx + dir;
  if (target < 0 || target >= beats.value.length) return;
  const next = [...beats.value];
  [next[idx], next[target]] = [next[target]!, next[idx]!];
  beats.value = next;
  await post('/api/story/beats/reorder', { ids: next.map((b) => b.id) });
}

async function aiStoryToBeats() {
  if (!aiEnabled.value || aiBusy.value) return;
  if (!story.value?.body?.trim()) {
    toasts.push({ kind: 'err', text: t('pages.story.aiSplitEmpty') });
    return;
  }
  const ok = await confirmDialog({
    title: t('pages.story.aiSplit'),
    message: t('pages.story.aiSplitConfirm'),
    confirmLabel: t('pages.story.aiSplit'),
  });
  if (!ok) return;
  aiBusy.value = true;
  toasts.push({ kind: 'info', text: 'AI 拆解已提交，后台处理中（通常 10–60 秒，最长 3 分钟）…' });
  try {
    const res = await post<{ jobId: string }>('/api/ai/actions/story_to_beats', {});
    for (let i = 0; i < 180; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const job = await get<{ status: string; result: unknown; error: string | null }>(`/api/jobs/${res.jobId}`);
      if (job.status === 'done') {
        const out = (job.result as { beats: Array<Omit<StoryBeat, 'id' | 'sequenceId' | 'order' | 'createdAt' | 'updatedAt'>> }).beats;
        let shotsCreated = 0;
        for (const b of out) {
          const beat = await post<{ id: string }>('/api/story/beats', b);
          await post('/api/shots', {
            title: b.title ?? 'New Beat',
            storyBeatId: beat.id,
            purpose: b.summary,
            durationSeconds: b.durationSeconds ?? 5,
          });
          shotsCreated++;
        }
        await load();
        toasts.push({ kind: 'ok', text: `拆解完成：${out.length} 个节拍，并已自动生成 ${shotsCreated} 个 Shot（可到 Shotboard 继续导演计划与生成）` });
        return;
      }
      if (job.status === 'failed') {
        toasts.push({ kind: 'err', text: t('pages.story.aiFailed', { msg: job.error ?? 'unknown' }) });
        return;
      }
    }
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  } finally {
    aiBusy.value = false;
  }
}

async function openSkeletons() {
  skeletonOpen.value = !skeletonOpen.value;
  if (!skeletonOpen.value || skeletons.value.length) return;
  try {
    skeletons.value = await get<StorySkeleton[]>('/api/story/skeletons');
    skeletonRecommendations.value = skeletons.value.slice(0, 3).map((skeleton, index) => ({ skeleton, score: 1 - index * 0.01, reason: '内置通用节奏骨架' }));
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  }
}

async function recommendSkeletons() {
  skeletonBusy.value = true;
  try {
    const result = await post<SkeletonRecommendationResult>('/api/story/skeletons/recommend', { theme: skeletonTheme.value });
    skeletonRecommendations.value = result.recommendations;
    skeletonMode.value = result.mode;
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  } finally {
    skeletonBusy.value = false;
  }
}

async function applyStorySkeleton(skeleton: StorySkeleton) {
  const ok = await confirmDialog({
    title: `套用「${skeleton.name}」`,
    message: `将追加 ${skeletonCount.value} 个 Beat 草稿${beats.value.length ? `；当前已有 ${beats.value.length} 个 Beat，不会覆盖` : ''}。不会创建 Shot，也不会调用付费 API。`,
    confirmLabel: '追加 Beat 草稿',
  });
  if (!ok) return;
  try {
    await post(`/api/story/skeletons/${skeleton.id}/apply`, { segmentCount: skeletonCount.value });
    await load();
    skeletonOpen.value = false;
    toasts.push({ kind: 'ok', text: `已追加 ${skeletonCount.value} 个「${skeleton.name}」Beat 草稿` });
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="spread page-head">
      <h1>{{ t('pages.story.title') }}</h1>
      <div class="row">
        <button class="sm" @click="openSkeletons">{{ skeletonOpen ? '收起灵感' : '找节奏灵感' }}</button>
        <RouterLink class="button-link sm" to="/storyboard">可选：生成 Storyboard →</RouterLink>
        <button
          v-if="aiEnabled"
          class="primary sm"
          :disabled="!canAiSplit"
          :title="!story?.body?.trim() ? t('pages.story.aiSplitEmpty') : ''"
          @click="aiStoryToBeats"
        >
          {{ aiBusy ? t('pages.story.aiSplitting') : t('pages.story.aiSplit') }}
        </button>
      </div>
    </div>

    <section v-if="skeletonOpen" class="panel skeleton-browser">
      <div class="panel-title spread"><span>短剧叙事骨架</span><span class="muted">骨架免费内置，AI 只增强推荐</span></div>
      <div class="panel-body col">
        <div class="skeleton-search">
          <label class="field grow">你的主题或冲突<input v-model="skeletonTheme" placeholder="例如：职场新人被领导抢功，最后拿出证据" @keyup.enter="recommendSkeletons" /></label>
          <label class="field count-field">Beat 数<select v-model="skeletonCount"><option :value="3">3 段</option><option :value="6">6 段</option><option :value="9">9 段</option></select></label>
          <button class="primary" :disabled="skeletonBusy" @click="recommendSkeletons">{{ skeletonBusy ? '匹配中…' : '推荐骨架' }}</button>
        </div>
        <div class="spread">
          <span class="muted">{{ skeletonMode === 'ai' ? 'AI 语义推荐' : skeletonMode === 'local_fallback' ? 'AI 不可用，已回退本地匹配' : '本地标签匹配' }}</span>
          <button class="sm ghost" @click="skeletonRecommendations = skeletons.map((skeleton, index) => ({ skeleton, score: 1 - index * 0.01, reason: '全部骨架' }))">查看全部</button>
        </div>
        <div class="skeleton-grid">
          <article v-for="item in skeletonRecommendations" :key="item.skeleton.id" class="skeleton-card">
            <div class="spread"><strong>{{ item.skeleton.name }}</strong><span class="badge">{{ item.skeleton.group === 'high_tension' ? '高压兑现' : item.skeleton.group === 'comedy' ? '喜剧' : item.skeleton.group === 'suspense' ? '悬疑' : '情感' }}</span></div>
            <p>{{ item.skeleton.description }}</p>
            <div class="muted match-reason">{{ item.reason }}</div>
            <ol class="skeleton-preview">
              <li v-for="segment in item.skeleton.variants[skeletonCount]" :key="segment.title"><strong>{{ segment.title }}</strong><span>{{ segment.purpose }}</span></li>
            </ol>
            <button class="sm primary" @click="applyStorySkeleton(item.skeleton)">套用为 {{ skeletonCount }} 个 Beat 草稿</button>
          </article>
        </div>
      </div>
    </section>

    <div class="grid story-grid">
      <div class="panel facts-panel">
        <div class="panel-title">{{ t('pages.story.subtitle') }}</div>
        <div class="panel-body col facts-body">
          <div class="spread">
            <span class="muted">修改后点击「保存」提交</span>
            <button class="primary sm" :disabled="!storyDirty" @click="saveStoryDraft">保存故事</button>
          </div>
          <div class="grid two">
          <label class="field">
            {{ t('pages.story.titleField') }}
            <input v-model="storyDraft.title" :disabled="aiBusy" placeholder="故事标题" />
          </label>
          <label class="field">
            规划总时长 (s)
            <input v-model="storyDraft.plannedDurationSeconds" :disabled="aiBusy" type="number" min="0" max="900" placeholder="如 90（AI 拆解按此分配节拍时长）" />
          </label>
        </div>
          <label class="field">
            {{ t('pages.story.synopsis') }}
            <textarea v-model="storyDraft.synopsis" :disabled="aiBusy" class="field-synopsis" rows="6" placeholder="剧情梗概：主角是谁、发生什么、如何收场（供 AI 拆解使用）"></textarea>
          </label>
          <div class="script-frame">
            <div class="script-head">
              <span>正文稿</span>
              <span class="script-count mono">{{ storyDraft.body.length }} 字</span>
            </div>
            <textarea
              v-model="storyDraft.body"
              class="script-body"
              rows="16"
              :disabled="aiBusy"
              placeholder="在此粘贴剧本 / 小说片段…"
            ></textarea>
          </div>
        </div>
      </div>

      <div class="panel beats-panel">
        <div class="panel-title spread">
          <span>{{ t('pages.story.beats') }} <span class="muted">{{ beats.length }}</span>
            <span v-if="story?.plannedDurationSeconds" class="muted plan-hint">{{ beats.reduce((acc, b) => acc + (b.durationSeconds || 0), 0) }} / {{ story.plannedDurationSeconds }}s 已规划</span>
          </span>
          <button class="sm" :disabled="aiBusy" @click="addBeat">{{ t('pages.story.newBeat') }}</button>
        </div>
        <div class="panel-body col">
          <EmptyState
            v-if="!beats.length"
            icon="✎"
            :title="t('pages.story.noBeatsTitle')"
            :desc="t('pages.story.noBeatsDesc')"
          >
            <button class="sm" :disabled="aiBusy" @click="addBeat">{{ t('pages.story.newBeat') }}</button>
          </EmptyState>
          <div v-for="(b, i) in beats" :key="b.id" class="beat panel">
            <div class="spread">
              <div class="row beat-head">
                <span class="mono muted beat-idx">{{ String(i + 1).padStart(2, '0') }}</span>
                <input :value="beatValue(b).title" :disabled="aiBusy" class="beat-title" placeholder="Beat 标题" @input="setBeatDraft(b.id, { title: ($event.target as HTMLInputElement).value })" />
                <input :value="beatValue(b).durationSeconds" :disabled="aiBusy" type="number" min="1" max="60" class="beat-dur" title="节拍时长（秒）" @input="setBeatDraft(b.id, { durationSeconds: Number(($event.target as HTMLInputElement).value) || 5 })" />
                <button v-if="beatDirty(b.id)" class="sm primary" @click="saveBeatDraft(b.id)">保存</button>
                <select :value="beatValue(b).category" :disabled="aiBusy" @change="setBeatDraft(b.id, { category: ($event.target as HTMLSelectElement).value as never })">
                  <option v-for="c in CATEGORIES" :key="c" :value="c">{{ CATEGORY_LABEL[c] ?? c }}</option>
                </select>
              </div>
              <div class="row">
                <button class="sm ghost" :disabled="aiBusy" title="上移" @click="moveBeat(b.id, -1)">↑</button>
                <button class="sm ghost" :disabled="aiBusy" title="下移" @click="moveBeat(b.id, 1)">↓</button>
                <button class="sm danger ghost" :disabled="aiBusy" @click="removeBeat(b.id)">{{ t('common.delete') }}</button>
              </div>
            </div>
            <textarea :value="b.summary" :disabled="aiBusy" rows="5" :placeholder="t('pages.story.beatSummary')" @change="updateBeat(b.id, { summary: ($event.target as HTMLTextAreaElement).value })"></textarea>
            <div class="row wrap">
              <input :value="b.location ?? ''" :disabled="aiBusy" :placeholder="t('pages.story.location')" class="small" @change="updateBeat(b.id, { location: ($event.target as HTMLInputElement).value })" />
              <input :value="b.timeOfDay ?? ''" :disabled="aiBusy" :placeholder="t('pages.story.timeOfDay')" class="small" @change="updateBeat(b.id, { timeOfDay: ($event.target as HTMLInputElement).value })" />
              <input :value="b.weather ?? ''" :disabled="aiBusy" :placeholder="t('pages.story.weather')" class="small" @change="updateBeat(b.id, { weather: ($event.target as HTMLInputElement).value })" />
            </div>
            <div v-if="beatShots.get(b.id)?.length" class="row wrap beat-shots">
              <span class="muted">{{ t('pages.story.splitShots') }}：</span>
              <router-link v-for="s in beatShots.get(b.id)" :key="s.id" :to="`/shots/${s.id}`" class="badge info no-dot shot-link">
                {{ s.title || s.id }}
              </router-link>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 24px 32px; max-width: 1280px; margin: 0 auto; }
.page-head { margin-bottom: 14px; }
.skeleton-browser { margin-bottom: 14px; }.skeleton-search { display: flex; align-items: end; gap: 10px; }.skeleton-search .grow { flex: 1; }.count-field { width: 100px; }.skeleton-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 10px; }.skeleton-card { display: flex; flex-direction: column; gap: 9px; padding: 14px; border: 1px solid var(--line-2); border-radius: var(--radius); background: var(--bg-2); }.skeleton-card p { margin: 0; line-height: 1.6; }.match-reason { font-size: 11px; }.skeleton-preview { display: grid; gap: 6px; margin: 0; padding-left: 20px; font-size: 12px; }.skeleton-preview li { padding-left: 3px; }.skeleton-preview strong,.skeleton-preview span { display: block; }.skeleton-preview span { color: var(--muted); line-height: 1.45; }
h1 { font-size: 22px; margin: 0; font-family: var(--serif); }
.story-grid { grid-template-columns: 1fr 1.15fr; align-items: start; }
@media (max-width: 1000px) { .story-grid,.skeleton-grid { grid-template-columns: 1fr; }.skeleton-search { align-items: stretch; flex-direction: column; }.count-field { width: 100%; } }
.facts-panel { align-self: start; }
.facts-body { padding: 18px; gap: 14px; }
.grid.two { grid-template-columns: 1fr 1fr; gap: 14px; }
/* script sheet: serif body inside a bordered frame with an orange focus ring */
.script-frame {
  border: 1px solid var(--line-2);
  border-radius: 10px;
  background: var(--bg-4);
  padding: 12px 16px 14px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.script-frame:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(255, 108, 55, 0.12);
}
.script-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-2);
  padding-bottom: 9px;
  border-bottom: 1px dashed var(--line);
  margin-bottom: 10px;
}
.script-count { font-size: 11px; color: var(--text-3); font-weight: 400; }
.script-body {
  width: 100%;
  border: none;
  background: transparent;
  box-shadow: none;
  padding: 0;
  border-radius: 0;
  font-family: var(--serif);
  font-size: 14.5px;
  line-height: 1.9;
  color: var(--text);
  resize: vertical;
  min-height: 240px;
}
.script-body:focus { border: none; box-shadow: none; }
.script-body::placeholder { color: var(--text-3); font-family: var(--serif); }
.field-synopsis { font-family: var(--serif); font-size: 14.5px; line-height: 1.9; min-height: 140px; }
.beats-panel { align-self: start; }
.beat-dur { width: 58px; }
.plan-hint { font-size: 11px; margin-left: 6px; }
.beat { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.beat-head { flex-wrap: wrap; }
.beat-idx { font-size: 11px; }
.beat-title { font-weight: 600; width: 200px; }
.small { width: 120px; }
.wrap { flex-wrap: wrap; }
.beat-shots { border-top: 1px dashed var(--line); padding-top: 7px; gap: 5px; }
.shot-link { text-decoration: none; }
.shot-link:hover { text-decoration: none; filter: brightness(1.05); }
</style>
