<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import type { AudioReferencePolicy, H3Mode, MediaAsset, ReferenceBinding, ReferenceFramePolicy, ReferenceRole, ReferenceUse } from '@h3mise/shared';
import { fileUrl, get, post, mediaUrl } from '../../api/client';
import { t } from '../../stores/locale';

const props = defineProps<{
  bindings: ReferenceBinding[];
  media: MediaAsset[];
  currentMode: H3Mode;
  aspectRatio: string;
  providerId?: string;
  entities?: Array<{ id: string; name: string }>;
  uploadPath: string;
  onAdd: (input: { assetId: string; roles: ReferenceRole[]; label?: string }) => Promise<void>;
  onUpdate: (id: string, patch: Partial<ReferenceBinding>) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}>();
const emit = defineEmits<{ changed: [] }>();
const orderedBindings = ref<ReferenceBinding[]>([...props.bindings]);
const localError = ref('');
const dragIndex = ref<number | null>(null);
watch(() => props.bindings, (bindings) => {
  orderedBindings.value = [...bindings];
  if (reorderBusy.value && bindings.map((binding) => binding.id).join(',') === pendingOrder.join(',')) {
    reorderBusy.value = false;
    pendingOrder = [];
  }
}, { deep: true });

const pickerOpen = ref(false);
const uploadInput = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
const uploadStatus = ref('');
const reorderBusy = ref(false);
let pendingOrder: string[] = [];
const videoProfileNotice = ref('');
async function detectVideoProfile() {
  videoProfileNotice.value = t('shot.references.vrefDetecting');
  try {
    const profile = await post<{ verification: { note: string } }>('/api/providers/runninghub/video-reference-profile/verify', {});
    videoProfileNotice.value = profile.verification.note;
  } catch (error) { videoProfileNotice.value = String(error); }
}
const route = useRoute();
const pickAsset = ref('');
const pickGroup = ref('');
type SlotSet = { firstFrame: boolean; lastFrame: boolean; images: number; audios: number; videos: number; total: number };
const emptySlots: SlotSet = { firstFrame: false, lastFrame: false, images: 0, audios: 0, videos: 0, total: 0 };
const slotsByMode = ref<Record<string, SlotSet> | null>(null);
const fallbackSlots = ref<SlotSet>(emptySlots);
const slots = computed(() => slotsByMode.value?.[props.currentMode] ?? fallbackSlots.value);
const executableSlots = computed<SlotSet>(() => props.providerId === 'mock'
  ? { firstFrame: true, lastFrame: true, images: 9, audios: 3, videos: 1, total: 12 }
  : slots.value);
const slotsLoaded = ref(false);

onMounted(async () => {
  try {
    const profile = await get<{ bindingSlots?: SlotSet; slotsByMode?: Record<string, SlotSet> } | null>('/api/providers/runninghub/profile');
    if (profile?.slotsByMode) slotsByMode.value = profile.slotsByMode;
    if (profile?.bindingSlots) fallbackSlots.value = profile.bindingSlots;
  } catch {
    slotsByMode.value = null;
    fallbackSlots.value = emptySlots;
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
  if (props.currentMode === 'faceswap') return [
    { id: 'faceimg', label: '人脸图片（1 张）', limit: 1, items: images, role: 'identity' },
    { id: 'srcvideo', label: '源视频（1 个）', limit: 1, items: videos, role: 'motion' },
  ];
  if (props.currentMode === 'vref2va') return [
    { id: 'refvideo', label: t('shot.references.vrefGroupVideo'), limit: 1, items: videos, role: 'motion' },
    { id: 'refimg', label: t('shot.references.vrefGroupImages'), limit: 3, items: images },
  ];
  if (props.currentMode === 'ref2va') {
    if (executableSlots.value.images > 0) out.push({ id: 'refimg', label: t('shot.references.refImages'), limit: executableSlots.value.images, items: images });
    if (executableSlots.value.audios > 0) out.push({ id: 'refaudio', label: t('shot.references.refAudio'), limit: executableSlots.value.audios, items: audios });
    // Camera-motion reference clips are real consumable inputs where the
    // active workflow declares video slots. Unsupported workflows are reported
    // honestly by preflight instead of hiding the bind.
    if (videos.length) out.push({ id: 'refvideo', label: t('shot.references.refVideo'), limit: 12, items: videos, role: 'camera_motion' });
    return out;
  }
  if ((props.currentMode === 'i2va' || props.currentMode === 'fl2va') && executableSlots.value.firstFrame) {
    out.push({ id: 'first', label: t('shot.references.firstFrameImage'), limit: 1, items: images, role: 'first_frame' });
  }
  if ((props.currentMode === 'l2va' || props.currentMode === 'fl2va') && executableSlots.value.lastFrame) {
    out.push({ id: 'last', label: t('shot.references.lastFrameImage'), limit: 1, items: images, role: 'last_frame' });
  }
  return out;
});

const hasSlots = computed(() => groups.value.length > 0);
const videosAvailable = computed(() => props.media.some((m) => m.kind === 'video'));
const safetyWarnings = computed(() => {
  const out: string[] = [];
  const images = props.bindings.filter((binding) => binding.type === 'image');
  const identity = images.filter((binding) => binding.roles.includes('identity'));
  if (props.currentMode === 'faceswap' && images.length > 1) {
    out.push('换脸建议只用一张正面人脸图；当前绑定了多张图片，容易产生复制人或身份冲突。');
  } else if (props.currentMode === 'ref2va' && identity.length > 1 && identity.some((binding) => !binding.referenceUse || binding.referenceUse === 'general')) {
    out.push(t('shot.production.references.identityHint'));
  }
  if (images.some((binding) => /四宫格|服装|costume|outfit/i.test(binding.label ?? ''))) {
    out.push('检测到服装/四宫格参考：请确保四宫格不露脸，否则会与人物身份互相干扰。');
  }
  return out;
});
const modeHint = computed(() => props.currentMode === 'vref2va' ? t('shot.references.vrefModeHint') : t(`shot.references.modeHint.${props.currentMode}`));
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
const refTotalCap = computed(() => props.currentMode === 'vref2va' ? 4 : Math.min(executableSlots.value.total, 12));
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

function referenceTag(binding: ReferenceBinding, index: number): string {
  const kind = binding.type === 'image' ? 'Picture' : binding.type === 'audio' ? 'Audio' : 'Video';
  const position = orderedBindings.value.slice(0, index + 1).filter((item) => item.type === binding.type).length;
  return `<${kind} ${position}>`;
}

function aspectMismatch(binding: ReferenceBinding): boolean {
  if (binding.type !== 'image') return false;
  const asset = props.media.find((item) => item.id === binding.assetId);
  const [width, height] = props.aspectRatio.split(':').map(Number);
  if (!asset?.width || !asset.height || !width || !height) return false;
  const target = width / height;
  return Math.abs(asset.width / asset.height - target) / target > 0.02;
}

async function update(id: string, patch: Partial<ReferenceBinding>) {
  localError.value = '';
  try { await props.onUpdate(id, patch); }
  catch (cause) { localError.value = cause instanceof Error ? cause.message : String(cause); }
}

async function changeFramePolicy(binding: ReferenceBinding, policy: ReferenceFramePolicy) {
  localError.value = '';
  try {
    if (policy === 'crop' || policy === 'outpaint') {
      await post(`/api/assets/bindings/${binding.id}/prepare`, { policy });
      emit('changed');
    } else await update(binding.id, { framePolicy: policy });
  } catch (cause) { localError.value = cause instanceof Error ? cause.message : String(cause); }
}

async function updateAudio(binding: ReferenceBinding, patch: Partial<AudioReferencePolicy>) {
  const current = binding.audioPolicy ?? { mode: 'reference' as const, startSeconds: 0, endSeconds: null };
  await update(binding.id, { audioPolicy: { ...current, ...patch } });
}

const roleOptions: Record<ReferenceBinding['type'], ReferenceRole[]> = {
  image: ['identity', 'costume', 'environment', 'lighting', 'style', 'first_frame', 'last_frame'],
  audio: ['audio', 'timing'],
  video: ['motion', 'body_motion', 'camera_motion', 'timing'],
};

async function toggleRole(binding: ReferenceBinding, role: ReferenceRole, checked: boolean) {
  const roles = checked ? [...new Set([...binding.roles, role])] : binding.roles.filter((item) => item !== role);
  await update(binding.id, { roles });
}

async function drop(targetIndex: number) {
  if (dragIndex.value === null || dragIndex.value === targetIndex) return;
  const next = [...orderedBindings.value];
  const [moved] = next.splice(dragIndex.value, 1);
  if (!moved?.shotId) return;
  next.splice(targetIndex, 0, moved);
  orderedBindings.value = next;
  dragIndex.value = null;
  await commitOrder(next);
}

async function commitOrder(next: ReferenceBinding[]) {
  const shotId = next[0]?.shotId;
  if (!shotId || reorderBusy.value) return;
  reorderBusy.value = true;
  pendingOrder = next.map((binding) => binding.id);
  localError.value = '';
  try {
    await post('/api/assets/bindings/reorder', { shotId, ids: next.map((binding) => binding.id) });
    emit('changed');
  } catch (cause) {
    localError.value = cause instanceof Error ? cause.message : String(cause);
    orderedBindings.value = [...props.bindings];
    reorderBusy.value = false;
    pendingOrder = [];
  }
}

async function moveBinding(index: number, delta: number) {
  const target = index + delta;
  if (target < 0 || target >= orderedBindings.value.length) return;
  const next = [...orderedBindings.value];
  const [moved] = next.splice(index, 1);
  if (!moved) return;
  next.splice(target, 0, moved);
  orderedBindings.value = next;
  await commitOrder(next);
}

async function uploadFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  if (!files.length || uploading.value) return;
  uploading.value = true;
  uploadStatus.value = t('shot.production.references.uploading', { count: files.length });
  localError.value = '';
  try {
    for (const file of files) {
      const form = new FormData();
      form.append('file', file);
      form.append('label', file.name);
      const asset = await post<MediaAsset>('/api/assets/media/upload', form);
      const roles: ReferenceRole[] = props.currentMode === 'i2va' || props.currentMode === 'fl2va'
        ? ['first_frame']
        : props.currentMode === 'l2va' ? ['last_frame'] : props.currentMode === 'faceswap' && file.type.startsWith('image/') ? ['identity'] : [];
      await props.onAdd({ assetId: asset.id, roles, label: asset.label });
    }
    uploadStatus.value = t('shot.production.references.uploaded', { count: files.length });
    emit('changed');
  } catch (cause) {
    localError.value = cause instanceof Error ? cause.message : String(cause);
    uploadStatus.value = '';
  } finally {
    uploading.value = false;
    input.value = '';
  }
}

function submittedAssetLabel(binding: ReferenceBinding): string {
  return props.media.find((asset) => asset.id === binding.assetId)?.label ?? binding.label;
}
</script>

<template>
  <div class="col">
    <div v-if="currentMode === 'vref2va'" class="col">
      <span class="muted">{{ t('shot.references.vrefBindHint') }}</span>
      <button class="sm" @click="detectVideoProfile">{{ t('shot.references.vrefDetect') }}</button>
      <span v-if="videoProfileNotice" class="muted">{{ videoProfileNotice }}</span>
    </div>
    <div class="row">
      <input ref="uploadInput" class="file-input" type="file" multiple :accept="currentMode === 'ref2va' ? 'image/*,audio/*' : currentMode === 'vref2va' || currentMode === 'faceswap' ? 'image/*,video/*' : 'image/*'" @change="uploadFiles" />
      <button class="primary sm" :disabled="uploading || currentMode === 't2va'" @click="uploadInput?.click()">{{ uploading ? t('shot.production.references.uploadingShort') : t('shot.production.references.uploadBind') }}</button>
      <button class="primary sm" @click="pickerOpen = !pickerOpen">＋ {{ t('shot.references.bindReference') }}</button>
      <router-link :to="uploadPath" class="sm upload-link">{{ t('shot.production.references.library') }}</router-link>
      <span v-if="!bindings.length" class="muted">{{ modeHint }}</span>
    </div>
    <div v-if="uploadStatus" class="note">{{ uploadStatus }}</div>
    <div v-if="reorderBusy" class="note">{{ t('shot.production.references.savingOrder') }}</div>
    <details v-if="videosAvailable" class="note">
      <summary>{{ t('shot.references.addFromBreakdown') }}</summary>
      <div v-for="m in media.filter(m => m.kind === 'video')" :key="m.id">
        <router-link :to="{ path: `/assets/${m.id}/breakdown`, query: { shotId: String(route.params.id ?? '') } }">{{ m.label || m.id }} {{ t('shot.references.pickSegment') }}</router-link>
      </div>
    </details>

    <div v-if="suggestFrameMode" class="note">
      {{ t('shot.references.frameModeSuggestionBefore') }} <strong>{{ suggestFrameMode.toUpperCase() }}</strong>{{ t('shot.references.frameModeSuggestionAfter') }}
    </div>
    <div v-for="warning in safetyWarnings" :key="warning" class="note warning-note">注意：{{ warning }}</div>

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
              {{ t('shot.references.refModeLimits', { images: executableSlots.images, audios: executableSlots.audios, total: refTotalCap }) }}
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

    <div class="note">{{ t('shot.production.references.order') }}</div>
    <div v-if="localError" class="note warning-note">{{ localError }}</div>
    <div
      v-for="(b, index) in orderedBindings"
      :key="b.id"
      class="panel binding"
      draggable="true"
      @dragstart="dragIndex = index"
      @dragend="dragIndex = null"
      @dragover.prevent
      @drop.prevent="drop(index)"
    >
      <div class="binding-row">
        <div class="b-thumb">
          <img v-if="thumb(media.find((m) => m.id === b.assetId))" :src="thumb(media.find((m) => m.id === b.assetId))!" :alt="b.label" />
          <span v-else class="mono muted">{{ b.type === 'audio' ? '♪' : '▶' }}</span>
        </div>
        <div class="col grow binding-meta">
          <div class="row wrap">
            <span class="badge accent no-dot">{{ referenceTag(b, index) }}</span>
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
          <div v-if="submittedAssetLabel(b) !== b.label" class="derived-note">{{ t('shot.production.references.derived') }}: {{ submittedAssetLabel(b) }}</div>
          <div class="reference-controls">
            <label>{{ t('shot.production.references.use') }}
              <select :value="b.referenceUse ?? 'general'" @change="update(b.id, { referenceUse: ($event.target as HTMLSelectElement).value as ReferenceUse })">
                <option value="general">{{ t('shot.production.references.general') }}</option><option value="face">{{ t('shot.production.references.face') }}</option><option value="full_body">{{ t('shot.production.references.full_body') }}</option><option value="costume">{{ t('shot.production.references.costume') }}</option><option value="pose">{{ t('shot.production.references.pose') }}</option><option value="expression">{{ t('shot.production.references.expression') }}</option><option value="three_view">{{ t('shot.production.references.three_view') }}</option><option value="seated">{{ t('shot.production.references.seated') }}</option><option value="scene_plate">{{ t('shot.production.references.scene_plate') }}</option><option value="lighting">{{ t('shot.production.references.lighting') }}</option><option value="camera">{{ t('shot.production.references.camera') }}</option><option value="performance">{{ t('shot.production.references.performance') }}</option>
              </select>
            </label>
            <label v-if="entities?.length">{{ t('shot.production.references.target') }}
              <select :value="b.targetEntityId ?? ''" @change="update(b.id, { targetEntityId: ($event.target as HTMLSelectElement).value || null })">
                <option value="">{{ t('shot.production.references.unbound') }}</option><option v-for="entity in entities" :key="entity.id" :value="entity.id">{{ entity.name }}</option>
              </select>
            </label>
            <label v-if="b.type === 'image'">{{ t('shot.production.references.frame') }}
              <select :value="b.framePolicy ?? 'unassigned'" @change="changeFramePolicy(b, ($event.target as HTMLSelectElement).value as ReferenceFramePolicy)">
                <option value="unassigned">{{ t('shot.production.references.unassigned') }}</option><option value="crop">{{ t('shot.production.references.crop') }}</option><option value="outpaint">{{ t('shot.production.references.outpaint') }}</option><option value="reference_only">{{ t('shot.production.references.referenceOnly') }}</option>
              </select>
            </label>
          </div>
          <details class="role-editor">
            <summary>{{ t('shot.production.references.roleEditor') }}</summary>
            <label v-for="role in roleOptions[b.type]" :key="role"><input type="checkbox" :checked="b.roles.includes(role)" @change="toggleRole(b, role, ($event.target as HTMLInputElement).checked)" />{{ role }}</label>
          </details>
          <div v-if="aspectMismatch(b)" class="aspect-warning">{{ t('shot.production.references.mismatch', { ratio: aspectRatio, policy: b.framePolicy === 'reference_only' ? t('shot.production.references.referenceOnlyActive') : t('shot.production.references.choiceRequired') }) }}</div>
          <div v-if="b.type === 'audio'" class="audio-policy">
            <span class="mono">{{ referenceTag(b, index) }}</span>
            <select :value="b.audioPolicy?.mode ?? 'reference'" @change="updateAudio(b, { mode: ($event.target as HTMLSelectElement).value as AudioReferencePolicy['mode'] })"><option value="reference">reference</option><option value="fully_copy">fully_copy</option><option value="partially_copy">partially_copy</option><option value="resings">resings</option></select>
            <label>{{ t('shot.production.start') }} <input type="number" min="0" step="0.01" :value="b.audioPolicy?.startSeconds ?? 0" @change="updateAudio(b, { startSeconds: Number(($event.target as HTMLInputElement).value) })" /></label>
            <label>{{ t('shot.production.end') }} <input type="number" min="0" step="0.01" :value="b.audioPolicy?.endSeconds ?? ''" :placeholder="t('shot.production.required')" @change="updateAudio(b, { endSeconds: Number(($event.target as HTMLInputElement).value) })" /></label>
          </div>
        </div>
        <div class="col binding-side">
          <span class="drag-hint">⠿ {{ t('shot.production.references.drag') }}</span>
          <div class="row order-buttons">
            <button class="sm ghost" :disabled="index === 0 || reorderBusy" :aria-label="t('shot.production.references.moveUp')" :title="t('shot.production.references.moveUp')" @click="moveBinding(index, -1)">↑</button>
            <button class="sm ghost" :disabled="index === orderedBindings.length - 1 || reorderBusy" :aria-label="t('shot.production.references.moveDown')" :title="t('shot.production.references.moveDown')" @click="moveBinding(index, 1)">↓</button>
          </div>
          <button class="sm ghost" @click="onRemove(b.id)">{{ t('shot.common.remove') }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.warning-note { border-color: color-mix(in srgb, var(--warn) 42%, transparent); color: var(--warn); }
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
.binding[draggable="true"] { cursor: grab; }
.reference-controls, .audio-policy { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 11px; }
.reference-controls label, .audio-policy label { display: flex; align-items: center; gap: 4px; }
.reference-controls select, .audio-policy input, .audio-policy select { max-width: 155px; font-size: 11px; }
.audio-policy input { width: 64px; }
.aspect-warning { color: var(--warn); font-size: 11px; }
.role-editor { font-size: 11px; }
.role-editor summary { cursor: pointer; color: var(--text-3); }
.role-editor label { display: inline-flex; align-items: center; gap: 3px; margin: 4px 8px 0 0; }
.binding-side { align-items: flex-end; flex: none; }
.order-buttons { flex-wrap: nowrap; }
.derived-note { color: var(--info); font-size: 11px; overflow-wrap: anywhere; }
.file-input { display: none; }
.drag-hint { color: var(--text-3); font-size: 10px; }
.binding-row { display: flex; gap: 10px; align-items: flex-start; }
.b-thumb { width: 64px; height: 44px; flex: none; border-radius: 5px; overflow: hidden; background: var(--inset); display: flex; align-items: center; justify-content: center; }
.b-thumb img { width: 100%; height: 100%; object-fit: cover; }
.binding-meta { gap: 4px; }
.binding-label { font-weight: 600; }
.tags { display: flex; flex-wrap: wrap; }
</style>
