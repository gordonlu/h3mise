<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { get, post, del, patch, mediaUrl, fileUrl } from '../api/client';
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
const KIND_COLOR: Record<string, string> = { character: '#5ab0ff', scene: '#4ec9a0', prop: '#e8a85a', vehicle: '#b48bf0', creature: '#e06c75' };

const newEntity = ref({ kind: 'character', name: '', description: '', traits: '' });
const newState = ref({ characterId: '', name: '', costume: '', hair: '', injury: '', heldItems: '' });
const importPath = ref('');
const importing = ref(false);

type EditingItem =
  | { kind: 'entity'; item: Entity }
  | { kind: 'state'; item: CharacterState }
  | { kind: 'media'; item: MediaAsset }
  | { kind: 'binding'; item: ReferenceBinding };
const editing = ref<EditingItem | null>(null);

function traitsText(traits: Record<string, string>): string {
  return Object.entries(traits).map(([k, v]) => `${k} = ${v}`).join('\n');
}

function traitsFromText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/[,\n]/)) {
    const i = line.search(/[=:]/);
    if (i > 0) {
      const k = line.slice(0, i).trim();
      const v = line.slice(i + 1).trim();
      if (k) out[k] = v;
    }
  }
  return out;
}

async function saveEdit() {
  if (!editing.value) return;
  const e = editing.value;
  try {
    if (e.kind === 'entity') {
      await patch(`/api/assets/entities/${e.item.id}`, { name: e.item.name, description: e.item.description, kind: e.item.kind, traits: e.item.traits });
      toasts.push({ kind: 'ok', text: '实体已更新' });
    } else if (e.kind === 'state') {
      await patch(`/api/assets/character-states/${e.item.id}`, {
        name: e.item.name,
        costume: e.item.costume,
        hair: e.item.hair,
        injury: e.item.injury,
        heldItems: e.item.heldItems.join(','),
      });
      toasts.push({ kind: 'ok', text: '角色状态已更新' });
    } else if (e.kind === 'media') {
      await patch(`/api/assets/media/${e.item.id}`, { label: e.item.label, tags: e.item.tags });
      toasts.push({ kind: 'ok', text: '媒体标签已更新' });
    } else {
      await patch(`/api/assets/bindings/${e.item.id}`, { label: e.item.label, roles: e.item.roles });
      toasts.push({ kind: 'ok', text: '绑定已更新' });
    }
    editing.value = null;
    await load();
  } catch (err) {
    toasts.push({ kind: 'err', text: err instanceof Error ? err.message : String(err) });
  }
}

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
  await post('/api/assets/entities', {
    kind: newEntity.value.kind,
    name: newEntity.value.name,
    description: newEntity.value.description,
    traits: traitsFromText(newEntity.value.traits),
  });
  toasts.push({ kind: 'ok', text: `实体「${newEntity.value.name}」已创建` });
  newEntity.value = { kind: 'character', name: '', description: '', traits: '' };
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

const filteredEntities = computed(() => entities.value.filter((x) => !kindFilter.value || x.kind === kindFilter.value));

onMounted(load);
</script>

<template>
  <div class="page">
    <header class="page-head">
      <div class="head-titles">
        <h1>{{ t('pages.assets.title') }}</h1>
        <p class="page-sub">{{ t('pages.assets.subtitle') }}</p>
      </div>
      <nav class="tabs">
        <button
          v-for="tt in ([
            { id: 'entities', cn: t('pages.assets.tabs.entities'), n: entities.length },
            { id: 'states', cn: t('pages.assets.tabs.states'), n: states.length },
            { id: 'media', cn: t('pages.assets.tabs.media'), n: media.length },
            { id: 'bindings', cn: t('pages.assets.tabs.bindings'), n: bindings.length },
          ] as const)"
          :key="tt.id"
          :class="['tab', { active: tab === tt.id }]"
          @click="tab = tt.id"
        >
          {{ tt.cn }}<span class="tab-count">{{ tt.n }}</span>
        </button>
      </nav>
    </header>

    <!-- Entities -->
    <section v-if="tab === 'entities'" class="panel">
      <div class="panel-title">实体</div>
      <div class="panel-body">
        <form class="toolbar" @submit.prevent="createEntity">
          <select v-model="newEntity.kind">
            <option v-for="k in KINDS" :key="k" :value="k">{{ KIND_LABEL[k] }}</option>
          </select>
          <input v-model="newEntity.name" placeholder="名称" @keyup.enter="createEntity" />
          <input v-model="newEntity.description" placeholder="描述（可选）" class="grow" @keyup.enter="createEntity" />
          <input v-model="newEntity.traits" placeholder="特征（可选，键=值，逗号分隔，如 costume=白衬衫, build=高挑）" class="grow traits-input" @keyup.enter="createEntity" />
          <button class="primary" :disabled="!newEntity.name">创建实体</button>
        </form>
        <div class="kind-filter">
          <span class="filter-label">筛选</span>
          <span class="tag" :class="{ active: !kindFilter }" @click="kindFilter = ''">全部</span>
          <span v-for="k in KINDS" :key="k" class="tag" :class="{ active: kindFilter === k }" @click="kindFilter = kindFilter === k ? '' : k">
            {{ KIND_LABEL[k] }}
          </span>
        </div>
        <EmptyState v-if="!entities.length" icon="❖" title="还没有实体" desc="先创建角色与场景 — Shot 的主角色、场景与连续性都引用这里的实体。" />
        <div v-else class="grid list">
          <article v-for="e in filteredEntities" :key="e.id" class="card">
            <div class="card-top">
              <span class="kind-badge" :style="{ color: KIND_COLOR[e.kind], background: `${KIND_COLOR[e.kind]}1a`, borderColor: `${KIND_COLOR[e.kind]}55` }">{{ KIND_LABEL[e.kind] ?? e.kind }}</span>
              <h3 class="card-name" :title="e.name">{{ e.name }}</h3>
              <div class="card-actions">
                <button class="icon-btn" title="编辑" @click="editing = { kind: 'entity', item: e }">✎</button>
                <button class="icon-btn danger" title="删除" @click="removeEntity(e)">🗑</button>
              </div>
            </div>
            <p class="card-desc">{{ e.description || '—' }}</p>
            <p v-if="Object.keys(e.traits).length" class="card-meta">{{ Object.entries(e.traits).map(([k, v]) => `${k}: ${v}`).join(' · ') }}</p>
          </article>
        </div>
      </div>
    </section>

    <!-- CharacterStates -->
    <section v-if="tab === 'states'" class="panel">
      <div class="panel-title">角色状态 <span class="panel-note">这个人在当前剧情状态下的外观（与实体严格分开）</span></div>
      <div class="panel-body">
        <form class="toolbar wrap-toolbar" @submit.prevent="createState">
          <label class="field">
            <span>角色</span>
            <select v-model="newState.characterId">
              <option v-for="e in entities.filter((x) => x.kind === 'character')" :key="e.id" :value="e.id">{{ e.name }}</option>
            </select>
          </label>
          <label class="field"><span>名称</span><input v-model="newState.name" placeholder="如：雨夜湿衣状态" /></label>
          <label class="field"><span>服装</span><input v-model="newState.costume" placeholder="wet_white_shirt" /></label>
          <label class="field"><span>发型</span><input v-model="newState.hair" placeholder="wet" /></label>
          <label class="field"><span>伤势</span><input v-model="newState.injury" placeholder="forehead_cut" /></label>
          <label class="field"><span>手持物</span><input v-model="newState.heldItems" placeholder="umbrella, phone" /></label>
          <button class="primary" :disabled="!newState.name || !entities.some((e) => e.kind === 'character')">创建状态</button>
        </form>
        <EmptyState v-if="!states.length" icon="❑" title="还没有角色状态" desc="CharacterState 记录服装 / 发型 / 伤势 / 手持物，是连续性提交与继承的基本单元。" />
        <div v-else class="grid list">
          <article v-for="st in states" :key="st.id" class="card">
            <div class="card-top">
              <span class="kind-badge info">{{ entities.find((e) => e.id === st.characterId)?.name ?? st.characterId }}</span>
              <h3 class="card-name" :title="st.name">{{ st.name }}</h3>
              <div class="card-actions">
                <button class="icon-btn" title="编辑" @click="editing = { kind: 'state', item: st }">✎</button>
                <button class="icon-btn danger" title="删除" @click="removeState(st)">🗑</button>
              </div>
            </div>
            <p class="card-desc">服装 {{ st.costume || '—' }} · 发型 {{ st.hair || '—' }} · 伤势 {{ st.injury || '—' }}</p>
            <p v-if="st.heldItems.length" class="card-meta">手持 {{ st.heldItems.join('、') }}</p>
          </article>
        </div>
      </div>
    </section>

    <!-- Media -->
    <section v-if="tab === 'media'" class="panel">
      <div class="panel-title">媒体库 <span class="panel-note">图片 / 视频 / 音频 — 拖拽或本地路径导入，视频自动生成封面</span></div>
      <div class="panel-body">
        <div class="drop" @dragover.prevent @drop.prevent="onDrop">
          <div class="drop-icon">⇩</div>
          <div>拖拽文件到这里导入</div>
          <div class="drop-hint">png · jpg · mp4 · webm · mp3 · wav</div>
        </div>
        <form class="toolbar" @submit.prevent="importLocalPath">
          <input v-model="importPath" placeholder="或输入本地绝对路径（local-first 导入）" class="grow mono" />
          <button class="primary" :disabled="importing || !importPath">{{ importing ? '导入中…' : '导入路径' }}</button>
        </form>
        <EmptyState v-if="!media.length" icon="▦" title="媒体库为空" desc="首帧图、动作参考视频、音频参考都从这里进入项目。" />
        <div v-else class="grid list">
          <article v-for="m in media" :key="m.id" class="card media-card">
            <div class="thumb">
              <img v-if="thumbOf(m)" :src="thumbOf(m)!" :alt="m.label" loading="lazy" />
              <span v-else class="thumb-glyph">{{ m.kind === 'video' ? '▶' : m.kind === 'audio' ? '♪' : '▧' }}</span>
              <span v-if="m.kind === 'video'" class="kind-chip">▶</span>
              <button v-if="m.kind === 'video'" class="extract" title="抽取首帧为新资产" @click="extractFrame(m.id)">抽帧</button>
            </div>
            <div class="media-body">
              <div class="card-top">
                <h3 class="card-name media-name" :title="m.label || m.id">{{ m.label || m.id }}</h3>
                <div class="card-actions">
                  <span class="type-chip">{{ m.kind }}</span>
                  <button class="icon-btn" title="编辑" @click="editing = { kind: 'media', item: m }">✎</button>
                </div>
              </div>
              <p class="card-meta mono file-name" :title="m.fileName">{{ m.fileName }}</p>
              <p class="card-meta">{{ (m.width && m.height) ? `${m.width}×${m.height}` : '' }}{{ m.durationSeconds ? ` · ${m.durationSeconds.toFixed(1)}s` : '' }} · {{ (m.sizeBytes / 1024).toFixed(0) }} KB</p>
            </div>
          </article>
        </div>
      </div>
    </section>

    <!-- Bindings -->
    <section v-if="tab === 'bindings'" class="panel">
      <div class="panel-title">全局绑定 <span class="panel-note">对全部 Shot 生效；镜头级绑定在 Shot 详情的参考绑定页管理</span></div>
      <div class="panel-body">
        <EmptyState v-if="!bindings.length" icon="➶" title="全局绑定为空" desc="镜头级绑定在 Shot 详情的参考绑定页管理；全局绑定对全部 Shot 生效。" />
        <div v-else class="bind-list">
          <article v-for="b in bindings" :key="b.id" class="card binding-card">
            <span class="type-chip">{{ b.type }}</span>
            <h3 class="card-name" :title="b.label || b.id">{{ b.label || b.id }}</h3>
            <span class="asset-label">{{ media.find((m) => m.id === b.assetId)?.label ?? b.assetId }}</span>
            <div class="roles">
              <span v-for="r in b.roles" :key="r" class="tag active">{{ r }}</span>
            </div>
            <button class="icon-btn" title="编辑" @click="editing = { kind: 'binding', item: b }">✎</button>
          </article>
        </div>
      </div>
    </section>
  </div>

  <div v-if="editing" class="modal-mask" @click.self="editing = null">
    <div class="modal panel">
      <div class="modal-head">
        <span>编辑{{ editing.kind === 'entity' ? '实体' : editing.kind === 'state' ? '角色状态' : editing.kind === 'media' ? '媒体' : '绑定' }}</span>
        <span class="t-close" @click="editing = null">✕</span>
      </div>
      <div class="modal-body">
        <template v-if="editing.kind === 'entity'">
          <label class="field"><span>名称</span><input v-model="editing.item.name" /></label>
          <label class="field"><span>类型</span>
            <select v-model="editing.item.kind">
              <option v-for="k in KINDS" :key="k" :value="k">{{ KIND_LABEL[k] }}</option>
            </select>
          </label>
          <label class="field"><span>描述</span><textarea v-model="editing.item.description" rows="3"></textarea></label>
          <label class="field"><span>特征（每行一条，格式「键 = 值」）</span><textarea rows="3" :value="traitsText(editing.item.traits)" @change="editing.item.traits = traitsFromText(($event.target as HTMLTextAreaElement).value)"></textarea></label>
        </template>
        <template v-else-if="editing.kind === 'state'">
          <label class="field"><span>状态名称</span><input v-model="editing.item.name" /></label>
          <label class="field"><span>服装</span><input v-model="editing.item.costume" /></label>
          <label class="field"><span>发型</span><input v-model="editing.item.hair" /></label>
          <label class="field"><span>伤势</span><input v-model="editing.item.injury" /></label>
          <label class="field"><span>手持物</span><input :value="editing.item.heldItems.join(', ')" @change="editing.item.heldItems = ($event.target as HTMLInputElement).value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)" /></label>
        </template>
        <template v-else-if="editing.kind === 'media'">
          <label class="field"><span>标签</span><input v-model="editing.item.label" /></label>
          <label class="field"><span>Tags（逗号分隔）</span><input :value="editing.item.tags.join(', ')" @change="editing.item.tags = ($event.target as HTMLInputElement).value.split(/[,，]/).map((x) => x.trim()).filter(Boolean)" /></label>
          <p class="muted">文件名：{{ editing.item.fileName }}（重命名文件需重新导入）</p>
        </template>
        <template v-else>
          <label class="field"><span>标签</span><input v-model="editing.item.label" /></label>
          <label class="field"><span>角色（逗号分隔）</span><input :value="editing.item.roles.join(', ')" @change="editing.item.roles = ($event.target as HTMLInputElement).value.split(/[,，]/).map((x) => x.trim()).filter(Boolean) as never" /></label>
        </template>
        <div class="modal-foot">
          <button class="primary" @click="saveEdit">保存</button>
          <button class="ghost" @click="editing = null">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ---------- page head ---------- */
.page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.head-titles h1 { margin: 0 0 2px; }
.page-sub { margin: 0; font-size: 12.5px; color: var(--text-3); }
.tabs { display: flex; gap: 4px; border: 1px solid var(--line); border-radius: 9px; padding: 3px; background: var(--bg-2); }
.tab {
  border: none; background: transparent; color: var(--text-2);
  padding: 6px 14px; border-radius: 6px; font-size: 13px; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
  transition: background 0.12s, color 0.12s;
}
.tab:hover { color: var(--text); background: var(--bg-subtle); }
.tab.active { background: var(--accent-soft); color: var(--accent-text); font-weight: 600; }
.tab-count { font-size: 11px; opacity: 0.65; background: var(--bg-subtle); border-radius: 8px; padding: 0 6px; line-height: 15px; }
.tab.active .tab-count { background: color-mix(in srgb, var(--accent) 14%, transparent); }

/* ---------- toolbar ---------- */
.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 14px; }
.toolbar input, .toolbar select { flex: none; }
.toolbar input.grow { flex: 1; }
.toolbar .traits-input { flex: 1.2; }
.toolbar .field { flex: 1 1 160px; }
.toolbar .field select, .toolbar .field input { width: 100%; }
.toolbar .primary { flex: none; }
.wrap-toolbar { flex-wrap: wrap; }
.kind-filter { display: flex; align-items: center; gap: 6px; margin: 0 0 12px; flex-wrap: wrap; }
.filter-label { font-size: 12px; color: var(--text-3); margin-right: 4px; }
.panel-title { font-size: 13px; }
.panel-note { font-weight: 400; font-size: 11.5px; color: var(--text-3); margin-left: 8px; }

/* ---------- cards ---------- */
.list { grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.card {
  background: var(--bg-2);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 14px 14px 12px;
  box-shadow: var(--shadow-1);
  display: flex; flex-direction: column; gap: 6px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.card:hover { border-color: var(--line-2); box-shadow: var(--shadow-2); }
.card-top { display: flex; align-items: center; gap: 8px; min-width: 0; }
.card-name {
  font-size: 14px; font-weight: 600; margin: 0; flex: 1;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.card-desc { font-size: 12.5px; color: var(--text-2); margin: 0; line-height: 1.55; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.card-meta { font-size: 11.5px; color: var(--text-3); margin: 0; line-height: 1.5; }
.card-actions { display: flex; align-items: center; gap: 4px; flex: none; }

/* kind badge — soft tint per kind */
.kind-badge {
  flex: none; font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
  padding: 2px 9px; border-radius: 20px; border: 1px solid transparent;
}
.kind-badge.info { color: #7fd4ff; background: rgba(79, 172, 254, 0.14); border-color: rgba(79, 172, 254, 0.4); }
.type-chip {
  font-size: 10.5px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--text-3); border: 1px solid var(--line-2); border-radius: 5px; padding: 1px 6px;
}
.icon-btn {
  border: none; background: transparent; color: var(--text-3);
  width: 26px; height: 26px; border-radius: 6px; font-size: 13px; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  transition: color 0.12s, background 0.12s;
}
.icon-btn:hover { color: var(--text); background: var(--bg-subtle); }
.icon-btn.danger:hover { color: #ff7b72; background: rgba(255, 123, 114, 0.12); }

/* ---------- media ---------- */
.drop {
  border: 1.5px dashed var(--line-2); border-radius: 12px;
  padding: 26px; text-align: center; color: var(--text-2);
  margin-bottom: 12px; cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.drop:hover { border-color: var(--accent); background: var(--accent-soft); }
.drop-icon { font-size: 20px; color: var(--accent); margin-bottom: 2px; }
.drop-hint { font-size: 11.5px; color: var(--text-3); margin-top: 3px; }
.thumb {
  position: relative; height: 132px; border-radius: 8px; overflow: hidden;
  background: var(--inset); border: 1px solid var(--line);
  display: flex; align-items: center; justify-content: center;
}
.thumb img { width: 100%; height: 100%; object-fit: cover; }
.media-card:hover .thumb img { opacity: 0.92; }
.thumb-glyph { font-size: 22px; color: var(--text-3); }
.kind-chip {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 24px; color: rgba(255,255,255,0.95); text-shadow: 0 1px 10px rgba(0,0,0,0.7);
  pointer-events: none;
}
.extract {
  position: absolute; bottom: 6px; right: 6px;
  border: 1px solid var(--line); background: var(--bg-2); color: var(--text-2);
  border-radius: 6px; padding: 3px 8px; font-size: 11px; cursor: pointer;
  opacity: 0; transition: opacity 0.15s;
}
.media-card:hover .extract { opacity: 1; }
.extract:hover { color: var(--text); border-color: var(--line-2); }
.media-body { padding: 10px 2px 0; display: flex; flex-direction: column; gap: 4px; }
.media-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- bindings ---------- */
.bind-list { display: flex; flex-direction: column; gap: 8px; }
.binding-card {
  flex-direction: row; align-items: center; gap: 10px; padding: 10px 14px;
}
.asset-label { font-size: 12px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.roles { display: flex; gap: 5px; flex-wrap: wrap; margin-left: auto; }

/* ---------- modal ---------- */
.modal-mask {
  position: fixed; inset: 0; z-index: 60;
  background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(3px);
  display: flex; align-items: center; justify-content: center;
}
.modal { width: min(460px, 92vw); padding: 0; overflow: hidden; animation: pop 0.16s ease; }
.modal-head {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 14px; font-weight: 600; padding: 14px 18px;
  border-bottom: 1px solid var(--line);
}
.modal-head .t-close { cursor: pointer; color: var(--text-3); font-size: 15px; line-height: 1; }
.modal-head .t-close:hover { color: var(--text); }
.modal-body { padding: 18px; display: flex; flex-direction: column; gap: 14px; }
.modal-body .field { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--text-2); }
.modal-body .field input, .modal-body .field select, .modal-body .field textarea { width: 100%; }
.modal-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.modal-foot .primary { flex: none; }
@keyframes pop { from { transform: scale(0.97); opacity: 0; } to { transform: scale(1); opacity: 1; } }
</style>
