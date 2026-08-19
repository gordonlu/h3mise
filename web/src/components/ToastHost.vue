<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useToastStore } from '../stores/toast';

const store = useToastStore();
const router = useRouter();

const ICONS = { ok: '✓', err: '✕', info: 'ℹ' } as const;

function act(t: { id: number; actionTo?: string }) {
  if (t.actionTo) router.push(t.actionTo);
  store.dismiss(t.id);
}
</script>

<template>
  <div class="toast-host">
    <div v-for="t in store.toasts" :key="t.id" :class="['toast', t.kind, { leaving: t.leaving }]" role="status">
      <span class="t-icon">{{ ICONS[t.kind] }}</span>
      <div class="t-body">{{ t.text }}</div>
      <span v-if="t.actionLabel" class="t-action" @click="act(t)">{{ t.actionLabel }} →</span>
      <span class="t-close" @click="store.dismiss(t.id)">✕</span>
    </div>
  </div>
</template>
