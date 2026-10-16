<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { get } from '../../api/client';
import { t } from '../../stores/locale';

interface AiRequestSummary {
  id: string;
  action: string;
  status: string;
  modelLabel: string | null;
  shotId: string | null;
  createdAt: string;
}

const requests = ref<AiRequestSummary[]>([]);
const loading = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    requests.value = await get<AiRequestSummary[]>('/api/ai/requests?status=pending');
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load());
defineExpose({ load, refresh: load });
</script>

<template>
  <div class="hf-dock-panel">
    <p v-if="loading" class="hf-muted">{{ t('common.loading') }}</p>
    <p v-else-if="requests.length === 0" class="hf-muted">{{ t('studio.bottom.noPending') }}</p>
    <div v-for="request in requests" :key="request.id" class="hf-ai-req">
      <span class="hf-chip">🤖 {{ request.action }}</span>
      <span v-if="request.shotId" class="hf-muted">{{ request.shotId }}</span>
      <span class="hf-job-spacer" />
      <span class="hf-muted">{{ request.modelLabel ?? t('brain.externalAgent') }}</span>
    </div>
  </div>
</template>

<style scoped>
.hf-ai-req { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--line); font-size: 12px; }
.hf-job-spacer { flex: 1; }
</style>
