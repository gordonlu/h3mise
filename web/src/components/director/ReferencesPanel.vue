<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { MediaAsset, ReferenceBinding, ReferenceRole } from '@h3mise/shared';
import { fileUrl, get, mediaUrl } from '../../api/client';

const props = defineProps<{
  bindings: ReferenceBinding[];
  media: MediaAsset[];
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

const ROLE_CN: Partial<Record<ReferenceRole, string>> = {
  first_frame: '首帧',
  last_frame: '尾帧',
  motion: '动作',
  body_motion: '身体动作',
  camera_motion: '镜头运动',
  audio: '音频',
};

interface RefGroup { id: string; cn: string; limit: number; items: MediaAsset[]; role?: ReferenceRole }

/** Groups by workflow slot semantics. Frame mode (首帧+尾帧) and reference
 * mode (参考图/视频/音频, ref2va only) are mutually exclusive. */
const groups = computed<RefGroup[]>(() => {
  const images = props.media.filter((m) => m.kind === 'image');
  const audios = props.media.filter((m) => m.kind === 'audio');
  const out: RefGroup[] = [];
  if (slots.value.firstFrame) out.push({ id: 'first', cn: '首帧图', limit: 1, items: images, role: 'first_frame' });
  if (slots.value.lastFrame) out.push({ id: 'last', cn: '尾帧图', limit: 1, items: images, role: 'last_frame' });
  if (slots.value.images > 0) out.push({ id: 'refimg', cn: '参考图（ref2va）', limit: slots.value.images, items: images });
  if (slots.value.audios > 0) out.push({ id: 'refaudio', cn: '参考音频（ref2va）', limit: slots.value.audios, items: audios });
  return out;
});

const hasSlots = computed(() => groups.value.length > 0);

/** Official RunningHub cap is 12 total refs (slots may offer more). */
const refTotalCap = computed(() => Math.min(slots.value.total, 12));

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
</script>

<template>
  <div class="col">
    <div class="row">
      <button class="primary sm" @click="pickerOpen = !pickerOpen">＋ 绑定 Reference</button>
      <span v-if="!bindings.length" class="muted">未绑定（T2VA 不需要；I2VA/FL2VA 需要首帧）</span>
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
                @click="pickAsset = m.id; pickGroup = g.id"
              >
                <div class="opt-thumb">
                  <img v-if="thumb(m)" :src="thumb(m)!" :alt="m.label" />
                  <span v-else class="mono muted">{{ m.kind === 'audio' ? '♪' : m.kind === 'video' ? '▶' : '▧' }}</span>
                </div>
                <div class="opt-label" :title="m.label || m.id">{{ m.label || m.id }}</div>
                <div class="muted">{{ m.kind }}</div>
              </div>
              <div v-if="!g.items.length" class="muted">暂无{{ g.cn }}，先到 Assets 页导入。</div>
            </div>
          </div>
          <div class="note">
            <strong>两种互斥模式</strong>：首帧+尾帧（i2va / l2va / fl2va）最多 2 张；参考图 ≤{{ slots.images }} 张、参考音频 ≤{{ slots.audios }} 个，合计 ≤{{ refTotalCap }} 个——参考模式仅在 Shot 模式为 <strong>ref2va</strong> 时生效（首帧+尾帧仅 2 张时参考图无效，反之亦然）。
            音频每个 2–15s 且总计 ≤15s；音频不能单独作为唯一参考。
            <br />身份 / 服装 / 场景 / 风格等描述性信息请写入 Prompt。
          </div>
        </template>
        <div v-else class="note">
          {{ slotsLoaded ? '当前工作流未启用任何参考槽位（请在 Settings 完成节点探测）。' : '正在读取工作流槽位…' }}
          <br />身份 / 服装 / 场景 / 风格等描述性信息请写入 Prompt，无需绑定。
        </div>
        <div class="row">
          <button class="primary sm" :disabled="!pickAsset || !hasSlots" @click="add">绑定</button>
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
