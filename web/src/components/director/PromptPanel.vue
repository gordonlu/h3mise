<script setup lang="ts">
import { computed, ref } from 'vue';
import { H3_MODE_LABEL } from '@h3mise/shared';
import type { H3Mode, PromptVersion } from '@h3mise/shared';

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

const SOURCE_LABEL: Record<string, string> = {
  deterministic_compiler: '规则生成',
  ai_compiler: 'AI 优化',
  external_ai: '外部 AI',
  manual: '手动输入',
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
      <span class="badge accent no-dot" title="生成模式由当前镜头决定">{{ H3_MODE_LABEL[mode] }}</span>
      <button class="primary sm" :disabled="busy !== ''" @click="run('compile', () => onCompile(mode))">
        {{ busy === 'compile' ? '生成中…' : '从镜头设计生成' }}
      </button>
      <button v-if="aiEnabled" class="sm" :disabled="busy !== '' || !prompts.length" :title="prompts.length ? '优化当前最新提示词并保存为新版本' : '请先生成或手动输入一版提示词'" @click="run('ai', onAiCompile)">
        {{ busy === 'ai' ? 'AI 优化中…' : 'AI 优化当前提示词' }}
      </button>
      <button class="sm" @click="showRaw = !showRaw">手动输入提示词</button>
    </div>

    <div v-if="showRaw" class="panel">
      <div class="panel-body col">
        <textarea v-model="rawText" rows="5" placeholder="在这里自行输入或粘贴完整的 H3 提示词，不需要先填写导演计划"></textarea>
        <div class="row">
          <button class="primary sm" :disabled="busy !== '' || !rawText.trim()" @click="run('raw', () => onRaw(rawText, mode).then(() => { showRaw = false; rawText = ''; }))">保存为新版本</button>
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
        <pre class="prompt-text">{{ pv.text || '（空提示词）' }}</pre>
      </div>
      <div v-if="!prompts.length" class="muted">还没有提示词。可以从镜头设计生成，也可以手动输入。</div>
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
