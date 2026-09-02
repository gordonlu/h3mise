<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { get, post, del, patch, mediaUrl, fileUrl } from '../api/client';
import { useToastStore } from '../stores/toast';
import { t } from '../stores/locale';
import { confirmDialog } from '../stores/confirm';
import type { CharacterState, Entity, MediaAsset, ReferenceBinding, ReferenceRole } from '@h3mise/shared';
import EmptyState from '../components/EmptyState.vue';

const route = useRoute();
const router = useRouter();
const requestedTab = route.query.tab;
const tab = ref<'entities' | 'states' | 'media' | 'bindings'>(
  requestedTab === 'states' || requestedTab === 'media' || requestedTab === 'bindings' ? requestedTab : 'entities',
);
const toasts = useToastStore();
const entities = ref<Entity[]>([]);
const states = ref<CharacterState[]>([]);
const media = ref<MediaAsset[]>([]);
/** System frame assets (Take first/last frames) are working files for Frame
 * Bridge — hidden by default so the library only shows user-imported media. */
const showSystemFrames = ref(false);
const visibleMedia = computed(() => (showSystemFrames.value ? media.value : media.value.filter((m) => m.source !== 'frame_extract')));
const bindings = ref<ReferenceBinding[]>([]);
const kindFilter = ref('');

const KINDS = ['character', 'scene', 'prop', 'vehicle', 'creature'];
function kindLabel(kind: string): string {
  return ({ character: t('workflow.assets.character'), scene: t('workflow.assets.scene'), prop: t('workflow.assets.prop'), vehicle: t('workflow.assets.vehicle'), creature: t('workflow.assets.creature') } as Record<string, string>)[kind] ?? kind;
}
const KIND_COLOR: Record<string, string> = { character: '#5ab0ff', scene: '#4ec9a0', prop: '#e8a85a', vehicle: '#b48bf0', creature: '#e06c75' };

const newEntity = ref({ kind: 'character', name: '', description: '', traits: '' });
const newState = ref({ characterId: '', name: '', costume: '', hair: '', injury: '', heldItems: '' });
const importPath = ref('');
const importing = ref(false);
const uploading = ref(0);
const imageInput = ref<HTMLInputElement | null>(null);
const audioInput = ref<HTMLInputElement | null>(null);
const relatedImageInput = ref<HTMLInputElement | null>(null);
const relatedImageTarget = ref<{ kind: 'entity' | 'state'; id: string } | null>(null);
const linkedOnVisit = ref(false);

const returnTo = computed(() => {
  const raw = typeof route.query.returnTo === 'string' ? route.query.returnTo : '';
  return raw.startsWith('/') && !raw.startsWith('//') ? raw : '';
});
const shotUploadContext = computed(() => {
  const shotId = typeof route.query.shotId === 'string' ? route.query.shotId : '';
  const mode = typeof route.query.mode === 'string' ? route.query.mode : '';
  const role: ReferenceRole | null = route.query.role === 'first_frame' || route.query.role === 'last_frame' ? route.query.role : null;
  return shotId ? { shotId, mode, role } : null;
});
const uploadContextLabel = computed(() => {
  const ctx = shotUploadContext.value;
  if (!ctx) return '';
  if (ctx.role === 'first_frame') return '上传后将自动绑定为 FirstFrame 首帧';
  if (ctx.role === 'last_frame') return '上传后将自动绑定为 LastFrame 尾帧';
  if (ctx.mode === 'ref2va') return '上传图片或音频后将自动绑定到当前镜头的 Ref2VA';
  return '上传后返回当前镜头继续制作';
});

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
        heldItems: e.item.heldItems,
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
  if (!newState.value.characterId && entities.value.some((e) => e.kind === 'character' || e.kind === 'creature')) {
    newState.value.characterId = entities.value.find((e) => e.kind === 'character' || e.kind === 'creature')!.id;
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

async function importFile(file: File): Promise<MediaAsset | null> {
  if (file.type.startsWith('video/')) {
    toasts.push({ kind: 'err', text: `不支持上传视频：${file.name}` });
    return null;
  }
  if (!file.type.startsWith('image/') && !file.type.startsWith('audio/')) {
    toasts.push({ kind: 'err', text: `只支持图片或参考音频：${file.name}` });
    return null;
  }
  uploading.value += 1;
  try {
    const form = new FormData();
    form.append('file', file);
    form.append('label', file.name);
    const asset = await post<MediaAsset>('/api/assets/media/upload', form);
    await load();
    return asset;
  } catch (e) {
    toasts.push({ kind: 'err', text: `上传失败：${e instanceof Error ? e.message : e}` });
  } finally {
    uploading.value -= 1;
  }
  return null;
}

async function associateWithSourceShot(asset: MediaAsset): Promise<boolean> {
  const ctx = shotUploadContext.value;
  if (!ctx) return false;
  let roles: ReferenceBinding['roles'] | null = null;
  if (asset.kind === 'image' && ctx.role) roles = [ctx.role];
  else if (ctx.mode === 'ref2va' && (asset.kind === 'image' || asset.kind === 'audio')) roles = [];
  if (!roles) return false;
  await post('/api/assets/bindings', { assetId: asset.id, roles, label: asset.label, shotId: ctx.shotId });
  linkedOnVisit.value = true;
  return true;
}

async function upload(file: File) {
  const asset = await importFile(file);
  if (!asset) return;
  try {
    const linked = await associateWithSourceShot(asset);
    toasts.push({ kind: 'ok', text: linked ? `已上传并关联 ${file.name}` : `已导入 ${file.name}` });
  } catch (error) {
    toasts.push({ kind: 'err', text: `图片已上传，但关联镜头失败：${error instanceof Error ? error.message : error}` });
  }
}

function onFilePick(e: Event) {
  const input = e.target as HTMLInputElement;
  for (const file of Array.from(input.files ?? [])) void upload(file);
  input.value = '';
}

function chooseRelatedImage(kind: 'entity' | 'state', id: string) {
  relatedImageTarget.value = { kind, id };
  relatedImageInput.value?.click();
}

async function onRelatedImagePick(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  const target = relatedImageTarget.value;
  relatedImageTarget.value = null;
  if (!file || !target) return;
  const asset = await importFile(file);
  if (!asset || asset.kind !== 'image') return;
  try {
    const ownerName = target.kind === 'entity'
      ? entities.value.find((item) => item.id === target.id)?.name
      : states.value.find((item) => item.id === target.id)?.name;
    const label = `${ownerName || file.name}${target.kind === 'entity' ? ' · 主图' : ' · 状态图'}`;
    await patch(`/api/assets/media/${asset.id}`, { label });
    const path = target.kind === 'entity' ? `/api/assets/entities/${target.id}` : `/api/assets/character-states/${target.id}`;
    await patch(path, { imageAssetId: asset.id });
    const linked = await associateWithSourceShot({ ...asset, label });
    toasts.push({
      kind: 'ok',
      text: `${target.kind === 'entity' ? '实体主图已更新' : '角色状态图已覆盖'}${linked ? '，并已关联来源镜头' : ''}`,
    });
    await load();
  } catch (error) {
    toasts.push({ kind: 'err', text: `图片已上传，但关联失败：${error instanceof Error ? error.message : error}` });
  }
}

async function clearStateImage(state: CharacterState) {
  await patch(`/api/assets/character-states/${state.id}`, { imageAssetId: null });
  toasts.push({ kind: 'ok', text: '已恢复继承实体主图' });
  await load();
}

async function importLocalPath() {
  importing.value = true;
  try {
    const a = await post<MediaAsset>('/api/assets/media/import-path', { path: importPath.value });
    const linked = await associateWithSourceShot(a);
    toasts.push({ kind: 'ok', text: linked ? `已导入并关联 ${a.label}` : `已导入 ${a.label} (${a.kind})` });
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

function imageAsset(id: string | null | undefined): MediaAsset | null {
  return id ? media.value.find((item) => item.id === id && item.kind === 'image') ?? null : null;
}

function entityImage(entity: Entity): MediaAsset | null {
  return imageAsset(entity.imageAssetId);
}

function stateImage(state: CharacterState): { asset: MediaAsset | null; inherited: boolean } {
  return { asset: imageAsset(state.effectiveImageAssetId), inherited: !state.imageAssetId };
}

async function removeMedia(asset: MediaAsset) {
  const usage = await get<{ bindings: number; entities: number; states: number }>(`/api/assets/media/${asset.id}/usage`);
  const impacts = [
    usage.bindings ? `${usage.bindings} 个镜头绑定` : '',
    usage.entities ? `${usage.entities} 个实体主图` : '',
    usage.states ? `${usage.states} 个状态覆盖图` : '',
  ].filter(Boolean);
  const ok = await confirmDialog({
    title: `删除资产「${asset.label || asset.id}」？`,
    message: impacts.length
      ? `当前仍被 ${impacts.join('、')} 使用，服务端会阻止删除。请先解除这些引用。`
      : '文件将从项目中删除，此操作不可恢复。',
    confirmLabel: '删除资产',
    danger: true,
  });
  if (!ok) return;
  try {
    await del(`/api/assets/media/${asset.id}`);
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : '删除失败' });
    return;
  }
  toasts.push({ kind: 'ok', text: '资产已删除' });
  await load();
}

function goBackToSource() {
  if (returnTo.value) void router.push(returnTo.value);
}

const filteredEntities = computed(() => entities.value.filter((x) => !kindFilter.value || x.kind === kindFilter.value));

onMounted(load);
</script>

<template>
  <div class="page">
    <input ref="relatedImageInput" class="file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" @change="onRelatedImagePick" />
    <section v-if="returnTo" class="return-bar">
      <div>
        <strong>{{ linkedOnVisit ? '素材已关联，可以返回镜头' : '从镜头制作进入资产页' }}</strong>
        <span>{{ uploadContextLabel || '完成资产操作后返回原页面继续制作' }}</span>
      </div>
      <button :class="linkedOnVisit ? 'primary' : ''" @click="goBackToSource">← 返回镜头制作</button>
    </section>
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
      <div class="panel-title">{{ t('workflow.assets.entities') }}</div>
      <div class="panel-body">
        <form class="toolbar" @submit.prevent="createEntity">
          <select v-model="newEntity.kind">
            <option v-for="k in KINDS" :key="k" :value="k">{{ kindLabel(k) }}</option>
          </select>
          <input v-model="newEntity.name" :placeholder="t('workflow.assets.name')" @keyup.enter="createEntity" />
          <input v-model="newEntity.description" :placeholder="t('workflow.assets.descriptionOptional')" class="grow" @keyup.enter="createEntity" />
          <input v-model="newEntity.traits" :placeholder="t('workflow.assets.traitsOptionalKeyValueCommaSeparatedE')" class="grow traits-input" @keyup.enter="createEntity" />
          <button class="primary" :disabled="!newEntity.name">{{ t('workflow.assets.createEntity') }}</button>
        </form>
        <div class="kind-filter">
          <span class="filter-label">{{ t('workflow.assets.filter') }}</span>
          <span class="tag" :class="{ active: !kindFilter }" @click="kindFilter = ''">{{ t('workflow.assets.all') }}</span>
          <span v-for="k in KINDS" :key="k" class="tag" :class="{ active: kindFilter === k }" @click="kindFilter = kindFilter === k ? '' : k">
            {{ kindLabel(k) }}
          </span>
        </div>
        <EmptyState v-if="!entities.length" icon="❖" :title="t('workflow.assets.noEntitiesYet')" :desc="t('workflow.assets.createCharactersAndScenesFirstShotSubjects')" />
        <div v-else class="grid list">
          <article v-for="e in filteredEntities" :key="e.id" class="card visual-card">
            <img v-if="entityImage(e)" class="linked-image" :src="mediaUrl(entityImage(e)!.id)" :alt="`${e.name} 主图`" />
            <div class="card-top">
              <span class="kind-badge" :style="{ color: KIND_COLOR[e.kind], background: `${KIND_COLOR[e.kind]}1a`, borderColor: `${KIND_COLOR[e.kind]}55` }">{{ kindLabel(e.kind) }}</span>
              <h3 class="card-name" :title="e.name">{{ e.name }}</h3>
              <div class="card-actions">
                <button class="icon-btn" title="编辑" @click="editing = { kind: 'entity', item: e }">✎</button>
                <button class="icon-btn danger" title="删除" @click="removeEntity(e)">🗑</button>
              </div>
            </div>
            <p class="card-desc">{{ e.description || '—' }}</p>
            <p v-if="Object.keys(e.traits).length" class="card-meta">{{ Object.entries(e.traits).map(([k, v]) => `${k}: ${v}`).join(' · ') }}</p>
            <div class="image-link-row">
              <span :class="['badge', entityImage(e) ? 'ok' : 'warn']">{{ entityImage(e) ? '已绑定主图' : '缺少主图' }}</span>
              <button class="sm" @click="chooseRelatedImage('entity', e.id)">{{ entityImage(e) ? '更换主图' : '＋ 上传主图' }}</button>
            </div>
          </article>
        </div>
      </div>
    </section>

    <!-- CharacterStates -->
    <section v-if="tab === 'states'" class="panel">
      <div class="panel-title">角色状态 <span class="panel-note">人物或生物在当前剧情状态下的外观（与实体严格分开）</span></div>
      <div class="panel-body">
        <form class="toolbar wrap-toolbar" @submit.prevent="createState">
          <label class="field">
            <span>角色</span>
            <select v-model="newState.characterId">
              <option v-for="e in entities.filter((x) => x.kind === 'character' || x.kind === 'creature')" :key="e.id" :value="e.id">{{ e.name }}</option>
            </select>
          </label>
          <label class="field"><span>名称</span><input v-model="newState.name" placeholder="如：雨夜湿衣状态" /></label>
          <label class="field"><span>服装 / 外观</span><input v-model="newState.costume" placeholder="服装、装甲或皮毛状态" /></label>
          <label class="field"><span>发型 / 毛发</span><input v-model="newState.hair" placeholder="发型或毛发状态" /></label>
          <label class="field"><span>伤势</span><input v-model="newState.injury" placeholder="forehead_cut" /></label>
          <label class="field"><span>手持物</span><input v-model="newState.heldItems" placeholder="umbrella, phone" /></label>
          <button class="primary" :disabled="!newState.name || !entities.some((e) => e.kind === 'character' || e.kind === 'creature')">创建状态</button>
        </form>
        <EmptyState v-if="!states.length" icon="❑" title="还没有角色状态" desc="CharacterState 记录服装 / 发型 / 伤势 / 手持物，是连续性提交与继承的基本单元。" />
        <div v-else class="grid list">
          <article v-for="st in states" :key="st.id" class="card visual-card">
            <img v-if="stateImage(st).asset" class="linked-image" :src="mediaUrl(stateImage(st).asset!.id)" :alt="`${st.name} 状态图`" />
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
            <div class="image-link-row">
              <span :class="['badge', stateImage(st).asset ? 'ok' : 'warn']">
                {{ stateImage(st).asset ? (stateImage(st).inherited ? '继承实体主图' : '状态图覆盖') : '实体尚无主图' }}
              </span>
              <button class="sm" @click="chooseRelatedImage('state', st.id)">{{ st.imageAssetId ? '更换状态图' : '＋ 上传状态图' }}</button>
              <button v-if="st.imageAssetId" class="sm ghost" @click="clearStateImage(st)">恢复继承</button>
            </div>
          </article>
        </div>
      </div>
    </section>

    <!-- Media -->
    <section v-if="tab === 'media'" class="panel">
      <div class="panel-title">媒体库 <span class="panel-note">图片与参考音频 — 视频不进入媒体库</span></div>
      <div class="panel-body">
        <div v-if="shotUploadContext" class="context-note">
          <strong>当前上传将关联到来源镜头</strong>
          <span>{{ uploadContextLabel }}</span>
        </div>
        <div class="upload-actions">
          <input ref="imageInput" class="file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple @change="onFilePick" />
          <input ref="audioInput" class="file-input" type="file" accept="audio/mpeg,audio/wav,audio/aac,audio/flac,audio/mp4" multiple @change="onFilePick" />
          <button class="primary" :disabled="uploading > 0" @click="imageInput?.click()">{{ uploading ? '上传中…' : '＋ 上传图片' }}</button>
          <button :disabled="uploading > 0" @click="audioInput?.click()">＋ 上传参考音频</button>
          <span class="muted">图片用于首尾帧或 Ref2VA；音频仅用于 Ref2VA。</span>
        </div>
        <div class="drop" @dragover.prevent @drop.prevent="onDrop">
          <div class="drop-icon">⇩</div>
          <div>也可以拖拽图片或音频到这里</div>
          <div class="drop-hint">png · jpg · webp · gif · mp3 · wav · m4a · flac</div>
        </div>
        <form class="toolbar" @submit.prevent="importLocalPath">
          <input v-model="importPath" placeholder="或输入图片 / 音频的本地绝对路径" class="grow mono" />
          <button class="primary" :disabled="importing || !importPath">{{ importing ? '导入中…' : '导入路径' }}</button>
        </form>
        <EmptyState v-if="!visibleMedia.length" icon="▦" title="媒体库为空" desc="上传首尾帧、Ref2VA 参考图片或参考音频，之后再到 Shot 中绑定用途。" />
        <label v-if="media.some((m) => m.source === 'frame_extract')" class="muted sys-toggle">
          <input v-model="showSystemFrames" type="checkbox" />
          显示系统帧资产（Take 首尾帧，供尾帧桥接使用）
        </label>
        <div v-if="visibleMedia.length" class="grid list">
          <article v-for="m in visibleMedia" :key="m.id" class="card media-card">
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
                  <button class="icon-btn danger" title="删除资产" @click="removeMedia(m)">🗑</button>
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
.return-bar { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 12px 14px; margin-bottom: 14px; border: 1px solid var(--accent-line); border-radius: 9px; background: var(--accent-soft); }
.return-bar > div { display: flex; flex-direction: column; gap: 2px; }
.return-bar strong { font-size: 13px; }
.return-bar span { color: var(--text-2); font-size: 11.5px; }
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
.visual-card { overflow: hidden; }
.linked-image { width: calc(100% + 28px); height: 168px; margin: -14px -14px 6px; object-fit: contain; object-position: center; background: var(--inset); border-bottom: 1px solid var(--line); }
.image-link-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: auto; padding-top: 7px; border-top: 1px dashed var(--line); }
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
.upload-actions { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.file-input { display: none; }
.context-note { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; padding: 10px 12px; border: 1px solid var(--accent-line); border-radius: 8px; background: var(--accent-soft); }
.context-note strong { font-size: 12.5px; }
.context-note span { color: var(--text-2); font-size: 12px; }
.drop:hover { border-color: var(--accent); background: var(--accent-soft); }
.drop-icon { font-size: 20px; color: var(--accent); margin-bottom: 2px; }
.drop-hint { font-size: 11.5px; color: var(--text-3); margin-top: 3px; }
.thumb {
  position: relative; height: 132px; border-radius: 8px; overflow: hidden;
  background: var(--inset); border: 1px solid var(--line);
  display: flex; align-items: center; justify-content: center;
}
.thumb img { width: 100%; height: 100%; object-fit: contain; object-position: center; }
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
.sys-toggle { display: inline-flex; align-items: center; gap: 6px; margin: 0 0 10px; cursor: pointer; }
.sys-toggle input { width: auto; }
</style>
