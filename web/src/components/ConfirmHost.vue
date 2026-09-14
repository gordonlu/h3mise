<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useConfirmStore } from '../stores/confirm';
import { t } from '../stores/locale';

const store = useConfirmStore();

function onKey(e: KeyboardEvent) {
  if (!store.pending) return;
  if (e.key === 'Escape') store.answer(false);
  if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'TEXTAREA') store.answer(true);
}

onMounted(() => window.addEventListener('keydown', onKey));
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <div v-if="store.pending" class="dlg-backdrop" @click.self="store.answer(false)">
      <div class="dlg" role="alertdialog" :aria-label="store.pending.title">
        <div class="dlg-head">{{ store.pending.title }}</div>
        <div class="dlg-body">{{ store.pending.message }}</div>
        <div class="dlg-foot">
          <button @click="store.answer(false)">{{ t('common.cancel') }}</button>
          <button :class="store.pending.danger ? 'danger' : 'primary'" autofocus @click="store.answer(true)">
            {{ store.pending.confirmLabel ?? t('common.confirm') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
