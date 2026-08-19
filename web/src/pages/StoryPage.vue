<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { get, post, patch, del } from '../api/client';
import { useProjectStore } from '../stores/project';
import { useToastStore } from '../stores/toast';
import { confirmDialog } from '../stores/confirm';
import type { StoryBeat } from '@h3mise/shared';
import EmptyState from '../components/EmptyState.vue';

const project = useProjectStore();
const toasts = useToastStore();
const story = ref<{ id: string; title: string; logline: string; synopsis: string; body: string } | null>(null);
const beats = ref<StoryBeat[]>([]);
const shots = ref<Array<{ id: string; title: string; storyBeatId: string | null }>>([]);
const aiEnabled = ref(false);
const aiBusy = ref(false);

const CATEGORIES = ['setup', 'inciting_incident', 'rising_action', 'climax', 'falling_action', 'resolution', 'transition', 'other'];

/** Beat → linked shots (PRD: StoryBeat converts to executable Shots). */
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

async function load() {
  story.value = await get('/api/story');
  beats.value = await get('/api/story/beats');
  shots.value = await get('/api/shots');
  await project.refreshProviders();
  aiEnabled.value = project.providers.some((p) => p.configured);
}

async function saveStory(patchData: Partial<NonNullable<typeof story.value>>) {
  story.value = await patch('/api/story', patchData);
}

async function addBeat() {
  const b = await post<StoryBeat>('/api/story/beats', { title: 'New Beat', category: 'other' });
  beats.value = [...beats.value, b];
}

async function updateBeat(id: string, patchData: Partial<StoryBeat>) {
  beats.value = beats.value.map((b) => (b.id === id ? { ...b, ...patchData } : b));
  await patch(`/api/story/beats/${id}`, patchData);
}

async function removeBeat(id: string) {
  const linked = beatShots.value.get(id)?.length ?? 0;
  const ok = await confirmDialog({
    title: '删除 StoryBeat？',
    message: linked ? `该 Beat 已关联 ${linked} 个 Shot（关联会被解除，Shot 本身保留）。` : '删除后不可恢复。',
    confirmLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  await del(`/api/story/beats/${id}`);
  beats.value = beats.value.filter((b) => b.id !== id);
  toasts.push({ kind: 'ok', text: 'Beat 已删除' });
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
  if (!aiEnabled.value) return;
  aiBusy.value = true;
  try {
    const res = await post<{ jobId: string }>('/api/ai/actions/story_to_beats', {});
    for (let i = 0; i < 180; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const job = await get<{ status: string; result: unknown; error: string | null }>(`/api/jobs/${res.jobId}`);
      if (job.status === 'done') {
        const out = (job.result as { beats: Array<Omit<StoryBeat, 'id' | 'sequenceId' | 'order' | 'createdAt' | 'updatedAt'>> }).beats;
        for (const b of out) await post('/api/story/beats', b);
        await load();
        toasts.push({ kind: 'ok', text: `AI 拆解完成：新增 ${out.length} 个 StoryBeat（可手工调整）` });
        return;
      }
      if (job.status === 'failed') {
        toasts.push({ kind: 'err', text: `AI 拆解失败：${job.error}` });
        return;
      }
    }
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
  } finally {
    aiBusy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="spread">
      <h1>Story</h1>
      <button v-if="aiEnabled" class="primary sm" :disabled="aiBusy" @click="aiStoryToBeats">{{ aiBusy ? 'AI 拆解中…' : 'AI 拆 StoryBeat' }}</button>
    </div>

    <div class="grid top">
      <div class="panel">
        <div class="panel-title">故事事实层（不是 Prompt）</div>
        <div class="panel-body col">
          <label class="field">
            标题
            <input :value="story?.title ?? ''" @change="saveStory({ title: ($event.target as HTMLInputElement).value })" />
          </label>
          <label class="field">
            Logline 一句话
            <input :value="story?.logline ?? ''" @change="saveStory({ logline: ($event.target as HTMLInputElement).value })" />
          </label>
          <label class="field">
            Synopsis 梗概
            <textarea :value="story?.synopsis ?? ''" rows="3" @change="saveStory({ synopsis: ($event.target as HTMLTextAreaElement).value })"></textarea>
          </label>
          <label class="field">
            正文 / 剧本 / 小说片段（供拆解与外部 AI 使用）
            <textarea :value="story?.body ?? ''" rows="12" @change="saveStory({ body: ($event.target as HTMLTextAreaElement).value })"></textarea>
          </label>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title spread">
          <span>StoryBeats <span class="muted">{{ beats.length }}</span></span>
          <button class="sm" @click="addBeat">＋ Beat</button>
        </div>
        <div class="panel-body col">
          <EmptyState
            v-if="!beats.length"
            icon="✎"
            title="还没有 Beat"
            desc="手工添加 Beat，或在 Shots 页粘贴外部 AI 的 Shot List；配置内置 AI 后可一键拆解。"
          >
            <button class="sm" @click="addBeat">＋ 添加 Beat</button>
          </EmptyState>
          <div v-for="(b, i) in beats" :key="b.id" class="beat panel">
            <div class="spread">
              <div class="row beat-head">
                <span class="mono muted beat-idx">{{ String(i + 1).padStart(2, '0') }}</span>
                <input :value="b.title" class="beat-title" @change="updateBeat(b.id, { title: ($event.target as HTMLInputElement).value })" />
                <select :value="b.category" @change="updateBeat(b.id, { category: ($event.target as HTMLSelectElement).value as never })">
                  <option v-for="c in CATEGORIES" :key="c" :value="c">{{ c }}</option>
                </select>
              </div>
              <div class="row">
                <button class="sm ghost" title="上移" @click="moveBeat(b.id, -1)">↑</button>
                <button class="sm ghost" title="下移" @click="moveBeat(b.id, 1)">↓</button>
                <button class="sm danger ghost" @click="removeBeat(b.id)">删</button>
              </div>
            </div>
            <textarea :value="b.summary" rows="2" placeholder="Beat 摘要 / 剧情事实" @change="updateBeat(b.id, { summary: ($event.target as HTMLTextAreaElement).value })"></textarea>
            <div class="row wrap">
              <input :value="b.location ?? ''" placeholder="地点" class="small" @change="updateBeat(b.id, { location: ($event.target as HTMLInputElement).value })" />
              <input :value="b.timeOfDay ?? ''" placeholder="时间" class="small" @change="updateBeat(b.id, { timeOfDay: ($event.target as HTMLInputElement).value })" />
              <input :value="b.weather ?? ''" placeholder="天气" class="small" @change="updateBeat(b.id, { weather: ($event.target as HTMLInputElement).value })" />
            </div>
            <!-- Beat → Shot linkage -->
            <div v-if="beatShots.get(b.id)?.length" class="row wrap beat-shots">
              <span class="muted">已拆 Shot：</span>
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
h1 { font-size: 22px; margin: 0 0 16px; font-family: var(--serif); }
.grid.top { grid-template-columns: 1fr 1.15fr; align-items: start; margin-top: 8px; }
@media (max-width: 1000px) { .grid.top { grid-template-columns: 1fr; } }
.beat { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.beat-head { flex-wrap: wrap; }
.beat-idx { font-size: 11px; }
.beat-title { font-weight: 600; width: 200px; }
.small { width: 120px; }
.wrap { flex-wrap: wrap; }
.beat-shots { border-top: 1px dashed var(--line); padding-top: 7px; gap: 5px; }
.shot-link { text-decoration: none; }
.shot-link:hover { text-decoration: none; filter: brightness(1.1); }
</style>
