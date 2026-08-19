<script setup lang="ts">
import { ref } from 'vue';
import type { PreflightReport, PromptVersion } from '@h3mise/shared';

const props = defineProps<{
  reports: PreflightReport[];
  prompt: PromptVersion | null;
  providerId: string;
  aiEnabled: boolean;
  onBasic: (promptId: string) => Promise<PreflightReport>;
  onAiCheck: (promptId: string) => Promise<PreflightReport | null>;
  onRender: (promptId: string) => Promise<void>;
}>();

const busy = ref('');

async function run(kind: 'basic' | 'ai') {
  if (!props.prompt) return;
  busy.value = kind;
  try {
    if (kind === 'basic') await props.onBasic(props.prompt.id);
    else await props.onAiCheck(props.prompt.id);
  } finally {
    busy.value = '';
  }
}

async function render() {
  if (!props.prompt) return;
  busy.value = 'render';
  try {
    await props.onRender(props.prompt.id);
  } finally {
    busy.value = '';
  }
}

const STATUS_COLOR: Record<string, string> = { ok: 'ok', warn: 'warn', fail: 'bad', skip: 'muted' };
const RISK_COLOR: Record<string, string> = { LOW: 'ok', MEDIUM: 'warn', HIGH: 'bad' };
</script>

<template>
  <div class="col">
    <div class="row">
      <button class="sm" :disabled="busy !== '' || !prompt" @click="run('basic')">Basic Check</button>
      <button v-if="aiEnabled" class="sm" :disabled="busy !== '' || !prompt" @click="run('ai')">AI Check</button>
      <span v-if="busy === 'basic'" class="muted">检查中…</span>
      <span v-if="busy === 'ai'" class="muted">AI 语义检查中…（后台任务）</span>
    </div>

    <div v-if="!prompt" class="muted">先编译或粘贴 Prompt。</div>

    <div v-for="r in reports.slice(0, 3)" :key="r.id" class="panel preflight">
      <div class="spread">
        <span class="muted mono">{{ r.id }} · {{ new Date(r.createdAt).toLocaleString() }}</span>
        <div class="row">
          <span v-if="r.aiSemanticRun" class="badge info">AI semantic</span>
          <span v-else class="muted">AI semantic checks: Not run</span>
          <span :class="['badge', RISK_COLOR[r.risk]]">Risk: {{ r.risk }}</span>
          <span :class="['badge', r.blocked ? 'bad' : 'ok']">{{ r.blocked ? 'BLOCKED' : 'READY' }}</span>
        </div>
      </div>
      <div class="sections">
        <div v-for="s in r.basic" :key="s.key" class="sec">
          <span :class="['badge', STATUS_COLOR[s.status]]">{{ s.label }}</span>
          <ul>
            <li v-for="ch in s.checks" :key="ch.key" :class="ch.severity">
              {{ ch.message }}
            </li>
          </ul>
        </div>
      </div>
      <div v-if="r.semantic" class="sections">
        <div v-for="s in r.semantic" :key="s.key" class="sec">
          <span :class="['badge', STATUS_COLOR[s.status]]">{{ s.label }}</span>
          <ul>
            <li v-for="ch in s.checks" :key="ch.key" :class="ch.severity">{{ ch.message }}</li>
          </ul>
        </div>
      </div>
    </div>

    <button class="primary render-btn" :disabled="busy !== '' || !prompt" @click="render">
      {{ busy === 'render' ? '提交中…' : 'Generate / Render（RunningHub）' }}
    </button>
    <p class="muted">渲染前会强制重跑 Basic Preflight；BLOCKED 时不会提交，避免浪费生成费用。</p>
  </div>
</template>

<style scoped>
.preflight { padding: 10px 12px; }
.sections { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.sec { display: flex; gap: 10px; align-items: flex-start; }
.sec ul { margin: 0; padding-left: 0; list-style: none; }
.sec li { font-size: 12px; color: var(--text-2); }
.sec li.error { color: var(--bad); }
.sec li.warning { color: var(--warn); }
.render-btn { margin-top: 8px; }
</style>
