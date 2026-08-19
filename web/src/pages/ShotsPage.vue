<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { get, post, fileUrl } from '../api/client';
import { useProjectStore } from '../stores/project';
import { useToastStore } from '../stores/toast';
import { H3_MODE_LABEL, H3_MODES, SHOT_STATUS_LABEL, SHOT_USER_STATUS, SHOT_USER_STATUS_LABEL } from '@h3mise/shared';
import type { Shot, ShotStatus } from '@h3mise/shared';
import EmptyState from '../components/EmptyState.vue';

interface ShotCard extends Shot {
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
const shots = ref<ShotCard[]>([]);
const entities = ref<Array<{ id: string; name: string; kind: string }>>([]);
const showCreate = ref(false);
const showPaste = ref(false);
const newShot = ref({ title: '', purpose: '', shotFunction: 'wide', durationSeconds: 5, h3Mode: 't2va' });
const pasteText = ref('');
const busy = ref(false);
const filter = ref('');
const statusFilter = ref('');

/** PRD §15: only expose modes the active provider profile supports. */
const availableModes = computed(() => {
  const rh = project.providers.find((p) => p.id === 'runninghub' && p.configured);
  const active = rh ?? project.providers[0];
  if (active?.capabilities?.supportedModes?.length) return active.capabilities.supportedModes;
  return H3_MODES;
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
      items = text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && !l.startsWith('-'))
        .map((l) => ({ title: l.replace(/^\d+[.、)\s]*/, '').slice(0, 60) }));
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
      <h1>Shotboard <span class="muted">{{ shots.length }} shots</span></h1>
      <div class="row">
        <select v-model="statusFilter" class="status-filter" title="按状态筛选">
          <option value="">全部状态</option>
          <option v-for="(label, key) in SHOT_USER_STATUS_LABEL" :key="key" :value="key">{{ label }}</option>
        </select>
        <input v-model="filter" placeholder="搜索 Shot…" class="search" />
        <button @click="showPaste = !showPaste; showCreate = false">粘贴 Shot List</button>
        <button class="primary" @click="showCreate = !showCreate; showPaste = false">+ 新建 Shot</button>
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
          </div>
          <div class="row wrap">
            <span class="badge accent no-dot">{{ H3_MODE_LABEL[s.h3Mode ?? 't2va'] }}</span>
            <span class="badge no-dot">{{ s.durationSeconds }}s</span>
            <span class="badge no-dot">{{ s.shotFunction }}</span>
            <span v-if="entityName(s.primaryCharacterId)" class="badge no-dot">{{ entityName(s.primaryCharacterId) }}</span>
            <span v-if="entityName(s.sceneId)" class="badge info no-dot">{{ entityName(s.sceneId) }}</span>
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
.board { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 16px; margin-top: 18px; }
.card { display: block; text-decoration: none; color: inherit; overflow: hidden; transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s; }
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
</style>
