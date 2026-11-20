<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { TAKE_QUALITY_CHECKS, type TakeQualityCheckKey, type TakeQualityReport, type TakeQualityStatus } from '@h3mise/shared';
import { get, patch, post } from '../../api/client';
import { t } from '../../stores/locale';

const props = defineProps<{ takeId: string }>();
const report = ref<TakeQualityReport | null>(null);
const busy = ref(false);
const error = ref('');
const aiKey = ref<TakeQualityCheckKey>('character_presence');
const aiStatus = ref<Exclude<TakeQualityStatus, 'unknown'>>('warn');
const aiMessage = ref('');
const manualKey = ref<TakeQualityCheckKey>('character_presence');
const manualStatus = ref<Exclude<TakeQualityStatus, 'unknown'>>('pass');
const manualMessage = ref('');

async function load() {
  try { report.value = (await get<{ latest: TakeQualityReport | null }>(`/api/takes/${props.takeId}/quality`)).latest; }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}
onMounted(load);
watch(() => props.takeId, load);

async function runMechanical() {
  busy.value = true; error.value = '';
  try { report.value = await post<TakeQualityReport>(`/api/takes/${props.takeId}/quality`, {}); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = false; }
}
async function addAi() {
  if (!aiMessage.value.trim()) { error.value = t('shot.production.quality.aiRequired'); return; }
  busy.value = true; error.value = '';
  try {
    report.value = await post<TakeQualityReport>(`/api/takes/${props.takeId}/quality`, { source: 'ai_inference', aiObservations: [{ key: aiKey.value, status: aiStatus.value, message: aiMessage.value }] });
    aiMessage.value = '';
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = false; }
}
async function override() {
  if (!manualMessage.value.trim()) { error.value = t('shot.production.quality.manualRequired'); return; }
  busy.value = true; error.value = '';
  try {
    report.value = await patch<TakeQualityReport>(`/api/takes/${props.takeId}/quality/${manualKey.value}`, { status: manualStatus.value, message: manualMessage.value });
    manualMessage.value = '';
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = false; }
}
function evidenceLabel(key: string): string { return t(`shot.production.evidence.${key}`); }
</script>

<template>
  <details class="quality-panel" open>
    <summary>{{ t('shot.production.quality') }} <span v-if="report" class="badge" :class="report.status === 'pass' ? 'ok' : report.status === 'attention' ? 'warn' : 'muted'">{{ report.status }}</span></summary>
    <button class="sm" :disabled="busy" @click="runMechanical">{{ busy ? t('shot.production.quality.running') : t('shot.production.quality.run') }}</button>
    <p class="hint">{{ t('shot.production.quality.hint') }}</p>
    <div v-if="report" class="quality-list">
      <div v-for="item in report.items" :key="item.key" class="quality-item">
        <span class="badge" :class="item.status === 'pass' ? 'ok' : item.status === 'unknown' ? 'muted' : item.status === 'warn' ? 'warn' : 'bad'">{{ item.status }}</span>
        <div><strong>{{ item.key }}</strong><small>{{ evidenceLabel(item.evidence) }}<template v-if="item.overridden"> · {{ t('shot.production.quality.overridden') }}</template></small><p>{{ item.message }}</p><code v-if="item.observed">{{ item.observed }}</code></div>
      </div>
    </div>
    <p v-else class="hint">{{ t('shot.production.quality.empty') }}</p>
    <div class="quality-forms">
      <fieldset><legend>{{ t('shot.production.quality.ai') }}</legend><div class="row wrap"><select v-model="aiKey"><option v-for="key in TAKE_QUALITY_CHECKS" :key="key" :value="key">{{ key }}</option></select><select v-model="aiStatus"><option value="pass">pass</option><option value="warn">warn</option><option value="fail">fail</option></select><input v-model="aiMessage" :placeholder="t('shot.production.quality.aiPlaceholder')" /><button class="sm" :disabled="busy" @click="addAi">{{ t('shot.production.quality.saveAi') }}</button></div></fieldset>
      <fieldset><legend>{{ t('shot.production.quality.manual') }}</legend><div class="row wrap"><select v-model="manualKey"><option v-for="key in TAKE_QUALITY_CHECKS" :key="key" :value="key">{{ key }}</option></select><select v-model="manualStatus"><option value="pass">pass</option><option value="warn">warn</option><option value="fail">fail</option></select><input v-model="manualMessage" :placeholder="t('shot.production.quality.manualPlaceholder')" /><button class="sm" :disabled="busy" @click="override">{{ t('shot.production.quality.override') }}</button></div></fieldset>
    </div>
    <div v-if="error" class="error-text">{{ error }}</div>
  </details>
</template>

<style scoped>
.quality-panel { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
summary { cursor: pointer; margin-bottom: 10px; }
.hint { color: var(--text-3); font-size: 11px; line-height: 1.6; }
.quality-list { display: grid; gap: 6px; margin: 10px 0; }
.quality-item { display: grid; grid-template-columns: 72px 1fr; gap: 8px; padding: 7px; background: var(--bg-subtle); border-radius: 6px; }
.quality-item p { margin: 3px 0; font-size: 11px; color: var(--text-2); }
.quality-item small { margin-left: 8px; color: var(--text-3); }
.quality-item code { font-size: 10px; color: var(--text-3); }
.quality-forms { display: grid; gap: 8px; }
fieldset { border: 1px solid var(--line); border-radius: 6px; }
legend { font-size: 11px; }
input { min-width: 160px; flex: 1; }
.error-text { color: var(--bad); }
</style>
