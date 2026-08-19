<script setup lang="ts">
import { ref } from 'vue';
import type { MediaAsset, ReferenceBinding, ReferenceRole } from '@h3mise/shared';
import { fileUrl, mediaUrl } from '../../api/client';

const props = defineProps<{
  bindings: ReferenceBinding[];
  media: MediaAsset[];
  onAdd: (input: { assetId: string; roles: ReferenceRole[]; label?: string }) => Promise<void>;
  onUpdate: (id: string, patch: Partial<ReferenceBinding>) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}>();

const pickerOpen = ref(false);
const pickAsset = ref('');
const pickRoles = ref<ReferenceRole[]>([]);

const ROLE_GROUPS: Array<{ cn: string; roles: ReferenceRole[] }> = [
  { cn: '帧', roles: ['first_frame', 'last_frame'] },
  { cn: '身份/外观', roles: ['identity', 'costume', 'environment', 'style', 'lighting'] },
  { cn: '运动', roles: ['motion', 'body_motion', 'timing', 'camera_motion'] },
  { cn: '声音', roles: ['audio'] },
];

function thumb(m: MediaAsset | undefined): string | null {
  if (!m) return null;
  if (m.kind === 'image') return mediaUrl(m.id);
  if (m.posterPath) return fileUrl(m.posterPath);
  return null;
}

async function add() {
  if (!pickAsset.value) return;
  await props.onAdd({ assetId: pickAsset.value, roles: pickRoles.value, label: props.media.find((m) => m.id === pickAsset.value)?.label });
  pickerOpen.value = false;
  pickAsset.value = '';
  pickRoles.value = [];
}

function toggleRole(r: ReferenceRole) {
  pickRoles.value = pickRoles.value.includes(r) ? pickRoles.value.filter((x) => x !== r) : [...pickRoles.value, r];
}
</script>

<template>
  <div class="col">
    <div class="row">
      <button class="primary sm" @click="pickerOpen = !pickerOpen">＋ 绑定 Reference</button>
      <span v-if="!bindings.length" class="muted">未绑定（T2VA 不需要；I2VA/FL2VA 需要首帧）</span>
    </div>

    <div v-if="pickerOpen" class="panel picker">
      <div class="panel-title">选择资产 + 指定职责（PRD §17：Reference 必须有职责）</div>
      <div class="panel-body col">
        <div class="asset-pick">
          <div
            v-for="m in media"
            :key="m.id"
            class="asset-opt"
            :class="{ on: pickAsset === m.id }"
            @click="pickAsset = m.id"
          >
            <div class="opt-thumb">
              <img v-if="thumb(m)" :src="thumb(m)!" :alt="m.label" />
              <span v-else class="mono muted">{{ m.kind === 'audio' ? '♪' : m.kind === 'video' ? '▶' : '▧' }}</span>
            </div>
            <div class="opt-label" :title="m.label || m.id">{{ m.label || m.id }}</div>
            <div class="muted">{{ m.kind }}</div>
          </div>
          <div v-if="!media.length" class="muted">资产库为空，先到 Assets 页导入。</div>
        </div>
        <div v-for="g in ROLE_GROUPS" :key="g.cn" class="role-group">
          <span class="muted group-cn">{{ g.cn }}</span>
          <div class="roles">
            <span
              v-for="r in g.roles"
              :key="r"
              class="tag"
              :class="{ active: pickRoles.includes(r) }"
              @click="toggleRole(r)"
            >{{ r }}</span>
          </div>
        </div>
        <div class="row">
          <button class="primary sm" :disabled="!pickAsset || !pickRoles.length" @click="add">绑定</button>
          <button class="sm" @click="pickerOpen = false">取消</button>
          <span v-if="pickAsset && !pickRoles.length" class="muted">至少选择一个职责</span>
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
.group-cn { flex: none; width: 64px; padding-top: 3px; font-weight: 500; }
.roles { display: flex; flex-wrap: wrap; gap: 2px; }
.binding { padding: 10px 12px; }
.binding-row { display: flex; gap: 10px; align-items: flex-start; }
.b-thumb { width: 64px; height: 44px; flex: none; border-radius: 5px; overflow: hidden; background: var(--inset); display: flex; align-items: center; justify-content: center; }
.b-thumb img { width: 100%; height: 100%; object-fit: cover; }
.binding-meta { gap: 4px; }
.binding-label { font-weight: 600; }
.tags { display: flex; flex-wrap: wrap; }
</style>
