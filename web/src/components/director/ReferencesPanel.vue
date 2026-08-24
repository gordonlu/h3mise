<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { H3Mode, MediaAsset, ReferenceBinding, ReferenceRole } from '@h3mise/shared';
import { fileUrl, get, mediaUrl } from '../../api/client';

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

interface RefGroup { id: string; cn: string; limit: number; items: MediaAsset[]; role?: ReferenceRole }

/** Only expose slots that the current generation path can actually submit. */
const groups = computed<RefGroup[]>(() => {
  const images = props.media.filter((m) => m.kind === 'image');
  const audios = props.media.filter((m) => m.kind === 'audio');
  const out: RefGroup[] = [];
  if (props.currentMode === 'ref2va') {
    if (slots.value.images > 0) out.push({ id: 'refimg', cn: 'Ref2VA 参考图', limit: slots.value.images, items: images });
    if (slots.value.audios > 0) out.push({ id: 'refaudio', cn: 'Ref2VA 参考音频', limit: slots.value.audios, items: audios });
    return out;
  }
  if ((props.currentMode === 'i2va' || props.currentMode === 'fl2va') && slots.value.firstFrame) {
    out.push({ id: 'first', cn: '首帧图', limit: 1, items: images, role: 'first_frame' });
  }
  if ((props.currentMode === 'l2va' || props.currentMode === 'fl2va') && slots.value.lastFrame) {
    out.push({ id: 'last', cn: '尾帧图', limit: 1, items: images, role: 'last_frame' });
  }
  return out;
});

const hasSlots = computed(() => groups.value.length > 0);
const modeHint = computed(() => ({
  t2va: 'T2VA 不需要参考素材',
  i2va: 'I2VA 只使用首帧图',
  l2va: 'L2VA 只使用尾帧图',
  fl2va: 'FL2VA 使用首帧图和尾帧图',
  ref2va: 'Ref2VA 至少需要一张参考图；参考音频可选。首尾帧也可以在参考模式里用（在提示词中声明为开场/结尾画面）',
})[props.currentMode]);
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
      <button class="primary sm" @click="pickerOpen = !pickerOpen">＋ 绑定 Reference</button>
      <router-link :to="uploadPath" class="sm upload-link">上传新素材</router-link>
      <span v-if="!bindings.length" class="muted">{{ modeHint }}</span>
    </div>

    <div v-if="suggestFrameMode" class="note">
      当前只有首尾帧、没有其他参考图——建议改用 <strong>{{ suggestFrameMode.toUpperCase() }}</strong>：同样的首尾帧控制，但生成更快、更便宜（Ref2VA 会按多参考计费）。
    </div>

    <div v-if="pickerOpen" class="panel picker">
      <div class="panel-title">绑定参考资源（按类型填入工作流槽位）</div>
      <div class="panel-body col">
        <template v-if="slotsLoaded && hasSlots">
          <div v-for="g in groups" :key="g.id" class="role-group">
            <span class="muted group-cn">{{ g.cn }}<span class="group-limit">上限 {{ g.limit }} · 可用 {{ remaining(g) }}</span></span>
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
              <div v-if="!g.items.length" class="muted">暂无{{ g.cn }}，<router-link :to="uploadPath">上传并自动关联</router-link>。</div>
            </div>
          </div>
          <div class="note">
            <template v-if="currentMode === 'ref2va'">
              当前是 <strong>Ref2VA 参考模式</strong>：提交 RefImages / RefAudios。参考图 ≤{{ slots.images }} 张、参考音频 ≤{{ slots.audios }} 个，合计 ≤{{ refTotalCap }} 个；音频必须同时有参考图。
              若同时绑定了「首帧图」，该图会作为开场画面发给首帧槽（不占参考槽）；工作流在参考模式下是否消费首帧以真实渲染为准。
            </template>
            <template v-else>
              当前是 <strong>{{ currentMode.toUpperCase() }} 帧控制模式</strong>：只提交 FirstFrame / LastFrame，不会提交 RefImages 或参考音频。
            </template>
          </div>
        </template>
        <div v-else class="note">
          {{ !slotsLoaded ? '正在读取工作流槽位…' : currentMode === 't2va' ? 'T2VA 是纯文字生成，不需要绑定参考素材。' : '当前 Provider 没有为这个模式提供可执行的参考槽位。' }}
        </div>
        <div class="row">
          <button class="primary sm" :disabled="!pickAsset || !hasSlots || !selectedGroupHasSpace" @click="add">绑定</button>
          <button class="sm" @click="pickerOpen = false">取消</button>
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
        <button class="sm ghost" @click="onRemove(b.id)">移除</button>
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
