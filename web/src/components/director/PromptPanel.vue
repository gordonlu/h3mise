<script setup lang="ts">
import { ref } from 'vue';
import { H3_MODE_LABEL } from '@h3mise/shared';
import type { H3Mode, PromptVersion } from '@h3mise/shared';

const props = defineProps<{
  prompts: PromptVersion[];
  currentMode: string | null;
  /** PRD §15: only modes the current provider profile actually supports. */
  availableModes: readonly H3Mode[];
  aiEnabled: boolean;
  onCompile: (mode: string) => Promise<unknown>;
  onRaw: (text: string, mode: string) => Promise<unknown>;
  onAiCompile: () => Promise<unknown>;
}>();

const mode = ref(props.currentMode ?? 't2va');
const rawText = ref('');
const showRaw = ref(false);
const busy = ref('');
const copied = ref('');

const SOURCE_LABEL: Record<string, string> = {
  deterministic_compiler: 'Standard',
  ai_compiler: 'AI',
  external_ai: 'External',
  manual: 'Raw',
};

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
      <select v-model="mode" class="mode-select" title="H3 生成模式">
        <option v-for="m in availableModes" :key="m" :value="m">{{ H3_MODE_LABEL[m] }}</option>
      </select>
      <button class="primary sm" :disabled="busy !== ''" @click="run('compile', () => onCompile(mode))">
        {{ busy === 'compile' ? '编译中…' : 'Standard Compile' }}
      </button>
      <button v-if="aiEnabled" class="sm" :disabled="busy !== ''" @click="run('ai', onAiCompile)">
        {{ busy === 'ai' ? 'AI 编译中…' : 'AI Compile' }}
      </button>
      <button class="sm" @click="showRaw = !showRaw">粘贴 Raw Prompt</button>
    </div>

    <div v-if="showRaw" class="panel">
      <div class="panel-body col">
        <textarea v-model="rawText" rows="5" placeholder="直接粘贴现成 H3 Prompt（Raw Prompt 路径，不需要 DirectorPlan）"></textarea>
        <div class="row">
          <button class="primary sm" :disabled="busy !== '' || !rawText.trim()" @click="run('raw', () => onRaw(rawText, mode).then(() => { showRaw = false; rawText = ''; }))">导入 Raw Prompt</button>
          <button class="sm" @click="showRaw = false">取消</button>
        </div>
      </div>
    </div>

    <div v-if="copied" class="muted">已复制：{{ copied }}…</div>

    <div class="prompt-list col">
      <div v-for="pv in [...prompts].reverse()" :key="pv.id" class="panel prompt-item">
        <div class="spread">
          <div class="row wrap">
            <span class="badge accent no-dot">{{ H3_MODE_LABEL[pv.h3Mode] }}</span>
            <span class="badge no-dot">{{ SOURCE_LABEL[pv.source] ?? pv.source }}</span>
            <span class="muted mono">{{ pv.id }}</span>
            <span class="muted">{{ new Date(pv.createdAt).toLocaleString() }}</span>
          </div>
          <button class="sm ghost" @click="copy(pv.text)">复制</button>
        </div>
        <pre class="prompt-text">{{ pv.text || '（空 Prompt）' }}</pre>
      </div>
      <div v-if="!prompts.length" class="muted">还没有 Prompt。点击 Standard Compile 从 DirectorPlan 编译。</div>
    </div>
  </div>
</template>

<style scoped>
.mode-select { width: 110px; }
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
