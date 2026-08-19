<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { get, post } from '../api/client';
import { useProjectStore } from '../stores/project';
import { H3_MODE_LABEL, H3_MODES, SHOT_STATUS_LABEL } from '@h3mise/shared';
import type { Shot } from '@h3mise/shared';

interface ShotCard extends Shot {
  takeCount: number;
  selectedTakeId: string | null;
  activeJobs: number;
  cover: string | null;
}

const project = useProjectStore();
const router = useRouter();
const shots = ref<ShotCard[]>([]);
const entities = ref<Array<{ id: string; name: string; kind: string }>>([]);
const showCreate = ref(false);
const showPaste = ref(false);
const newShot = ref({ title: '', purpose: '', shotFunction: 'wide', durationSeconds: 5, h3Mode: 't2va' });
const pasteText = ref('');
const pasteResult = ref('');
const busy = ref(false);
const filter = ref('');

/** PRD §15: only expose modes the active provider profile supports. */
const availableModes = computed(() => {
  const rh = project.providers.find((p) => p.id === 'runninghub' && p.configured);
  const active = rh ?? project.providers[0];
  if (active?.capabilities?.supportedModes?.length) return active.capabilities.supportedModes;
  return H3_MODES;
});

const STATUS_BADGE: Record<string, string> = {
  DRAFT: '',
  PLANNED: 'info',
  ASSETS_READY: 'info',
  DIRECTED: 'info',
  PREFLIGHT_READY: 'accent',
  RENDERING: 'warn',
  HAS_TAKES: '',
  SELECTED: 'ok',
  CONTINUITY_COMMITTED: 'ok',
  LOCKED: 'accent',
};

const filtered = computed(() => {
  if (!filter.value) return shots.value;
  const f = filter.value.toLowerCase();
  return shots.value.filter(
    (s) => s.title.toLowerCase().includes(f) || s.id.includes(f) || (s.purpose ?? '').toLowerCase().includes(f),
  );
});

function entityName(id: string | null): string {
  if (!id) return '—';
  return entities.value.find((e) => e.id === id)?.name ?? id;
}

async function load() {
  shots.value = await get<ShotCard[]>('/api/shots');
  entities.value = await get<Array<{ id: string; name: string; kind: string }>>('/api/assets/entities');
}

async function createShot() {
  busy.value = true;
  try {
    const shot = await post<Shot>('/api/shots', { ...newShot.value, h3Mode: newShot.value.h3Mode || null });
    showCreate.value = false;
    router.push(`/shots/${shot.id}`);
  } finally {
    busy.value = false;
  }
}

async function pasteShots() {
  busy.value = true;
  pasteResult.value = '';
  try {
    // Accept plain text lines or JSON/YAML-ish arrays.
    let items: Array<Record<string, unknown>> = [];
    const text = pasteText.value.trim();
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) items = parsed;
    } catch {
      items = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && !l.startsWith('-'))
        .map((l) => ({ title: l.replace(/^\d+[.、)\s]*/, '').slice(0, 60) }));
    }
    const res = await post<Shot[]>('/api/shots/bulk', { items });
    pasteResult.value = `已创建 ${res.length} 个 Shot`;
    pasteText.value = '';
    showPaste.value = false;
    await load();
  } catch (e) {
    pasteResult.value = `解析失败：${e instanceof Error ? e.message : e}`;
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="spread">
      <h1>Shotboard <span class="muted">{{ shots.length }} shots</span></h1>
      <div class="row">
        <input v-model="filter" placeholder="搜索 Shot…" class="search" />
        <button @click="showPaste = !showPaste">粘贴 Shot List</button>
        <button class="primary" @click="showCreate = !showCreate">+ 新建 Shot</button>
      </div>
    </div>

    <div v-if="showCreate" class="panel create-panel">
      <div class="panel-body col">
        <div class="row">
          <label class="field grow">
            标题
            <input v-model="newShot.title" placeholder="Shot 标题" />
          </label>
          <label class="field">
            H3 Mode
            <select v-model="newShot.h3Mode">
              <option v-for="m in availableModes" :key="m" :value="m">{{ m.toUpperCase() }}</option>
            </select>
          </label>
          <label class="field">
            时长
            <input v-model.number="newShot.durationSeconds" type="number" min="1" max="15" />
          </label>
        </div>
        <label class="field">
          目的
          <textarea v-model="newShot.purpose" rows="2" placeholder="这个镜头要完成什么？"></textarea>
        </label>
        <div class="row">
          <button class="primary" :disabled="busy" @click="createShot">创建并打开</button>
          <button @click="showCreate = false">取消</button>
        </div>
      </div>
    </div>

    <div v-if="showPaste" class="panel create-panel">
      <div class="panel-body col">
        <label class="field">
          粘贴外部 AI / 手工 Shot List（每行一个，或 JSON 数组）
          <textarea v-model="pasteText" rows="6" placeholder="1. 雨夜小巷，女子走入镜头&#10;2. 她在路灯下停步&#10;…"></textarea>
        </label>
        <div class="row">
          <button class="primary" :disabled="busy" @click="pasteShots">导入 Shots</button>
          <button @click="showPaste = false">取消</button>
        </div>
        <p v-if="pasteResult" class="badge info">{{ pasteResult }}</p>
      </div>
    </div>

    <div v-if="!shots.length" class="empty panel">
      <p class="muted">还没有 Shot。新建一个，或从外部 AI 粘贴 Shot List。</p>
    </div>

    <div class="board">
      <router-link v-for="(s, i) in filtered" :key="s.id" :to="`/shots/${s.id}`" class="card panel">
        <div class="cover" :class="{ 'no-cover': !s.cover }">
          <img v-if="s.cover" :src="`/api/file/${encodeURIComponent(s.cover)}`" :alt="s.title" />
          <span v-else class="muted cover-idx">SHOT {{ String(i + 1).padStart(2, '0') }}</span>
          <span v-if="s.activeJobs > 0" class="badge warn render-badge">生成中…</span>
          <span v-if="s.status === 'HAS_TAKES'" class="badge review-badge">待选片</span>
        </div>
        <div class="card-body">
          <div class="spread">
            <span class="card-title">{{ s.title || s.id }}</span>
            <span :class="['badge', STATUS_BADGE[s.status]]">{{ SHOT_STATUS_LABEL[s.status] }}</span>
          </div>
          <div class="row wrap muted">
            <span class="badge">{{ H3_MODE_LABEL[s.h3Mode ?? 't2va'] }}</span>
            <span class="badge">{{ s.durationSeconds }}s</span>
            <span class="badge">{{ s.shotFunction }}</span>
            <span v-if="s.primaryCharacterId" class="badge">{{ entityName(s.primaryCharacterId) }}</span>
          </div>
          <div class="muted purpose">{{ s.purpose || '—' }}</div>
          <div class="spread muted">
            <span>{{ s.takeCount }} Takes · {{ s.selectedTakeId ? '已选片' : '未选片' }}</span>
            <span class="mono">{{ s.id }}</span>
          </div>
        </div>
      </router-link>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 24px 32px; max-width: 1280px; margin: 0 auto; }
h1 { font-size: 21px; margin: 0; }
.search { width: 200px; }
.create-panel { margin: 16px 0; }
.board { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; margin-top: 18px; }
.card { display: block; text-decoration: none; color: inherit; overflow: hidden; transition: border-color 0.15s, transform 0.15s; }
.card:hover { border-color: var(--accent); transform: translateY(-1px); text-decoration: none; }
.cover { position: relative; height: 130px; background: var(--bg-3); display: flex; align-items: center; justify-content: center; overflow: hidden; }
.cover img { width: 100%; height: 100%; object-fit: cover; }
.cover-idx { font-family: var(--mono); letter-spacing: 0.2em; color: var(--text-3); }
.render-badge, .review-badge { position: absolute; top: 8px; right: 8px; }
.card-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.card-title { font-weight: 600; font-size: 14px; }
.purpose { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 36px; }
.wrap { flex-wrap: wrap; }
.empty { padding: 40px; text-align: center; }
</style>
