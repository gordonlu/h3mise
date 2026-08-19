<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { get, post, del, mediaUrl, fileUrl } from '../api/client';
import { useToastStore } from '../stores/toast';
import { t } from '../stores/locale';
import { confirmDialog } from '../stores/confirm';
import type { CharacterState, Entity, MediaAsset, ReferenceBinding } from '@h3mise/shared';
import EmptyState from '../components/EmptyState.vue';

const tab = ref<'entities' | 'states' | 'media' | 'bindings'>('entities');
const toasts = useToastStore();
const entities = ref<Entity[]>([]);
const states = ref<CharacterState[]>([]);
const media = ref<MediaAsset[]>([]);
const bindings = ref<ReferenceBinding[]>([]);
const kindFilter = ref('');

const KINDS = ['character', 'scene', 'prop', 'vehicle', 'creature'];
const KIND_LABEL: Record<string, string> = { character: '角色', scene: '场景', prop: '道具', vehicle: '载具', creature: '生物' };

const newEntity = ref({ kind: 'character', name: '', description: '' });
const newState = ref({ characterId: '', name: '', costume: '', hair: '', injury: '', heldItems: '' });
const importPath = ref('');
const importing = ref(false);

async function load() {
  entities.value = await get<Entity[]>('/api/assets/entities');
  states.value = await get<CharacterState[]>('/api/assets/character-states');
  media.value = await get<MediaAsset[]>('/api/assets/media');
  bindings.value = await get<ReferenceBinding[]>('/api/assets/bindings?shotId=null');
  if (!newState.value.characterId && entities.value.some((e) => e.kind === 'character')) {
    newState.value.characterId = entities.value.find((e) => e.kind === 'character')!.id;
  }
}

async function createEntity() {
  await post('/api/assets/entities', newEntity.value);
  toasts.push({ kind: 'ok', text: `实体「${newEntity.value.name}」已创建` });
  newEntity.value = { kind: 'character', name: '', description: '' };
  await load();
}

async function removeEntity(e: Entity) {
  const ok = await confirmDialog({
    title: `删除实体「${e.name}」？`,
    message: '关联的 CharacterState 会一并删除；已绑定的 Reference 会解除。删除后不可恢复。',
    confirmLabel: '删除',
    danger: true,
  });
  if (!ok) return;
  await del(`/api/assets/entities/${e.id}`);
  toasts.push({ kind: 'ok', text: `实体「${e.name}」已删除` });
  await load();
}

async function createState() {
  if (!newState.value.name.trim()) {
    toasts.push({ kind: 'err', text: '请填写 CharacterState 名称' });
    return;
  }
  await post('/api/assets/character-states', {
    ...newState.value,
    heldItems: newState.value.heldItems.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
  });
  toasts.push({ kind: 'ok', text: `CharacterState「${newState.value.name}」已创建` });
  newState.value = { ...newState.value, name: '', costume: '', hair: '', injury: '', heldItems: '' };
  await load();
}

async function removeState(st: CharacterState) {
  const ok = await confirmDialog({ title: `删除状态「${st.name}」？`, message: '删除后不可恢复。', confirmLabel: '删除', danger: true });
  if (!ok) return;
  await del(`/api/assets/character-states/${st.id}`);
  await load();
}

async function upload(file: File) {
  const form = new FormData();
  form.append('file', file);
  form.append('label', file.name);
  await post('/api/assets/media/upload', form as never);
  toasts.push({ kind: 'ok', text: `已导入 ${file.name}` });
  await load();
}

async function importLocalPath() {
  importing.value = true;
  try {
    const a = await post<MediaAsset>('/api/assets/media/import-path', { path: importPath.value });
    toasts.push({ kind: 'ok', text: `已导入 ${a.label} (${a.kind})` });
    importPath.value = '';
    await load();
  } catch (e) {
    toasts.push({ kind: 'err', text: `导入失败：${e instanceof Error ? e.message : e}` });
  } finally {
    importing.value = false;
  }
}

async function extractFrame(assetId: string) {
  const a = await post<MediaAsset>(`/api/assets/media/${assetId}/extract-frame`, { atSeconds: 0, label: 'Extracted frame' });
  toasts.push({ kind: 'ok', text: `已抽帧：${a.id}` });
  await load();
}

function onDrop(e: DragEvent) {
  const files = e.dataTransfer?.files;
  if (!files) return;
  for (const f of Array.from(files)) void upload(f);
}

function thumbOf(m: MediaAsset): string | null {
  if (m.kind === 'image') return mediaUrl(m.id);
  if (m.posterPath) return fileUrl(m.posterPath);
  return null;
}

onMounted(load);
</script>

<template>
  <div class="page">
    <div class="spread">
      <h1>{{ t('pages.assets.title') }}</h1>
      <div class="tabs">
        <button v-for="tt in ([{ id: 'entities', cn: t('pages.assets.tabs.entities') }, { id: 'states', cn: t('pages.assets.tabs.states') }, { id: 'media', cn: t('pages.assets.tabs.media') }, { id: 'bindings', cn: t('pages.assets.tabs.bindings') }] as const)" :key="tt.id" :class="['tab', { active: tab === tt.id }]" @click="tab = tt.id">
          {{ tt.cn }}
        </button>
      </div>
    </div>
    <p class="muted page-sub">{{ t('pages.assets.subtitle') }}</p>

    <!-- Entities -->
    <div v-if="tab === 'entities'" class="panel">
      <div class="panel-title">Entity — 角色 / 场景 / 道具 / 载具 / 生物</div>
      <div class="panel-body">
        <div class="row create-row">
          <select v-model="newEntity.kind">
            <option v-for="k in KINDS" :key="k" :value="k">{{ KIND_LABEL[k] }}</option>
          </select>
          <input v-model="newEntity.name" placeholder="名称" @keyup.enter="createEntity" />
          <input v-model="newEntity.description" placeholder="描述" class="grow" @keyup.enter="createEntity" />
          <button class="primary sm" :disabled="!newEntity.name" @click="createEntity">创建</button>
        </div>
        <div class="row kind-filter">
          <span class="muted">筛选：</span>
          <span class="tag" :class="{ active: !kindFilter }" @click="kindFilter = ''">全部</span>
          <span v-for="k in KINDS" :key="k" class="tag" :class="{ active: kindFilter === k }" @click="kindFilter = kindFilter === k ? '' : k">{{ KIND_LABEL[k] }}</span>
        </div>
        <EmptyState v-if="!entities.length" icon="❖" title="还没有实体" desc="先创建角色与场景 — Shot 的主角色、场景与连续性都引用这里的实体。" />
        <div class="grid list">
          <div v-for="e in entities.filter((x) => !kindFilter || x.kind === kindFilter)" :key="e.id" class="entity panel">
            <div class="spread">
              <span class="badge accent no-dot">{{ KIND_LABEL[e.kind] ?? e.kind }}</span>
              <span class="name">{{ e.name }}</span>
              <button class="sm danger ghost" @click="removeEntity(e)">删</button>
            </div>
            <div class="muted">{{ e.description || '—' }}</div>
            <div v-if="Object.keys(e.traits).length" class="muted mono">{{ JSON.stringify(e.traits) }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- CharacterStates -->
    <div v-if="tab === 'states'" class="panel">
      <div class="panel-title">CharacterState — 「这个人在当前剧情状态是什么样」（与 Entity 严格分开）</div>
      <div class="panel-body">
        <div class="grid create-grid">
          <label class="field">
            角色
            <select v-model="newState.characterId">
              <option v-for="e in entities.filter((x) => x.kind === 'character')" :key="e.id" :value="e.id">{{ e.name }}</option>
            </select>
          </label>
          <label class="field">名称<input v-model="newState.name" placeholder="如：雨夜湿衣状态" /></label>
          <label class="field">服装<input v-model="newState.costume" placeholder="wet_white_shirt" /></label>
          <label class="field">发型<input v-model="newState.hair" placeholder="wet" /></label>
          <label class="field">伤势<input v-model="newState.injury" placeholder="forehead_cut" /></label>
          <label class="field">手持物（逗号分隔）<input v-model="newState.heldItems" placeholder="umbrella, phone" /></label>
        </div>
        <button class="primary sm" :disabled="!entities.some((e) => e.kind === 'character')" @click="createState">创建 CharacterState</button>
        <EmptyState v-if="!states.length" icon="❑" title="还没有角色状态" desc="CharacterState 记录服装 / 发型 / 伤势 / 手持物，是连续性提交与继承的基本单元。" />
        <div class="grid list">
          <div v-for="st in states" :key="st.id" class="entity panel">
            <div class="spread">
              <span class="badge info no-dot">{{ entities.find((e) => e.id === st.characterId)?.name ?? st.characterId }}</span>
              <span class="name">{{ st.name }}</span>
              <button class="sm danger ghost" @click="removeState(st)">删</button>
            </div>
            <div class="muted">costume: {{ st.costume || '—' }} · hair: {{ st.hair || '—' }} · injury: {{ st.injury || '—' }}</div>
            <div v-if="st.heldItems.length" class="muted">held: {{ st.heldItems.join(', ') }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Media -->
    <div v-if="tab === 'media'" class="panel">
      <div class="panel-title">MediaAsset — 图片 / 视频 / 音频（拖拽或本地路径导入）</div>
      <div class="panel-body">
        <div class="drop" @dragover.prevent @drop.prevent="onDrop">
          <div class="drop-icon">⇩</div>
          拖拽文件到这里导入（png / jpg / mp4 / webm / mp3 / wav…）
        </div>
        <div class="row import-row">
          <input v-model="importPath" placeholder="或输入本地绝对路径（local-first 导入）" class="grow mono" @keyup.enter="importLocalPath" />
          <button class="sm" :disabled="importing || !importPath" @click="importLocalPath">导入路径</button>
        </div>
        <EmptyState v-if="!media.length" icon="▦" title="媒体库为空" desc="首帧图、动作参考视频、音频参考都从这里进入项目；视频导入时自动生成封面。" />
        <div class="grid list">
          <div v-for="m in media" :key="m.id" class="media panel">
            <div class="thumb">
              <img v-if="thumbOf(m)" :src="thumbOf(m)!" :alt="m.label" />
              <span v-else class="mono muted">{{ m.kind === 'video' ? '▶' : m.kind === 'audio' ? '♪' : '▧' }} {{ m.kind }}</span>
              <span v-if="m.kind === 'video'" class="kind-chip">▶</span>
              <button v-if="m.kind === 'video'" class="sm extract" title="抽取首帧为新资产" @click="extractFrame(m.id)">抽帧</button>
            </div>
            <div class="media-body">
              <div class="spread">
                <span class="name media-name" :title="m.label || m.id">{{ m.label || m.id }}</span>
                <span class="badge no-dot">{{ m.kind }}</span>
              </div>
              <div class="muted mono file-name" :title="m.fileName">{{ m.fileName }}</div>
              <div class="muted">{{ (m.width && m.height) ? `${m.width}×${m.height}` : '' }} {{ m.durationSeconds ? `${m.durationSeconds.toFixed(1)}s` : '' }} · {{ (m.sizeBytes / 1024).toFixed(0) }}KB</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Bindings -->
    <div v-if="tab === 'bindings'" class="panel">
      <div class="panel-title">ReferenceBindings — 全局绑定（镜头级绑定在 Director Desk 的参考绑定页）</div>
      <div class="panel-body col">
        <EmptyState v-if="!bindings.length" icon="➶" title="全局绑定为空" desc="镜头级绑定在 Shot 详情的参考绑定页管理；全局绑定对全部 Shot 生效。" />
        <div v-for="b in bindings" :key="b.id" class="binding panel">
          <div class="row wrap">
            <span class="badge accent no-dot">{{ b.type }}</span>
            <span class="name">{{ b.label || b.id }}</span>
            <span class="muted">{{ media.find((m) => m.id === b.assetId)?.label ?? b.assetId }}</span>
            <span v-for="r in b.roles" :key="r" class="tag active">{{ r }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 24px 32px; max-width: 1280px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0; font-family: var(--serif); }
.page-sub { margin: 8px 0 14px; }
.tabs { display: flex; gap: 4px; }
.tab { border: none; background: transparent; color: var(--text-2); padding: 8px 13px; border-bottom: 2px solid transparent; border-radius: 0; box-shadow: none; }
.tab.active { color: var(--accent-text); border-bottom-color: var(--accent); font-weight: 600; }
.create-row { margin-bottom: 12px; }
.create-row input { flex: 1; }
.kind-filter { margin-bottom: 6px; }
.create-grid { grid-template-columns: repeat(2, 1fr); margin-bottom: 14px; }
.list { grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); margin-top: 12px; }
.entity, .media { padding: 10px; }
.name { font-weight: 600; font-size: 13.5px; }
.drop {
  border: 1.5px dashed var(--line-2); border-radius: var(--radius);
  padding: 30px; text-align: center; color: var(--text-3); margin-bottom: 10px;
  transition: border-color 0.15s, background 0.15s;
}
.drop:hover { border-color: var(--accent); color: var(--text-2); background: var(--accent-soft); }
.drop-icon { font-size: 22px; margin-bottom: 4px; color: var(--accent); }
.import-row { margin-bottom: 8px; }
.thumb { position: relative; height: 108px; background: var(--inset); border-radius: 6px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.kind-chip { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 22px; color: rgba(255,255,255,0.85); text-shadow: 0 1px 6px rgba(0,0,0,0.6); pointer-events: none; }
.extract { position: absolute; bottom: 4px; right: 4px; }
.media-body { padding: 8px 0 0; }
.media-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-name { font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.binding { padding: 8px 10px; }
.wrap { flex-wrap: wrap; }
</style>
