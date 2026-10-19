<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { get } from '../../api/client';
import { useStudioNavigate } from '../../composables/useStudioNavigate';
import { t } from '../../stores/locale';
import type { ProductionIssue, ProductionOverview } from '@h3mise/shared';

const overview = ref<ProductionOverview | null>(null);
const loading = ref(false);
const { goLegacy } = useStudioNavigate();

const SEV_ORDER: Record<string, number> = { blocker: 0, warning: 1, info: 2 };

async function load(): Promise<void> {
  loading.value = true;
  try {
    overview.value = await get<ProductionOverview>('/api/production');
  } finally {
    loading.value = false;
  }
}

function open(issue: ProductionIssue): void {
  goLegacy(issue.to, issue.category);
}

onMounted(() => void load());
defineExpose({ load, refresh: load });
</script>

<template>
  <div class="hf-dock-panel">
    <p v-if="loading" class="hf-muted">{{ t('common.loading') }}</p>
    <p v-else-if="!overview?.issues.length" class="hf-muted">{{ t('copilot.allClear') }}</p>
    <div
      v-for="issue in [...(overview?.issues ?? [])].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9))"
      :key="issue.id"
      class="hf-issue"
      :class="issue.severity"
      @click="open(issue)"
    >
      <span class="hf-chip" :class="issue.severity">{{ issue.severity }}</span>
      <span class="hf-issue-title">{{ issue.title }}</span>
      <span class="hf-issue-detail">{{ issue.detail }}</span>
    </div>
  </div>
</template>

<style scoped>
.hf-issue { display: flex; align-items: baseline; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--line); font-size: 12px; cursor: pointer; }
.hf-issue:hover { background: var(--bg-muted); }
.hf-issue-title { font-weight: 600; }
.hf-issue-detail { flex: 1; min-width: 0; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hf-chip.blocker { background: var(--bad-soft); color: var(--bad); }
.hf-chip.warning { background: var(--warn-soft); color: var(--warn); }
</style>
