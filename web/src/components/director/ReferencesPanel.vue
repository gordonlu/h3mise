<script setup lang="ts">
import { ref } from 'vue';
import type { MediaAsset, ReferenceBinding, ReferenceRole } from '@h3mise/shared';

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

const ALL_ROLES: ReferenceRole[] = [
  'identity', 'costume', 'environment', 'motion', 'body_motion', 'timing', 'camera_motion', 'lighting', 'style', 'audio', 'first_frame', 'last_frame',
];

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
      <button class="sm" @click="pickerOpen = !pickerOpen">＋ 绑定 Reference</button>
      <span v-if="!bindings.length" class="muted">未绑定（T2VA 不需要；I2VA/FL2VA 需要首帧）</span>
    </div>

    <div v-if="pickerOpen" class="panel">
      <div class="panel-body col">
        <label class="field">
          选择本地资产
          <select v-model="pickAsset">
            <option value="" disabled>— 选择 MediaAsset —</option>
            <option v-for="m in media" :key="m.id" :value="m.id">{{ m.label || m.id }} ({{ m.kind }})</option>
          </select>
        </label>
        <div class="roles">
          <span
            v-for="r in ALL_ROLES"
            :key="r"
            class="tag"
            :class="{ active: pickRoles.includes(r) }"
            @click="toggleRole(r)"
          >{{ r }}</span>
        </div>
        <div class="row">
          <button class="primary sm" :disabled="!pickAsset" @click="add">绑定</button>
          <button class="sm" @click="pickerOpen = false">取消</button>
        </div>
      </div>
    </div>

    <div v-for="b in bindings" :key="b.id" class="panel binding">
      <div class="spread">
        <div class="col grow">
          <div class="row">
            <span class="badge accent">{{ b.type }}</span>
            <span class="binding-label">{{ b.label || b.id }}</span>
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
.roles { display: flex; flex-wrap: wrap; gap: 2px; }
.binding { padding: 8px 10px; }
.binding-label { font-weight: 600; }
.tags { display: flex; flex-wrap: wrap; }
</style>
