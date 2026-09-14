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
const visibleMedia = computed(() => {
  let list = showSystemFrames.value ? media.value : media.value.filter((m) => m.source !== 'frame_extract');
  return list.filter((m) => m.kind !== 'video');
});
const videos = computed(() => media.value.filter((m) => m.kind === 'video'));
function formatDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m > 0 ? `${m}:${String(sec).padStart(2, '0')}` : `${sec}s`;
}
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
const videoInput = ref<HTMLInputElement | null>(null);
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
  if (ctx.role === 'first_frame') return t('pages.assets.context.autoFirstFrame');
  if (ctx.role === 'last_frame') return t('pages.assets.context.autoLastFrame');
  if (ctx.mode === 'ref2va') return t('pages.assets.context.autoRef2va');
  return t('pages.assets.context.returnToShot');
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
      toasts.push({ kind: 'ok', text: t('pages.assets.entity.updated') });
    } else if (e.kind === 'state') {
      await patch(`/api/assets/character-states/${e.item.id}`, {
        name: e.item.name,
        costume: e.item.costume,
        hair: e.item.hair,
        injury: e.item.injury,
        heldItems: e.item.heldItems,
      });
      toasts.push({ kind: 'ok', text: t('pages.assets.states.updated') });
    } else if (e.kind === 'media') {
      await patch(`/api/assets/media/${e.item.id}`, { label: e.item.label, tags: e.item.tags });
      toasts.push({ kind: 'ok', text: t('pages.assets.media.updated') });
    } else {
      await patch(`/api/assets/bindings/${e.item.id}`, { label: e.item.label, roles: e.item.roles });
      toasts.push({ kind: 'ok', text: t('pages.assets.bindings.updated') });
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
  toasts.push({ kind: 'ok', text: t('pages.assets.entity.created', { name: newEntity.value.name }) });
  newEntity.value = { kind: 'character', name: '', description: '', traits: '' };
  await load();
}

async function removeEntity(e: Entity) {
  const ok = await confirmDialog({
    title: t('pages.assets.entity.deleteTitle', { name: e.name }),
    message: t('pages.assets.entity.deleteMessage'),
    confirmLabel: t('common.delete'),
    danger: true,
  });
  if (!ok) return;
  await del(`/api/assets/entities/${e.id}`);
  toasts.push({ kind: 'ok', text: t('pages.assets.entity.deleted', { name: e.name }) });
  await load();
}

async function createState() {
  if (!newState.value.name.trim()) {
    toasts.push({ kind: 'err', text: t('pages.assets.states.nameRequired') });
    return;
  }
  await post('/api/assets/character-states', {
    ...newState.value,
    heldItems: newState.value.heldItems.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
  });
  toasts.push({ kind: 'ok', text: t('pages.assets.states.created', { name: newState.value.name }) });
  newState.value = { ...newState.value, name: '', costume: '', hair: '', injury: '', heldItems: '' };
  await load();
}

async function removeState(st: CharacterState) {
  const ok = await confirmDialog({ title: t('pages.assets.states.deleteTitle', { name: st.name }), message: t('common.irreversible'), confirmLabel: t('common.delete'), danger: true });
  if (!ok) return;
  await del(`/api/assets/character-states/${st.id}`);
  toasts.push({ kind: 'ok', text: t('pages.assets.states.deleted') });
  await load();
}

async function importFile(file: File): Promise<MediaAsset | null> {
  if (!file.type.startsWith('image/') && !file.type.startsWith('audio/') && !file.type.startsWith('video/')) {
    toasts.push({ kind: 'err', text: t('pages.assets.media.unsupported', { name: file.name }) });
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
    toasts.push({ kind: 'err', text: t('pages.assets.media.uploadFailed', { msg: e instanceof Error ? e.message : String(e) }) });
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
  else if (ctx.mode === 'vref2va' && (asset.kind === 'video' || asset.kind === 'image')) roles = asset.kind === 'video' ? ['motion'] : [];
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
    toasts.push({ kind: 'ok', text: linked ? t('pages.assets.media.uploadedLinked', { name: file.name }) : t('pages.assets.media.imported', { name: file.name }) });
  } catch (error) {
    toasts.push({ kind: 'err', text: t('pages.assets.media.uploadedLinkedShotFailed', { msg: error instanceof Error ? error.message : String(error) }) });
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
    const label = `${ownerName || file.name}${target.kind === 'entity' ? t('pages.assets.media.imageRolePrimary') : t('pages.assets.media.imageRoleState')}`;
    await patch(`/api/assets/media/${asset.id}`, { label });
    const path = target.kind === 'entity' ? `/api/assets/entities/${target.id}` : `/api/assets/character-states/${target.id}`;
    await patch(path, { imageAssetId: asset.id });
    const linked = await associateWithSourceShot({ ...asset, label });
    toasts.push({
      kind: 'ok',
      text: `${target.kind === 'entity' ? t('pages.assets.states.imageUpdated') : t('pages.assets.states.imageReplaced')}${linked ? t('pages.assets.states.andLinkedShot') : ''}`,
    });
    await load();
  } catch (error) {
    toasts.push({ kind: 'err', text: t('pages.assets.media.uploadedLinkFailed', { msg: error instanceof Error ? error.message : String(error) }) });
  }
}

async function clearStateImage(state: CharacterState) {
  await patch(`/api/assets/character-states/${state.id}`, { imageAssetId: null });
  toasts.push({ kind: 'ok', text: t('pages.assets.states.inheritRestored') });
  await load();
}

async function importLocalPath() {
  importing.value = true;
  try {
    const a = await post<MediaAsset>('/api/assets/media/import-path', { path: importPath.value });
    const linked = await associateWithSourceShot(a);
    toasts.push({ kind: 'ok', text: linked ? t('pages.assets.media.importedLinked', { label: a.label }) : t('pages.assets.media.importedWithKind', { label: a.label, kind: a.kind }) });
    importPath.value = '';
    await load();
  } catch (e) {
    toasts.push({ kind: 'err', text: t('pages.assets.media.importFailed', { msg: e instanceof Error ? e.message : String(e) }) });
  } finally {
    importing.value = false;
  }
}

async function extractFrame(assetId: string) {
  const a = await post<MediaAsset>(`/api/assets/media/${assetId}/extract-frame`, { atSeconds: 0, label: 'Extracted frame' });
  toasts.push({ kind: 'ok', text: t('pages.assets.media.frameExtracted', { id: a.id }) });
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
    usage.bindings ? t('pages.assets.usage.shotBindings', { n: usage.bindings }) : '',
    usage.entities ? t('pages.assets.usage.entityImages', { n: usage.entities }) : '',
    usage.states ? t('pages.assets.usage.stateImages', { n: usage.states }) : '',
  ].filter(Boolean);
  const ok = await confirmDialog({
    title: t('pages.assets.deleteAsset.title', { name: asset.label || asset.id }),
    message: impacts.length
      ? t('pages.assets.deleteAsset.inUse', { impacts: impacts.join('、') })
      : t('pages.assets.deleteAsset.confirmMessage'),
    confirmLabel: t('pages.assets.deleteAsset.confirm'),
    danger: true,
  });
  if (!ok) return;
  try {
    await del(`/api/assets/media/${asset.id}`);
  } catch (e) {
    toasts.push({ kind: 'err', text: e instanceof Error ? e.message : t('pages.assets.deleteAsset.failed') });
    return;
  }
  toasts.push({ kind: 'ok', text: t('pages.assets.deleteAsset.done') });
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
        <strong>{{ linkedOnVisit ? t('pages.assets.context.linked') : t('pages.assets.context.fromShot') }}</strong>
        <span>{{ uploadContextLabel || t('pages.assets.context.returnToPage') }}</span>
      </div>
      <button :class="linkedOnVisit ? 'primary' : ''" @click="goBackToSource">{{ t('pages.assets.context.backToShot') }}</button>
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
            <img v-if="entityImage(e)" class="linked-image" :src="mediaUrl(entityImage(e)!.id)" :alt="t('pages.assets.entity.primaryAlt', { name: e.name })" />
            <div class="card-top">
              <span class="kind-badge" :style="{ color: KIND_COLOR[e.kind], background: `${KIND_COLOR[e.kind]}1a`, borderColor: `${KIND_COLOR[e.kind]}55` }">{{ kindLabel(e.kind) }}</span>
              <h3 class="card-name" :title="e.name">{{ e.name }}</h3>
              <div class="card-actions">
                <button class="icon-btn" :title="t('common.edit')" @click="editing = { kind: 'entity', item: e }">✎</button>
                <button class="icon-btn danger" :title="t('common.delete')" @click="removeEntity(e)">🗑</button>
              </div>
            </div>
            <p class="card-desc">{{ e.description || '—' }}</p>
            <p v-if="Object.keys(e.traits).length" class="card-meta">{{ Object.entries(e.traits).map(([k, v]) => `${k}: ${v}`).join(' · ') }}</p>
            <div class="image-link-row">
              <span :class="['badge', entityImage(e) ? 'ok' : 'warn']">{{ entityImage(e) ? t('pages.assets.entity.boundPrimary') : t('pages.assets.entity.missingPrimary') }}</span>
              <button class="sm" @click="chooseRelatedImage('entity', e.id)">{{ entityImage(e) ? t('pages.assets.entity.replacePrimary') : t('pages.assets.entity.uploadPrimary') }}</button>
            </div>
          </article>
        </div>
      </div>
    </section>

    <!-- CharacterStates -->
    <section v-if="tab === 'states'" class="panel">
      <div class="panel-title">{{ t('pages.assets.states.title') }} <span class="panel-note">{{ t('pages.assets.states.note') }}</span></div>
      <div class="panel-body">
        <form class="toolbar wrap-toolbar" @submit.prevent="createState">
          <label class="field">
            <span>{{ t('pages.assets.states.character') }}</span>
            <select v-model="newState.characterId">
              <option v-for="e in entities.filter((x) => x.kind === 'character' || x.kind === 'creature')" :key="e.id" :value="e.id">{{ e.name }}</option>
            </select>
          </label>
          <label class="field"><span>{{ t('pages.assets.states.name') }}</span><input v-model="newState.name" :placeholder="t('pages.assets.states.namePlaceholder')" /></label>
          <label class="field"><span>{{ t('pages.assets.states.costume') }}</span><input v-model="newState.costume" :placeholder="t('pages.assets.states.costumePlaceholder')" /></label>
          <label class="field"><span>{{ t('pages.assets.states.hair') }}</span><input v-model="newState.hair" :placeholder="t('pages.assets.states.hairPlaceholder')" /></label>
          <label class="field"><span>{{ t('pages.assets.states.injury') }}</span><input v-model="newState.injury" :placeholder="t('pages.assets.states.injuryPlaceholder')" /></label>
          <label class="field"><span>{{ t('pages.assets.states.heldItems') }}</span><input v-model="newState.heldItems" :placeholder="t('pages.assets.states.heldItemsPlaceholder')" /></label>
          <button class="primary" :disabled="!newState.name || !entities.some((e) => e.kind === 'character' || e.kind === 'creature')">{{ t('pages.assets.states.create') }}</button>
        </form>
        <EmptyState v-if="!states.length" icon="❑" :title="t('pages.assets.states.emptyTitle')" :desc="t('pages.assets.states.emptyDesc')" />
        <div v-else class="grid list">
          <article v-for="st in states" :key="st.id" class="card visual-card">
            <img v-if="stateImage(st).asset" class="linked-image" :src="mediaUrl(stateImage(st).asset!.id)" :alt="t('pages.assets.states.imageAlt', { name: st.name })" />
            <div class="card-top">
              <span class="kind-badge info">{{ entities.find((e) => e.id === st.characterId)?.name ?? st.characterId }}</span>
              <h3 class="card-name" :title="st.name">{{ st.name }}</h3>
              <div class="card-actions">
                <button class="icon-btn" :title="t('common.edit')" @click="editing = { kind: 'state', item: st }">✎</button>
                <button class="icon-btn danger" :title="t('common.delete')" @click="removeState(st)">🗑</button>
              </div>
            </div>
            <p class="card-desc">{{ t('pages.assets.states.costumeLine', { costume: st.costume || '—', hair: st.hair || '—', injury: st.injury || '—' }) }}</p>
            <p v-if="st.heldItems.length" class="card-meta">{{ t('pages.assets.states.heldLine', { items: st.heldItems.join('、') }) }}</p>
            <div class="image-link-row">
              <span :class="['badge', stateImage(st).asset ? 'ok' : 'warn']">
                {{ stateImage(st).asset ? (stateImage(st).inherited ? t('pages.assets.states.imageInherited') : t('pages.assets.states.imageOverride')) : t('pages.assets.states.noEntityImage') }}
              </span>
              <button class="sm" @click="chooseRelatedImage('state', st.id)">{{ st.imageAssetId ? t('pages.assets.states.replaceImage') : t('pages.assets.states.uploadImage') }}</button>
              <button v-if="st.imageAssetId" class="sm ghost" @click="clearStateImage(st)">{{ t('pages.assets.states.restoreInherit') }}</button>
            </div>
          </article>
        </div>
      </div>
    </section>

    <!-- Media -->
    <section v-if="tab === 'media'" class="panel">
      <div class="panel-title">{{ t('pages.assets.media.title') }} <span class="panel-note">{{ t('pages.assets.media.note') }}</span></div>
      <div class="panel-body">
        <div v-if="shotUploadContext" class="context-note">
          <strong>{{ t('pages.assets.media.uploadContext') }}</strong>
          <span>{{ uploadContextLabel }}</span>
        </div>
        <div class="upload-actions">
          <input ref="imageInput" class="file-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple @change="onFilePick" />
          <input ref="audioInput" class="file-input" type="file" accept="audio/mpeg,audio/wav,audio/aac,audio/flac,audio/mp4" multiple @change="onFilePick" />
          <button class="primary" :disabled="uploading > 0" @click="imageInput?.click()">{{ uploading ? t('pages.assets.media.uploading') : t('pages.assets.media.uploadImage') }}</button>
          <button :disabled="uploading > 0" @click="audioInput?.click()">{{ t('pages.assets.media.uploadAudio') }}</button>
          <input ref="videoInput" class="file-input" type="file" accept="video/mp4,video/webm,video/quicktime" multiple @change="onFilePick" />
          <button :disabled="uploading > 0" @click="videoInput?.click()">{{ t('pages.assets.media.uploadVideo') }}</button>
          <span class="muted">{{ t('pages.assets.media.kindsHint') }}</span>
        </div>
        <div class="drop" @dragover.prevent @drop.prevent="onDrop">
          <div class="drop-icon">⇩</div>
          <div>{{ t('pages.assets.media.dropTitle') }}</div>
          <div class="drop-hint">{{ t('pages.assets.media.dropHint') }}</div>
        </div>
        <form class="toolbar" @submit.prevent="importLocalPath">
          <input v-model="importPath" :placeholder="t('pages.assets.media.importPlaceholder')" class="grow mono" />
          <button class="primary" :disabled="importing || !importPath">{{ importing ? t('pages.assets.media.importing') : t('pages.assets.media.importPath') }}</button>
        </form>
        <EmptyState v-if="!visibleMedia.length && !videos.length" icon="▦" :title="t('pages.assets.noVideosTitle')" :desc="t('pages.assets.noVideosDesc')" />
        <!-- Video Showcase — 拉片入口 -->
        <div v-if="videos.length" class="video-showcase">
          <div class="video-showcase-head">
            <h3>{{ t('pages.assets.videoShowcase') }}</h3>
            <span class="muted">{{ t('pages.assets.videoShowcaseDesc') }}</span>
          </div>
          <div class="video-grid">
            <router-link
              v-for="v in videos"
              :key="v.id"
              :to="`/assets/${v.id}/breakdown`"
              class="video-card"
            >
              <div class="video-thumb">
                <img v-if="thumbOf(v)" :src="thumbOf(v)!" :alt="v.label" loading="lazy" />
                <span v-else class="thumb-glyph">▶</span>
                <span class="video-play">▶</span>
                <span v-if="v.durationSeconds" class="video-duration">{{ formatDuration(v.durationSeconds) }}</span>
              </div>
              <div class="video-info">
                <span class="video-title">{{ v.label || v.fileName }}</span>
                <span class="video-meta">{{ v.width }}×{{ v.height }} · {{ (v.sizeBytes / 1024 / 1024).toFixed(1) }} MB</span>
                <span class="video-action">{{ t('pages.assets.enterBreakdown') }}</span>
              </div>
            </router-link>
          </div>
        </div>
        <label v-if="media.some((m) => m.source === 'frame_extract')" class="muted sys-toggle">
          <input v-model="showSystemFrames" type="checkbox" />
          {{ t('pages.assets.media.showSystemFrames') }}
        </label>
        <div v-if="visibleMedia.length" class="grid list">
          <article v-for="m in visibleMedia" :key="m.id" class="card media-card">
            <div class="thumb">
              <img v-if="thumbOf(m)" :src="thumbOf(m)!" :alt="m.label" loading="lazy" />
              <span v-else class="thumb-glyph">{{ m.kind === 'audio' ? '♪' : '▧' }}</span>
            </div>
            <div class="media-body">
              <div class="card-top">
                <h3 class="card-name media-name" :title="m.label || m.id">{{ m.label || m.id }}</h3>
                <div class="card-actions">
                  <span class="type-chip">{{ m.kind }}</span>
                  <button class="icon-btn" :title="t('common.edit')" @click="editing = { kind: 'media', item: m }">✎</button>
                  <button class="icon-btn danger" :title="t('pages.assets.media.deleteAsset')" @click="removeMedia(m)">🗑</button>
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
      <div class="panel-title">{{ t('pages.assets.bindings.title') }} <span class="panel-note">{{ t('pages.assets.bindings.note') }}</span></div>
      <div class="panel-body">
        <EmptyState v-if="!bindings.length" icon="➶" :title="t('pages.assets.bindings.emptyTitle')" :desc="t('pages.assets.bindings.emptyDesc')" />
        <div v-else class="bind-list">
          <article v-for="b in bindings" :key="b.id" class="card binding-card">
            <span class="type-chip">{{ b.type }}</span>
            <h3 class="card-name" :title="b.label || b.id">{{ b.label || b.id }}</h3>
            <span class="asset-label">{{ media.find((m) => m.id === b.assetId)?.label ?? b.assetId }}</span>
            <div class="roles">
              <span v-for="r in b.roles" :key="r" class="tag active">{{ r }}</span>
            </div>
            <button class="icon-btn" :title="t('common.edit')" @click="editing = { kind: 'binding', item: b }">✎</button>
          </article>
        </div>
      </div>
    </section>
  </div>

  <div v-if="editing" class="modal-mask" @click.self="editing = null">
    <div class="modal panel">
      <div class="modal-head">
        <span>{{ t('pages.assets.modal.edit') }}{{ editing.kind === 'entity' ? t('pages.assets.modal.entity') : editing.kind === 'state' ? t('pages.assets.modal.state') : editing.kind === 'media' ? t('pages.assets.modal.media') : t('pages.assets.modal.binding') }}</span>
        <span class="t-close" @click="editing = null">✕</span>
      </div>
      <div class="modal-body">
        <template v-if="editing.kind === 'entity'">
          <label class="field"><span>{{ t('pages.assets.modal.name') }}</span><input v-model="editing.item.name" /></label>
          <label class="field"><span>{{ t('pages.assets.modal.type') }}</span>
            <select v-model="editing.item.kind">
              <option v-for="k in KINDS" :key="k" :value="k">{{ kindLabel(k) }}</option>
            </select>
          </label>
          <label class="field"><span>{{ t('pages.assets.modal.description') }}</span><textarea v-model="editing.item.description" rows="3"></textarea></label>
          <label class="field"><span>{{ t('pages.assets.modal.traits') }}</span><textarea rows="3" :value="traitsText(editing.item.traits)" @change="editing.item.traits = traitsFromText(($event.target as HTMLTextAreaElement).value)"></textarea></label>
        </template>
        <template v-else-if="editing.kind === 'state'">
          <label class="field"><span>{{ t('pages.assets.modal.stateName') }}</span><input v-model="editing.item.name" /></label>
          <label class="field"><span>{{ t('pages.assets.states.costume') }}</span><input v-model="editing.item.costume" /></label>
          <label class="field"><span>{{ t('pages.assets.states.hair') }}</span><input v-model="editing.item.hair" /></label>
          <label class="field"><span>{{ t('pages.assets.states.injury') }}</span><input v-model="editing.item.injury" /></label>
          <label class="field"><span>{{ t('pages.assets.states.heldItems') }}</span><input :value="editing.item.heldItems.join(', ')" @change="editing.item.heldItems = ($event.target as HTMLInputElement).value.split(/[,，]/).map((s) => s.trim()).filter(Boolean)" /></label>
        </template>
        <template v-else-if="editing.kind === 'media'">
          <label class="field"><span>{{ t('pages.assets.modal.label') }}</span><input v-model="editing.item.label" /></label>
          <label class="field"><span>{{ t('pages.assets.modal.tags') }}</span><input :value="editing.item.tags.join(', ')" @change="editing.item.tags = ($event.target as HTMLInputElement).value.split(/[,，]/).map((x) => x.trim()).filter(Boolean)" /></label>
          <p class="muted">{{ t('pages.assets.modal.fileName', { name: editing.item.fileName }) }}</p>
        </template>
        <template v-else>
          <label class="field"><span>{{ t('pages.assets.modal.label') }}</span><input v-model="editing.item.label" /></label>
          <label class="field"><span>{{ t('pages.assets.modal.roles') }}</span><input :value="editing.item.roles.join(', ')" @change="editing.item.roles = ($event.target as HTMLInputElement).value.split(/[,，]/).map((x) => x.trim()).filter(Boolean) as never" /></label>
        </template>
        <div class="modal-foot">
          <button class="primary" @click="saveEdit">{{ t('common.save') }}</button>
          <button class="ghost" @click="editing = null">{{ t('common.cancel') }}</button>
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
.head-titles h1 { font-size: 28px; line-height: 1.15; margin: 0; font-weight: 700; letter-spacing: -0.03em; margin-bottom: 4px; }
.page-sub { margin: 6px 0 0; font-size: 13px; color: var(--text-3); }
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
.breakdown-link { position: absolute; bottom: 8px; left: 8px; padding: 6px 10px; background: var(--bg-2); border-radius: 6px; font-size: 12px; color: var(--accent-text); }
.extract:hover { color: var(--text); border-color: var(--line-2); }
.media-body { padding: 10px 2px 0; display: flex; flex-direction: column; gap: 4px; }
.media-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- video showcase (拉片入口) ---------- */
.video-showcase { margin-bottom: 20px; }
.video-showcase-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.video-showcase-head h3 { font-size: 15px; font-weight: 600; margin: 0; }
.video-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
.video-card {
  display: block; text-decoration: none; color: inherit;
  border: 1px solid var(--line); border-radius: 10px; overflow: hidden;
  background: var(--bg-2); box-shadow: var(--shadow-1);
  transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
}
.video-card:hover { border-color: var(--accent-line); transform: translateY(-2px); box-shadow: var(--shadow-2); text-decoration: none; }
.video-thumb {
  position: relative; height: 160px; background: #14191c;
  display: flex; align-items: center; justify-content: center; overflow: hidden;
}
.video-thumb img { width: 100%; height: 100%; object-fit: cover; }
.video-play {
  position: absolute; width: 44px; height: 44px; border-radius: 50%;
  background: rgba(0,0,0,0.55); color: #fff; font-size: 18px;
  display: flex; align-items: center; justify-content: center;
  opacity: 0; transition: opacity 0.15s;
}
.video-card:hover .video-play { opacity: 1; }
.video-duration {
  position: absolute; bottom: 6px; right: 6px;
  background: rgba(0,0,0,0.7); color: #fff; font-size: 11px; font-weight: 600;
  padding: 2px 7px; border-radius: 4px; font-variant-numeric: tabular-nums;
}
.video-info { padding: 10px 12px; display: flex; flex-direction: column; gap: 3px; }
.video-title { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.video-meta { font-size: 11.5px; color: var(--text-3); font-family: var(--mono); }
.video-action { font-size: 12px; color: var(--accent-text); font-weight: 500; margin-top: 2px; }

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
