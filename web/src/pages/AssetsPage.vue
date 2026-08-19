<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { get, post, patch, del, mediaUrl } from '../api/client';
import type { CharacterState, Entity, MediaAsset, ReferenceBinding } from '@h3mise/shared';

const tab = ref<'entities' | 'states' | 'media' | 'bindings'>('entities');
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
const notice = ref('');

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
  newEntity.value = { kind: 'character', name: '', description: '' };
  await load();
}

async function removeEntity(id: string) {
  if (!confirm('删除实体？')) return;
  await del(`/api/assets/entities/${id}`);
  await load();
}

async function createState() {
  await post('/api/assets/character-states', {
    ...newState.value,
    heldItems: newState.value.heldItems.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
  });
  newState.value = { ...newState.value, name: '', costume: '', hair: '', injury: '', heldItems: '' };
  await load();
}

async function removeState(id: string) {
  await del(`/api/assets/character-states/${id}`);
  await load();
}

async function upload(file: File) {
  const form = new FormData();
  form.append('file', file);
  form.append('label', file.name);
  await post('/api/assets/media/upload', form as never);
  await load();
}

async function importLocalPath() {
  importing.value = true;
  notice.value = '';
  try {
    const a = await post<MediaAsset>('/api/assets/media/import-path', { path: importPath.value });
    notice.value = `已导入 ${a.label} (${a.kind})`;
    importPath.value = '';
    await load();
  } catch (e) {
    notice.value = `导入失败：${e instanceof Error ? e.message : e}`;
  } finally {
    importing.value = false;
  }
}

async function extractFrame(assetId: string) {
  const a = await post<MediaAsset>(`/api/assets/media/${assetId}/extract-frame`, { atSeconds: 0, label: 'Extracted frame' });
  notice.value = `已抽帧：${a.id}`;
  await load();
}

function onDrop(e: DragEvent) {
  const files = e.dataTransfer?.files;
  if (!files) return;
  for (const f of Array.from(files)) void upload(f);
}

const onInput = () => undefined;
</script>

<template>
  <div class="page">
    <div class="spread">
      <h1>Assets</h1>
      <div class="tabs">
        <button v-for="t in ([{ id: 'entities', label: 'Entities' }, { id: 'states', label: 'CharacterState' }, { id: 'media', label: 'Media' }, { id: 'bindings', label: 'Bindings' }] as const)" :key="t.id" :class="['tab', { active: tab === t.id }]" @click="tab = t.id">
          {{ t.label }}
        </button>
      </div>
    </div>
    <p v-if="notice" class="badge info">{{ notice }}</p>

    <!-- Entities -->
    <div v-if="tab === 'entities'" class="panel">
      <div class="panel-title">Entity — 角色 / 场景 / 道具 / 载具 / 生物（“这个人是谁”）</div>
      <div class="panel-body">
        <div class="row create-row">
          <select v-model="newEntity.kind">
            <option v-for="k in KINDS" :key="k" :value="k">{{ KIND_LABEL[k] }}</option>
          </select>
          <input v-model="newEntity.name" placeholder="名称" />
          <input v-model="newEntity.description" placeholder="描述" class="grow" />
          <button class="primary sm" :disabled="!newEntity.name" @click="createEntity">创建</button>
        </div>
        <div class="grid list">
          <div v-for="e in entities.filter((x) => !kindFilter || x.kind === kindFilter)" :key="e.id" class="entity panel">
            <div class="spread">
              <span class="badge accent">{{ KIND_LABEL[e.kind] ?? e.kind }}</span>
              <span class="name">{{ e.name }}</span>
              <button class="sm danger ghost" @click="removeEntity(e.id)">删</button>
            </div>
            <div class="muted">{{ e.description || '—' }}</div>
            <div v-if="Object.keys(e.traits).length" class="muted mono">{{ JSON.stringify(e.traits) }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- CharacterStates -->
    <div v-if="tab === 'states'" class="panel">
      <div class="panel-title">CharacterState — “当前剧情状态是什么样”（与 Entity 分开）</div>
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
        <button class="primary sm" @click="createState">创建 CharacterState</button>
        <div class="grid list">
          <div v-for="st in states" :key="st.id" class="entity panel">
            <div class="spread">
              <span class="badge info">{{ entities.find((e) => e.id === st.characterId)?.name ?? st.characterId }}</span>
              <span class="name">{{ st.name }}</span>
              <button class="sm danger ghost" @click="removeState(st.id)">删</button>
            </div>
            <div class="muted">costume: {{ st.costume }} · hair: {{ st.hair }} · injury: {{ st.injury }}</div>
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
          拖拽文件到这里导入（png / jpg / mp4 / webm / mp3 / wav…）
        </div>
        <div class="row import-row">
          <input v-model="importPath" placeholder="或输入本地绝对路径（local-first 导入）" class="grow mono" />
          <button class="sm" :disabled="importing || !importPath" @click="importLocalPath">导入路径</button>
        </div>
        <div class="grid list">
          <div v-for="m in media" :key="m.id" class="media panel">
            <div class="thumb">
              <img v-if="m.kind === 'image'" :src="mediaUrl(m.id)" :alt="m.label" />
              <span v-else class="mono muted">{{ m.kind === 'video' ? '▶' : '♪' }} {{ m.kind }}</span>
              <button v-if="m.kind === 'video'" class="sm extract" title="抽取首帧" @click="extractFrame(m.id)">抽帧</button>
            </div>
            <div class="media-body">
              <div class="spread">
                <span class="name">{{ m.label || m.id }}</span>
                <span class="badge">{{ m.kind }}</span>
              </div>
              <div class="muted mono">{{ m.fileName }}</div>
              <div class="muted">{{ (m.width && m.height) ? `${m.width}×${m.height}` : '' }} {{ m.durationSeconds ? `${m.durationSeconds.toFixed(1)}s` : '' }} · {{ (m.sizeBytes / 1024).toFixed(0) }}KB</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Bindings -->
    <div v-if="tab === 'bindings'" class="panel">
      <div class="panel-title">ReferenceBindings — 资产通过角色承担用途（first_frame / identity / motion…）</div>
      <div class="panel-body col">
        <div v-for="b in bindings" :key="b.id" class="binding panel">
          <div class="row">
            <span class="badge accent">{{ b.type }}</span>
            <span>{{ b.label || b.id }}</span>
            <span class="muted">{{ media.find((m) => m.id === b.assetId)?.label ?? b.assetId }}</span>
            <span v-for="r in b.roles" :key="r" class="tag active">{{ r }}</span>
          </div>
        </div>
        <div v-if="!bindings.length" class="muted">全局绑定为空；镜头级绑定在 Director Desk 的 References 页。</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 24px 32px; max-width: 1200px; margin: 0 auto; }
h1 { font-size: 21px; margin: 0; }
.tabs { display: flex; gap: 4px; }
.tab { border: none; background: transparent; color: var(--text-2); padding: 8px 12px; border-bottom: 2px solid transparent; border-radius: 0; }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.create-row { margin-bottom: 12px; }
.create-row input { flex: 1; }
.create-grid { grid-template-columns: repeat(3, 1fr); margin-bottom: 12px; }
.list { grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); margin-top: 12px; }
.entity, .media { padding: 10px; }
.name { font-weight: 600; font-size: 13.5px; }
.drop {
  border: 1.5px dashed var(--line-2); border-radius: var(--radius);
  padding: 26px; text-align: center; color: var(--text-3); margin-bottom: 10px;
}
.drop:hover { border-color: var(--accent); color: var(--text-2); }
.import-row { margin-bottom: 8px; }
.thumb { position: relative; height: 100px; background: var(--bg-3); border-radius: 4px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.extract { position: absolute; bottom: 4px; right: 4px; }
.media-body { padding: 6px 0 0; }
.binding { padding: 8px 10px; }
</style>
