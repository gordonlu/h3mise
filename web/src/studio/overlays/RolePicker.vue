<script setup lang="ts">
import { ref, watch } from 'vue';
import type { ReferenceRole } from '@h3mise/shared';
import { useRolePickerStore, ROLE_OPTIONS } from '../../stores/rolePicker';
import { t } from '../../stores/locale';

const store = useRolePickerStore();
const selected = ref<ReferenceRole[]>([]);

watch(
  () => store.pending,
  (pending) => {
    selected.value = pending ? [...pending.defaults] : [];
  },
  { immediate: true },
);

function toggle(role: ReferenceRole): void {
  selected.value = selected.value.includes(role)
    ? selected.value.filter((item) => item !== role)
    : [...selected.value, role];
}

const roleLabels: Record<string, string> = {
  identity: '身份 identity', costume: '服装 costume', environment: '环境 environment',
  lighting: '光线 lighting', style: '风格 style', motion: '动作 motion', audio: '音频 audio',
};
</script>

<template>
  <Teleport to="body">
    <div v-if="store.pending" class="dlg-backdrop" @click.self="store.answer(null)">
      <div class="dlg" role="dialog" :aria-label="t('studio.role.title')">
        <div class="dlg-head">{{ t('studio.role.title') }}</div>
        <div class="dlg-body">
          <div class="role-grid">
            <label v-for="role in ROLE_OPTIONS" :key="role" class="role-item">
              <input type="checkbox" :checked="selected.includes(role)" @change="toggle(role)" />
              <span>{{ roleLabels[role] ?? role }}</span>
            </label>
          </div>
        </div>
        <div class="dlg-foot">
          <button @click="store.answer(null)">{{ t('common.cancel') }}</button>
          <button class="primary" :disabled="selected.length === 0" @click="store.answer(selected)">
            {{ t('studio.role.bind') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.role-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 16px; }
.role-item { display: flex; gap: 8px; align-items: center; font-size: 13px; }
</style>
