<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { get, post, patch, del } from '../api/client';
import { useProjectStore } from '../stores/project';
import { useToastStore } from '../stores/toast';
import { confirmDialog } from '../stores/confirm';
import { t } from '../stores/locale';
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
  try {
    const res = await post<{ jobId: string }>('/api/ai/actions/story_to_beats', {});
    for (let i = 0; i < 180; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const job = await get<{ status: string; result: unknown; error: string | null }>(`/api/jobs/${res.jobId}`);
      if (job.status === 'done') {
        const out = (job.result as { beats: Array<Omit<StoryBeat, 'id' | 'sequenceId' | 'order' | 'createdAt' | 'updatedAt'>> }).beats;
        for (const b of out) await post('/api/story/beats', b);
        await load();
        toasts.push({ kind: 'ok', text: t('pages.story.aiDone', { n: out.length }) });
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

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="spread page-head">
      <h1>{{ t('pages.story.title') }}</h1>
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

    <div class="grid story-grid">
      <div class="panel facts-panel">
        <div class="panel-title">{{ t('pages.story.subtitle') }}</div>
        <div class="panel-body col facts-body">
          <div class="grid two">
            <label class="field">
              {{ t('pages.story.titleField') }}
              <input :value="story?.title ?? ''" placeholder="故事标题" @change="saveStory({ title: ($event.target as HTMLInputElement).value })" />
            </label>
            <label class="field">
              {{ t('pages.story.logline') }}
              <input :value="story?.logline ?? ''" placeholder="一句话说清故事" @change="saveStory({ logline: ($event.target as HTMLInputElement).value })" />
            </label>
          </div>
          <label class="field">
            {{ t('pages.story.synopsis') }}
            <textarea :value="story?.synopsis ?? ''" rows="3" placeholder="三五行概括剧情走向" @change="saveStory({ synopsis: ($event.target as HTMLTextAreaElement).value })"></textarea>
          </label>
          <div class="script-frame">
            <div class="script-head">
              <span>正文稿</span>
              <span class="script-count mono">{{ story?.body ? story.body.length : 0 }} 字</span>
            </div>
            <textarea
              class="script-body"
              rows="16"
              placeholder="在此粘贴剧本 / 小说片段…"
              :value="story?.body ?? ''"
              @change="saveStory({ body: ($event.target as HTMLTextAreaElement).value })"
            ></textarea>
          </div>
        </div>
      </div>

      <div class="panel beats-panel">
        <div class="panel-title spread">
          <span>{{ t('pages.story.beats') }} <span class="muted">{{ beats.length }}</span></span>
          <button class="sm" @click="addBeat">{{ t('pages.story.newBeat') }}</button>
        </div>
        <div class="panel-body col">
          <EmptyState
            v-if="!beats.length"
            icon="✎"
            :title="t('pages.story.noBeatsTitle')"
            :desc="t('pages.story.noBeatsDesc')"
          >
            <button class="sm" @click="addBeat">{{ t('pages.story.newBeat') }}</button>
          </EmptyState>
          <div v-for="(b, i) in beats" :key="b.id" class="beat panel">
            <div class="spread">
              <div class="row beat-head">
                <span class="mono muted beat-idx">{{ String(i + 1).padStart(2, '0') }}</span>
                <input :value="b.title" class="beat-title" placeholder="Beat 标题" @change="updateBeat(b.id, { title: ($event.target as HTMLInputElement).value })" />
                <select :value="b.category" @change="updateBeat(b.id, { category: ($event.target as HTMLSelectElement).value as never })">
                  <option v-for="c in CATEGORIES" :key="c" :value="c">{{ c }}</option>
                </select>
              </div>
              <div class="row">
                <button class="sm ghost" title="上移" @click="moveBeat(b.id, -1)">↑</button>
                <button class="sm ghost" title="下移" @click="moveBeat(b.id, 1)">↓</button>
                <button class="sm danger ghost" @click="removeBeat(b.id)">{{ t('common.delete') }}</button>
              </div>
            </div>
            <textarea :value="b.summary" rows="2" :placeholder="t('pages.story.beatSummary')" @change="updateBeat(b.id, { summary: ($event.target as HTMLTextAreaElement).value })"></textarea>
            <div class="row wrap">
              <input :value="b.location ?? ''" :placeholder="t('pages.story.location')" class="small" @change="updateBeat(b.id, { location: ($event.target as HTMLInputElement).value })" />
              <input :value="b.timeOfDay ?? ''" :placeholder="t('pages.story.timeOfDay')" class="small" @change="updateBeat(b.id, { timeOfDay: ($event.target as HTMLInputElement).value })" />
              <input :value="b.weather ?? ''" :placeholder="t('pages.story.weather')" class="small" @change="updateBeat(b.id, { weather: ($event.target as HTMLInputElement).value })" />
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
h1 { font-size: 22px; margin: 0; font-family: var(--serif); }
.story-grid { grid-template-columns: 1fr 1.15fr; align-items: start; }
@media (max-width: 1000px) { .story-grid { grid-template-columns: 1fr; } }
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
.beats-panel { align-self: start; }
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