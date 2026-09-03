<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { H3Mode, MediaAsset, ReferenceBinding, ReferenceRole } from '@h3mise/shared';
import { fileUrl, get, mediaUrl } from '../../api/client';
import { t } from '../../stores/locale';

const props = defineProps<{
  bindings: ReferenceBinding[];
  media: MediaAsset[];
  currentMode: H3Mode;
  uploadPath: string;
  onAdd: (input: { assetId: string; roles: ReferenceRole[]; label?: string }) => Promise<void>;
  onUpdate: (id: string, patch: Partial<ReferenceBinding>) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}>();

const pickerOpen = ref(false);
const pickAsset = ref('');
const pickGroup = ref('');
const slots = ref<{ firstFrame: boolean; lastFrame: boolean; images: number; audios: number; total: number }>({
  firstFrame: false, lastFrame: false, images: 0, audios: 0, total: 0,
});
const slotsLoaded = ref(false);

onMounted(async () => {
  try {
    const profile = await get<{ bindingSlots?: typeof slots.value } | null>('/api/providers/runninghub/profile');
    if (profile?.bindingSlots) slots.value = profile.bindingSlots;
  } catch {
    slots.value = { firstFrame: false, lastFrame: false, images: 0, audios: 0, total: 0 };
  }
  slotsLoaded.value = true;
});

interface RefGroup { id: string; label: string; limit: number; items: MediaAsset[]; role?: ReferenceRole }

/** Only expose slots that the current generation path can actually submit. */
const groups = computed<RefGroup[]>(() => {
  const images = props.media.filter((m) => m.kind === 'image');
  const audios = props.media.filter((m) => m.kind === 'audio');
  const videos = props.media.filter((m) => m.kind === 'video');
  const out: RefGroup[] = [];
  if (props.currentMode === 'ref2va') {
    if (slots.value.images > 0) out.push({ id: 'refimg', label: t('shot.references.refImages'), limit: slots.value.images, items: images });
    if (slots.value.audios > 0) out.push({ id: 'refaudio', label: t('shot.references.refAudio'), limit: slots.value.audios, items: audios });
    // Camera-motion reference clips are real consumable inputs where the
    // workflow supports video references (ComfyUI). RunningHub has no video
    // slots — preflight reports that honestly, instead of hiding the bind.
    if (videos.length) out.push({ id: 'refvideo', label: t('shot.references.refVideo'), limit: 12, items: videos, role: 'camera_motion' });
    return out;
  }
  if ((props.currentMode === 'i2va' || props.currentMode === 'fl2va') && slots.value.firstFrame) {
    out.push({ id: 'first', label: t('shot.references.firstFrameImage'), limit: 1, items: images, role: 'first_frame' });
  }
  if ((props.currentMode === 'l2va' || props.currentMode === 'fl2va') && slots.value.lastFrame) {
    out.push({ id: 'last', label: t('shot.references.lastFrameImage'), limit: 1, items: images, role: 'last_frame' });
  }
  return out;
});

const hasSlots = computed(() => groups.value.length > 0);
const videosAvailable = computed(() => props.media.some((m) => m.kind === 'video'));
const modeHint = computed(() => t(`shot.references.modeHint.${props.currentMode}`));
/** Ref2VA is slower and pricier — if the shot only has frame images and no
 * other references, the dedicated frame modes do the same job for less. */
const suggestFrameMode = computed(() => {
  if (props.currentMode !== 'ref2va') return '';
  const imageBindings = props.bindings.filter((b) => b.type === 'image');
  const hasNonFrameRefs =
    props.bindings.some((b) => b.type === 'audio') || imageBindings.some((b) => !b.roles.includes('first_frame') && !b.roles.includes('last_frame'));
  if (hasNonFrameRefs || !imageBindings.length) return '';
  const roles = imageBindings.flatMap((b) => b.roles);
  if (roles.includes('first_frame') && roles.includes('last_frame')) return 'fl2va';
  return roles.includes('last_frame') ? 'l2va' : 'i2va';
});

/** Official RunningHub cap is 12 total refs (slots may offer more). */
const refTotalCap = computed(() => Math.min(slots.value.total, 12));
const selectedGroup = computed(() => groups.value.find((group) => group.id === pickGroup.value) ?? null);
const selectedGroupHasSpace = computed(() => selectedGroup.value ? remaining(selectedGroup.value) > 0 : false);

function thumb(m: MediaAsset | undefined): string | null {
  if (!m) return null;
  if (m.kind === 'image') return mediaUrl(m.id);
  if (m.posterPath) return fileUrl(m.posterPath);
  return null;
}

async function add() {
  if (!pickAsset.value) return;
  const asset = props.media.find((m) => m.id === pickAsset.value);
  const g = groups.value.find((x) => x.id === pickGroup.value);
  await props.onAdd({ assetId: pickAsset.value, roles: g?.role ? [g.role] : [], label: asset?.label });
  pickerOpen.value = false;
  pickAsset.value = '';
  pickGroup.value = '';
}

/** How many more of this asset's type the group still accepts. */
function remaining(g: RefGroup): number {
  const used = props.bindings.filter((b) => {
    if (g.id === 'first') return b.roles.includes('first_frame');
    if (g.id === 'last') return b.roles.includes('last_frame');
    return g.items.some((m) => m.id === b.assetId);
  }).length;
  return Math.max(0, g.limit - used);
}

function selectAsset(group: RefGroup, assetId: string) {
  if (remaining(group) === 0) return;
  pickAsset.value = assetId;
  pickGroup.value = group.id;
}
</script>

<template>
  <div class="col">
    <div class="row">
      <button class="primary sm" @click="pickerOpen = !pickerOpen">＋ {{ t('shot.references.bindReference') }}</button>
      <router-link :to="uploadPath" class="sm upload-link">{{ t('shot.references.uploadNewAsset') }}</router-link>
      <span v-if="!bindings.length" class="muted">{{ modeHint }}</span>
    </div>

    <div v-if="suggestFrameMode" class="note">
      {{ t('shot.references.frameModeSuggestionBefore') }} <strong>{{ suggestFrameMode.toUpperCase() }}</strong>{{ t('shot.references.frameModeSuggestionAfter') }}
    </div>

    <div v-if="pickerOpen" class="panel picker">
      <div class="panel-title">{{ t('shot.references.bindByWorkflowSlot') }}</div>
      <div class="panel-body col">
        <template v-if="slotsLoaded && hasSlots">
          <div v-for="g in groups" :key="g.id" class="role-group">
            <span class="muted group-cn">{{ g.label }}<span class="group-limit">{{ t('shot.references.limitAvailable', { limit: g.limit, remaining: remaining(g) }) }}</span></span>
            <div class="asset-pick">
              <div
                v-for="m in g.items"
                :key="m.id"
                class="asset-opt"
                :class="{ on: pickAsset === m.id && pickGroup === g.id }"
                :style="{ opacity: remaining(g) === 0 ? 0.4 : 1 }"
                @click="selectAsset(g, m.id)"
              >
                <div class="opt-thumb">
                  <img v-if="thumb(m)" :src="thumb(m)!" :alt="m.label" />
                  <span v-else class="mono muted">{{ m.kind === 'audio' ? '♪' : m.kind === 'video' ? '▶' : '▧' }}</span>
                </div>
                <div class="opt-label" :title="m.label || m.id">{{ m.label || m.id }}</div>
                <div class="muted">{{ m.kind }}</div>
              </div>
              <div v-if="!g.items.length" class="muted">{{ t('shot.references.noAssetsOfType', { type: g.label }) }}<router-link :to="uploadPath">{{ t('shot.references.uploadAndLink') }}</router-link>。</div>
            </div>
          </div>
          <div class="note">
            <template v-if="currentMode === 'ref2va'">
              {{ t('shot.references.refModeLimits', { images: slots.images, audios: slots.audios, total: refTotalCap }) }}
              {{ t('shot.references.firstFrameBehavior') }}
              <template v-if="videosAvailable">
                {{ t('shot.references.videoRefNote') }}
              </template>
            </template>
            <template v-else>
              {{ t('shot.references.frameControlModeBefore') }} <strong>{{ currentMode.toUpperCase() }}</strong>{{ t('shot.references.frameControlModeAfter') }}
            </template>
          </div>
        </template>
        <div v-else class="note">
          {{ !slotsLoaded ? t('shot.references.loadingSlots') : currentMode === 't2va' ? t('shot.references.t2vaNoReferences') : t('shot.references.noExecutableSlots') }}
        </div>
        <div class="row">
          <button class="primary sm" :disabled="!pickAsset || !hasSlots || !selectedGroupHasSpace" @click="add">{{ t('shot.common.bind') }}</button>
          <button class="sm" @click="pickerOpen = false">{{ t('common.cancel') }}</button>
        </div>
      </div>
    </div>

    <div v-for="b in bindings" :key="b.id" class="panel binding">
      <div class="binding-row">
        <div class="b-thumb">
          <img v-if="thumb(media.find((m) => m.id === b.assetId))" :src="thumb(media.find((m) => m.id === b.assetId))!" :alt="b.label" />
          <span v-else class="mono muted">{{ b.type === 'audio' ? '♪' : '▶' }}</span>
        </div>
        <div class="col grow binding-meta">
          <div class="row wrap">
            <span class="binding-label">{{ b.label || b.id }}</span>
            <span class="badge accent no-dot">{{ b.type }}</span>
            <span class="muted mono">{{ b.id }}</span>
          </div>
          <div class="tags">
            <span v-if="!b.roles.length" class="tag active">{{ b.type === 'audio' ? 'RefAudio' : 'RefImage' }}</span>
            <span v-for="r in b.roles" :key="r" class="tag active">{{ r }}</span>
          </div>
          <div v-if="b.preserve.length || b.ignore.length" class="muted">
            preserve: {{ b.preserve.join(', ') || '—' }} · ignore: {{ b.ignore.join(', ') || '—' }}
          </div>
        </div>
        <button class="sm ghost" @click="onRemove(b.id)">{{ t('shot.common.remove') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wrap { flex-wrap: wrap; }
.upload-link { display: inline-flex; align-items: center; text-decoration: none; }
.picker { border-color: var(--accent); }
.asset-pick { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; max-height: 240px; overflow: auto; }
.asset-opt { border: 1.5px solid var(--line); border-radius: var(--radius-sm); padding: 6px; cursor: pointer; text-align: center; transition: border-color 0.12s, background 0.12s; }
.asset-opt:hover { border-color: var(--line-2); }
.asset-opt.on { border-color: var(--accent); background: var(--accent-soft); }
.opt-thumb { height: 54px; border-radius: 4px; overflow: hidden; background: var(--inset); display: flex; align-items: center; justify-content: center; margin-bottom: 4px; }
.opt-thumb img { width: 100%; height: 100%; object-fit: cover; }
.opt-label { font-size: 11px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.role-group { display: flex; align-items: flex-start; gap: 10px; }
.group-cn { flex: none; width: 76px; padding-top: 3px; font-weight: 500; }
.group-limit { display: block; font-size: 10.5px; font-weight: 400; color: var(--text-3); margin-top: 2px; }
.roles { display: flex; flex-wrap: wrap; gap: 2px; }
.note { font-size: 12px; color: var(--text-3); line-height: 1.6; background: var(--bg-subtle); border: 1px dashed var(--line-2); border-radius: 8px; padding: 10px 12px; }
.binding { padding: 10px 12px; }
.binding-row { display: flex; gap: 10px; align-items: flex-start; }
.b-thumb { width: 64px; height: 44px; flex: none; border-radius: 5px; overflow: hidden; background: var(--inset); display: flex; align-items: center; justify-content: center; }
.b-thumb img { width: 100%; height: 100%; object-fit: cover; }
.binding-meta { gap: 4px; }
.binding-label { font-weight: 600; }
.tags { display: flex; flex-wrap: wrap; }
</style>
