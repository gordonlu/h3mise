<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { get, post, patch, del } from '../api/client';
import { useProjectStore } from '../stores/project';
import type { StoryBeat } from '@h3mise/shared';

const project = useProjectStore();
const story = ref<{ id: string; title: string; logline: string; synopsis: string; body: string } | null>(null);
const beats = ref<StoryBeat[]>([]);
const aiEnabled = ref(false);
const aiBusy = ref(false);
const notice = ref('');

const CATEGORIES = ['setup', 'inciting_incident', 'rising_action', 'climax', 'falling_action', 'resolution', 'transition', 'other'];

async function load() {
  story.value = await get('/api/story');
  beats.value = await get('/api/story/beats');
  await project.refreshProviders();
  aiEnabled.value = project.providers.some((p) => p.configured);
}

async function saveStory(patchData: Partial<typeof story.value>) {
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
  await del(`/api/story/beats/${id}`);
  beats.value = beats.value.filter((b) => b.id !== id);
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
  notice.value = '';
  try {
    const res = await post<{ jobId: string }>('/api/ai/actions/story_to_beats', {});
    for (let i = 0; i < 180; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const job = await get<{ status: string; result: unknown; error: string | null }>(`/api/jobs/${res.jobId}`);
      if (job.status === 'done') {
        const out = (job.result as { beats: Array<Omit<StoryBeat, 'id' | 'sequenceId' | 'order' | 'createdAt' | 'updatedAt'>> }).beats;
        for (const b of out) await post('/api/story/beats', b);
        await load();
        notice.value = `AI 拆解完成：新增 ${out.length} 个 StoryBeat（可手工调整）`;
        return;
      }
      if (job.status === 'failed') {
        notice.value = `AI 拆解失败：${job.error}`;
        return;
      }
    }
  } finally {
    aiBusy.value = false;
  }
}
</script>

<template>
  <div class="page">
    <div class="spread">
      <h1>Story</h1>
      <button v-if="aiEnabled" class="primary sm" :disabled="aiBusy" @click="aiStoryToBeats">{{ aiBusy ? 'AI 拆解中…' : 'AI 拆 StoryBeat' }}</button>
    </div>
    <p v-if="notice" class="badge info">{{ notice }}</p>

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
            <textarea :value="story?.body ?? ''" rows="10" @change="saveStory({ body: ($event.target as HTMLTextAreaElement).value })"></textarea>
          </label>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title spread">
          <span>StoryBeats</span>
          <button class="sm" @click="addBeat">＋ Beat</button>
        </div>
        <div class="panel-body col">
          <div v-if="!beats.length" class="muted">还没有 Beat。手工添加，或粘贴外部 AI 的 Shot List（在 Shots 页）。</div>
          <div v-for="(b, i) in beats" :key="b.id" class="beat panel">
            <div class="spread">
              <div class="row">
                <span class="mono muted">{{ String(i + 1).padStart(2, '0') }}</span>
                <input :value="b.title" class="beat-title" @change="updateBeat(b.id, { title: ($event.target as HTMLInputElement).value })" />
                <select :value="b.category" @change="updateBeat(b.id, { category: ($event.target as HTMLSelectElement).value as never })">
                  <option v-for="c in CATEGORIES" :key="c" :value="c">{{ c }}</option>
                </select>
              </div>
              <div class="row">
                <button class="sm ghost" @click="moveBeat(b.id, -1)">↑</button>
                <button class="sm ghost" @click="moveBeat(b.id, 1)">↓</button>
                <button class="sm danger" @click="removeBeat(b.id)">删</button>
              </div>
            </div>
            <textarea :value="b.summary" rows="2" placeholder="Beat 摘要 / 剧情事实" @change="updateBeat(b.id, { summary: ($event.target as HTMLTextAreaElement).value })"></textarea>
            <div class="row wrap muted">
              <input :value="b.location ?? ''" placeholder="地点" class="small" @change="updateBeat(b.id, { location: ($event.target as HTMLInputElement).value })" />
              <input :value="b.timeOfDay ?? ''" placeholder="时间" class="small" @change="updateBeat(b.id, { timeOfDay: ($event.target as HTMLInputElement).value })" />
              <input :value="b.weather ?? ''" placeholder="天气" class="small" @change="updateBeat(b.id, { weather: ($event.target as HTMLInputElement).value })" />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 24px 32px; max-width: 1200px; margin: 0 auto; }
h1 { font-size: 21px; margin: 0; }
.grid.top { grid-template-columns: 1fr 1.1fr; align-items: start; margin-top: 16px; }
.beat { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.beat-title { font-weight: 600; }
.small { width: 130px; }
</style>
