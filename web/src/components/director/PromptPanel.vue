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
        <div class="spread">
          <div class="row wrap">
            <span class="badge accent no-dot">{{ modeLabel(pv.h3Mode) }}</span>
            <span class="badge no-dot">{{ sourceLabel(pv.source) }}</span>
            <span class="muted mono">{{ pv.id }}</span>
            <span class="muted">{{ new Date(pv.createdAt).toLocaleString() }}</span>
          </div>
          <button class="sm ghost" @click="copy(pv.text)">{{ t('shot.common.copy') }}</button>
        </div>
        <pre class="prompt-text">{{ pv.text || t('shot.prompt.emptyPrompt') }}</pre>
      </div>
      <div v-if="!prompts.length" class="muted">{{ t('shot.prompt.noPrompts') }}</div>
    </div>
  </div>
</template>

<style scoped>
.wrap { flex-wrap: wrap; }
.prompt-item { padding: 10px 12px; }
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
