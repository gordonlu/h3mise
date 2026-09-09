<script setup lang="ts">
import { computed, ref } from 'vue';
import { H3_MODE_LABEL } from '@h3mise/shared';
import type { H3Mode, PromptVersion } from '@h3mise/shared';
import { t } from '../../stores/locale';

const props = defineProps<{
  prompts: PromptVersion[];
  currentMode: string | null;
  aiEnabled: boolean;
  onCompile: (mode: string) => Promise<unknown>;
  onRaw: (text: string, mode: string) => Promise<unknown>;
  onAiCompile: () => Promise<unknown>;
}>();

const mode = computed<H3Mode>(() => (props.currentMode as H3Mode | null) ?? 't2va');
const rawText = ref('');
const showRaw = ref(false);
const busy = ref('');
const copied = ref('');
/** Inline edit: an existing version becomes the draft for a NEW version
 * (prompt versions themselves are immutable for audit/revert). */
const editingId = ref('');
const editText = ref('');

function startEdit(pv: PromptVersion) {
  editingId.value = pv.id;
  editText.value = pv.text;
}

async function saveEdit() {
  if (!editText.value.trim()) return;
  await run('edit', async () => {
    const target = props.prompts.find((p) => p.id === editingId.value);
    await props.onRaw(editText.value, target?.h3Mode ?? mode.value);
    editingId.value = '';
    editText.value = '';
  });
}

function sourceLabel(source: string): string {
  const key = ({ deterministic_compiler: 'rules', ai_compiler: 'ai', external_ai: 'externalAi', manual: 'manual' } as Record<string, string>)[source];
  return key ? t(`shot.prompt.source.${key}`) : source;
}

function modeLabel(value: H3Mode): string {
  return t(`shot.mode.${value}`);
}

async function run(kind: string, fn: () => Promise<unknown>) {
  busy.value = kind;
  try {
    await fn();
  } finally {
    busy.value = '';
  }
}

async function copy(text: string) {
  await navigator.clipboard.writeText(text);
  copied.value = text.slice(0, 30);
  setTimeout(() => (copied.value = ''), 1500);
}
</script>

<template>
  <div class="col">
    <div class="row wrap">
      <span class="badge accent no-dot" :title="t('shot.prompt.modeDeterminedByShot')">{{ modeLabel(mode) }}</span>
      <button class="primary sm" :disabled="busy !== ''" @click="run('compile', () => onCompile(mode))">
        {{ busy === 'compile' ? t('shot.prompt.generating') : t('shot.prompt.generateFromDesign') }}
      </button>
      <button v-if="aiEnabled" class="sm" :disabled="busy !== '' || !prompts.length" :title="prompts.length ? t('shot.prompt.optimizeLatestTitle') : t('shot.prompt.createFirstTitle')" @click="run('ai', onAiCompile)">
        {{ busy === 'ai' ? t('shot.prompt.aiOptimizing') : t('shot.prompt.aiOptimizeCurrent') }}
      </button>
      <button class="sm" @click="showRaw = !showRaw">{{ t('shot.prompt.manualInput') }}</button>
    </div>

    <div class="prompt-review-note">
      <strong>{{ t('shot.prompt.reviewNoticeTitle') }}</strong>
      <span>{{ t('shot.prompt.reviewNoticeBody') }}</span>
    </div>

    <div v-if="showRaw" class="panel">
      <div class="panel-body col">
        <textarea v-model="rawText" rows="5" :placeholder="t('shot.prompt.manualPlaceholder')"></textarea>
        <div class="row">
          <button class="primary sm" :disabled="busy !== '' || !rawText.trim()" @click="run('raw', () => onRaw(rawText, mode).then(() => { showRaw = false; rawText = ''; }))">{{ t('shot.prompt.saveNewVersion') }}</button>
          <button class="sm" @click="showRaw = false">{{ t('common.cancel') }}</button>
        </div>
      </div>
    </div>

    <div v-if="copied" class="muted">{{ t('shot.prompt.copied') }}{{ copied }}…</div>

    <div class="prompt-list col">
      <div v-for="pv in [...prompts].reverse()" :key="pv.id" class="panel prompt-item">
        <div class="spread prompt-head">
          <div class="row wrap">
            <span class="badge accent no-dot">{{ modeLabel(pv.h3Mode) }}</span>
            <span class="badge no-dot">{{ sourceLabel(pv.source) }}</span>
            <span class="muted mono">{{ pv.id }}</span>
            <span class="muted">{{ new Date(pv.createdAt).toLocaleString() }}</span>
          </div>
          <div class="row prompt-actions">
            <button class="sm ghost" :disabled="busy !== ''" :title="t('shot.prompt.reviewAndEditTitle')" @click="startEdit(pv)">{{ t('shot.prompt.reviewAndEdit') }}</button>
            <button class="sm ghost" @click="copy(pv.text)">{{ t('shot.common.copy') }}</button>
          </div>
        </div>
        <div v-if="pv.sourceTakeId" class="iteration-lineage">
          <div class="row wrap">
            <span class="badge info no-dot">{{ t('shot.prompt.revisionFrom') }} {{ pv.sourceTakeId }}</span>
            <span v-for="item in pv.preservedAspects" :key="item" class="tag active">{{ t('shot.prompt.preserve') }} {{ item }}</span>
          </div>
          <p>{{ pv.revisionReason }}</p>
        </div>
        <div v-if="editingId === pv.id" class="prompt-editor col">
          <textarea v-model="editText" rows="14"></textarea>
          <div class="row">
            <button class="primary sm" :disabled="busy !== '' || !editText.trim()" @click="saveEdit">{{ t('shot.prompt.saveEditedVersion') }}</button>
            <button class="sm" :disabled="busy !== ''" @click="editingId = ''; editText = ''">{{ t('common.cancel') }}</button>
          </div>
        </div>
        <pre v-else class="prompt-text">{{ pv.text || t('shot.prompt.emptyPrompt') }}</pre>
      </div>
      <div v-if="!prompts.length" class="muted">{{ t('shot.prompt.noPrompts') }}</div>
    </div>
  </div>
</template>

<style scoped>
.wrap { flex-wrap: wrap; }
.prompt-review-note { display: grid; gap: 3px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--line-2)); border-radius: 8px; background: color-mix(in srgb, var(--warn) 8%, var(--bg-2)); color: var(--text-2); font-size: 12px; line-height: 1.55; }
.prompt-review-note strong { color: var(--text); }
.prompt-item { padding: 10px 12px; }
.prompt-head { align-items: flex-start; gap: 10px; }
.prompt-head > .row:first-child { min-width: 0; }
.prompt-actions { flex: 0 0 auto; gap: 4px; }
.prompt-actions button { min-width: 48px; white-space: nowrap; }
.prompt-editor { margin-top: 8px; }
.prompt-editor textarea { width: 100%; min-height: 260px; resize: vertical; font-family: var(--mono); font-size: 12px; line-height: 1.55; }
.iteration-lineage { margin-top: 8px; padding: 8px 10px; border-left: 3px solid var(--info); background: var(--info-soft); border-radius: 4px; }
.iteration-lineage p { margin: 6px 0 0; color: var(--text-2); font-size: 12px; }
.prompt-text {
  font-family: var(--mono);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-2);
  margin: 8px 0 0;
  max-height: 260px;
  overflow: auto;
  background: var(--inset);
  border-radius: 5px;
  padding: 10px;
}
</style>
