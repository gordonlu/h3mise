<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import type { MediaAsset } from '@h3mise/shared';
import { get, post } from '../../api/client';
import { useBreakdownPickerStore } from '../../stores/breakdownPicker';
import { useStudioStore } from '../../stores/studio';
import { useToastStore } from '../../stores/toast';
import { t } from '../../stores/locale';

const picker = useBreakdownPickerStore();
const store = useStudioStore();
const toasts = useToastStore();
const media = ref<MediaAsset[]>([]);
const loading = ref(false);
const busyId = ref<string | null>(null);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const rows = await get<MediaAsset[]>('/api/assets/media?kind=video');
    media.value = rows;
  } catch {
    media.value = [];
  } finally {
    loading.value = false;
  }
}

async function choose(asset: MediaAsset): Promise<void> {
  if (busyId.value) return;
  busyId.value = asset.id;
  try {
    await post(`/api/assets/media/${encodeURIComponent(asset.id)}/breakdown`);
    await store.refreshGraph();
    store.select(`breakdown:${asset.id}`);
    store.focusNode(`breakdown:${asset.id}`);
    toasts.push({ kind: 'ok', text: t('studio.breakdown.picked') });
    picker.close();
  } catch (e) {
    toasts.push({ kind: 'err', text: t('studio.breakdown.pickFailed', { msg: e instanceof Error ? e.message : String(e) }) });
  } finally {
    busyId.value = null;
  }
}

watch(() => picker.open, (open) => { if (open) void load(); });
onMounted(() => { if (picker.open) void load(); });
</script>

<template>
  <Teleport to="body">
    <div v-if="picker.open" class="dlg-backdrop" @click.self="picker.close()">
      <div class="dlg" role="dialog" :aria-label="t('studio.breakdown.pickTitle')">
        <div class="dlg-head">{{ t('studio.breakdown.pickTitle') }}</div>
        <div class="dlg-body">
          <p class="hf-muted">{{ t('studio.breakdown.pickHint') }}</p>
          <p v-if="loading" class="hf-muted">{{ t('common.loading') }}</p>
          <p v-else-if="media.length === 0" class="hf-muted">{{ t('studio.breakdown.pickEmpty') }}</p>
          <div v-else class="hf-breakdown-list">
            <button
              v-for="asset in media"
              :key="asset.id"
              class="hf-breakdown-item"
              :disabled="Boolean(busyId)"
              @click="choose(asset)"
            >
              <span class="hf-breakdown-name">{{ asset.label || asset.fileName }}</span>
              <span class="hf-muted">
                {{ asset.durationSeconds ? t('studio.media.duration', { n: Math.round(asset.durationSeconds) }) : asset.fileName }}
              </span>
              <span v-if="busyId === asset.id" class="hf-chip">{{ t('studio.breakdown.picking') }}</span>
            </button>
          </div>
        </div>
        <div class="dlg-foot">
          <button :disabled="Boolean(busyId)" @click="picker.close()">{{ t('common.cancel') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.hf-breakdown-list { display: grid; gap: 6px; max-height: 46vh; overflow: auto; }
.hf-breakdown-item {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 10px;
  border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg-3);
  color: var(--text); text-align: left; cursor: pointer; font-size: 13px;
}
.hf-breakdown-item:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-text); }
.hf-breakdown-item:disabled { cursor: default; opacity: 0.7; }
.hf-breakdown-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
