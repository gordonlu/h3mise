<script setup lang="ts">
import { ref, watch } from 'vue';
import type { PromptVersion, SubmissionPayloadPreview } from '@h3mise/shared';
import { mediaUrl, post } from '../../api/client';
import { t } from '../../stores/locale';

const props = defineProps<{
  shotId: string;
  prompt: PromptVersion | null;
  providerId: string;
  durationSeconds: number;
  aspectRatio: string;
  megapixels?: number;
  payload?: SubmissionPayloadPreview | null;
}>();
const preview = ref<SubmissionPayloadPreview | null>(props.payload ?? null);
const busy = ref(false);
const error = ref('');
watch(() => props.payload, (value) => { if (value) preview.value = value; }, { immediate: true });

async function loadPreview() {
  if (!props.prompt) return;
  busy.value = true; error.value = '';
  try {
    preview.value = await post<SubmissionPayloadPreview>(`/api/shots/${props.shotId}/submission-preview`, {
      promptVersionId: props.prompt.id,
      providerId: props.providerId,
      durationSeconds: props.durationSeconds,
      aspectRatio: props.aspectRatio,
      megapixels: props.megapixels,
    });
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = false; }
}
</script>

<template>
  <details class="panel payload-panel">
    <summary>{{ t('shot.production.payload') }} <span v-if="preview" class="badge" :class="preview.verification.exactCombination === 'tested' ? 'ok' : 'warn'">{{ t(`shot.production.verification.${preview.verification.exactCombination}`) }}</span></summary>
    <div class="panel-body col">
      <button class="sm" :disabled="busy || !prompt" @click="loadPreview">{{ busy ? t('shot.production.payload.loading') : t('shot.production.payload.refresh') }}</button>
      <div v-if="error" class="error-text">{{ error }}</div>
      <template v-if="preview">
        <div class="payload-meta">
          <span class="badge accent no-dot">{{ preview.providerId }} · {{ preview.appId }}</span>
          <span class="badge no-dot">{{ preview.mode }} · {{ preview.durationSeconds }}s · {{ preview.aspectRatio }} · {{ preview.megapixels ?? '—' }} MP</span>
          <span class="badge no-dot">Prompt: {{ preview.promptStage }}</span>
        </div>
        <p class="hint">{{ preview.verification.note }}</p>
        <p class="hint">{{ t('shot.production.payload.cost') }}: {{ preview.cost.estimatedCny === null ? t('shot.production.unknown') : `≈¥${preview.cost.estimatedCny}` }}（{{ preview.cost.evidence }}） · {{ t('shot.production.payload.failureCharge') }}: {{ preview.cost.failureCharge }}。{{ preview.cost.note }}</p>
        <div class="payload-refs">
          <div v-for="reference in preview.references" :key="reference.bindingId" class="payload-ref">
            <img v-if="reference.kind === 'image'" :src="mediaUrl(reference.assetId)" :alt="reference.tag" />
            <span v-else class="audio-icon">♪</span>
            <strong>{{ reference.tag }}</strong><span>{{ reference.label }}</span>
            <small>#{{ reference.order }} · {{ reference.referenceUse }} · {{ reference.framePolicy }}</small>
            <small v-if="reference.assetLabel !== reference.label" class="derived-note">{{ t('shot.production.references.derived') }}: {{ reference.assetLabel }}</small>
          </div>
        </div>
        <details><summary>{{ t('shot.production.payload.finalPrompt') }}</summary><pre>{{ preview.promptText }}</pre></details>
        <details><summary>{{ t('shot.production.payload.parameters') }}</summary><pre>{{ JSON.stringify(preview.parameters, null, 2) }}</pre></details>
        <details open><summary>{{ t('shot.production.payload.provider') }}</summary><pre>{{ JSON.stringify(preview.providerPayload, null, 2) }}</pre></details>
      </template>
      <p v-else class="hint">{{ t('shot.production.payload.empty') }}</p>
    </div>
  </details>
</template>

<style scoped>
.payload-panel { border-color: var(--accent); }
summary { cursor: pointer; }
.payload-meta, .payload-refs { display: flex; flex-wrap: wrap; gap: 7px; }
.payload-refs { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); }
.payload-ref { min-width: 0; display: grid; gap: 3px; padding: 7px; background: var(--bg-subtle); border-radius: 6px; font-size: 11px; }
.payload-ref img, .audio-icon { width: 100%; height: 72px; object-fit: cover; background: var(--inset); display: grid; place-items: center; }
.payload-ref span, .payload-ref small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hint { margin: 0; color: var(--text-3); font-size: 11px; line-height: 1.6; }
pre { max-height: 360px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; background: var(--inset); padding: 10px; border-radius: 6px; }
.error-text { color: var(--bad); }
.derived-note { color: var(--info); }
</style>
