<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { get, post, put } from '../api/client';
import { useProjectStore } from '../stores/project';
import { locale, t } from '../stores/locale';
import type { AiAppProfile } from '@h3mise/shared';

const project = useProjectStore();
const health = ref<{ ffmpeg: { available: boolean; ffmpegVersion: string | null }; runningHubConfigured: boolean; aiConfigured: boolean } | null>(null);
const healthError = ref('');
const profile = ref<AiAppProfile | null>(null);
const verifying = ref(false);
const notice = ref('');
const profileJson = ref('');
const editingProfile = ref(false);
const apiKeyInfo = ref<{ source: 'settings' | 'env' | 'none'; configured: boolean } | null>(null);
const apiKeyInput = ref('');
const savingKey = ref(false);

// P0-6 semantics: only a successful real submit marks the profile verified;
// discovery alone only ever reaches "nodes_detected".
const VERIF: Record<string, { cls: string; cn: string; en: string }> = {
  unconfigured: { cls: 'muted', cn: '未配置', en: 'Unconfigured' },
  nodes_detected: { cls: 'warn', cn: '已探测节点（未确认）', en: 'Nodes detected (unverified)' },
  verified: { cls: 'ok', cn: '已验证（真实渲染成功）', en: 'Verified (real render ok)' },
  failed: { cls: 'bad', cn: '检测失败', en: 'Detection failed' },
};
function verifClass(s: string | undefined): string {
  return VERIF[s ?? 'unconfigured']?.cls ?? 'muted';
}
function verifLabel(s: string | undefined): string {
  const v = VERIF[s ?? 'unconfigured'];
  if (!v) return '';
  return locale.value === 'en' ? v.en : v.cn;
}

async function load() {
  // Load independently: a failing endpoint must not blank the whole page.
  try {
    health.value = await get('/api/health');
  } catch (e) {
    healthError.value = e instanceof Error ? e.message : String(e);
  }
  try {
    profile.value = await get<AiAppProfile | null>('/api/providers/runninghub/profile');
    profileJson.value = JSON.stringify(profile.value, null, 2);
  } catch {
    /* profile stays null */
  }
  try {
    apiKeyInfo.value = await get<{ source: 'settings' | 'env' | 'none'; configured: boolean }>('/api/providers/runninghub/apikey');
  } catch {
    /* keep null */
  }
  await project.refreshProviders();
}

onMounted(() => {
  void load();
});

async function saveProjectConfig(patchData: Record<string, unknown>) {
  await project.saveConfig(patchData);
  notice.value = '项目配置已保存';
}

async function verify() {
  verifying.value = true;
  notice.value = '';
  try {
    profile.value = await post<AiAppProfile>('/api/providers/runninghub/verify');
    profileJson.value = JSON.stringify(profile.value, null, 2);
    notice.value = `检测完成：${profile.value.verification.note}`;
  } catch (e) {
    notice.value = `检测失败：${e instanceof Error ? e.message : e}`;
  } finally {
    verifying.value = false;
  }
}

async function saveProfile() {
  let parsed: unknown;
  try {
    parsed = JSON.parse(profileJson.value);
  } catch (e) {
    notice.value = `JSON 解析失败：${e instanceof Error ? e.message : e}`;
    return;
  }
  try {
    profile.value = await put('/api/providers/runninghub/profile', parsed);
    editingProfile.value = false;
    notice.value = 'Provider Profile 已保存（节点映射只影响 RunningHub 适配器）';
  } catch (e) {
    notice.value = `保存失败：${e instanceof Error ? e.message : e}`;
  }
}

async function saveApiKey() {
  if (!apiKeyInput.value.trim()) {
    notice.value = '请输入 API Key';
    return;
  }
  savingKey.value = true;
  try {
    apiKeyInfo.value = await put('/api/providers/runninghub/apikey', { key: apiKeyInput.value });
    apiKeyInput.value = '';
    notice.value = 'API Key 已保存（替换环境变量默认值，立即生效）';
  } catch (e) {
    notice.value = `API Key 保存失败：${e instanceof Error ? e.message : e}`;
  } finally {
    savingKey.value = false;
  }
}
</script>

<template>
  <div class="page">
    <h1>{{ t('pages.settings.title') }}</h1>

    <div class="grid">
      <div class="panel">
        <div class="panel-title">当前项目</div>
        <div class="panel-body col" v-if="project.current">
          <p class="muted">每个项目独立保存这些配置；切换项目请在顶栏下拉或 Projects 页操作。</p>
          <label class="field">标题<input :value="project.current.config.title" placeholder="项目名称" @change="saveProjectConfig({ title: ($event.target as HTMLInputElement).value })" /></label>
          <label class="field">
            项目画幅
            <select :value="project.current.config.default_aspect_ratio" @change="saveProjectConfig({ default_aspect_ratio: ($event.target as HTMLSelectElement).value })">
              <option>16:9</option><option>9:16</option><option>4:3</option><option>1:1</option>
            </select>
            <span class="muted">应用于项目内全部镜头；已有成片不会自动重新生成。</span>
          </label>
          <label class="field">
            新镜头默认时长
            <input type="number" :value="project.current.config.default_duration_seconds" title="默认时长（秒，1–15）" placeholder="5" @change="saveProjectConfig({ default_duration_seconds: Number(($event.target as HTMLInputElement).value) })" />
          </label>
          <label class="field">
            视觉风格
            <input :value="project.current.config.visual_style ?? ''" placeholder="如：胶片颗粒 + 暖色调" @change="saveProjectConfig({ visual_style: ($event.target as HTMLInputElement).value })" />
          </label>
          <div class="muted mono">{{ project.current.meta.dirPath }}</div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">Provider — RunningHub AI App</div>
        <div class="panel-body col">
          <div class="row">
            <span class="badge" :class="health === null || apiKeyInfo === null ? 'muted' : apiKeyInfo?.configured ? 'ok' : 'warn'">
              <template v-if="health === null || apiKeyInfo === null">API Key: 检测中…</template>
              <template v-else-if="apiKeyInfo?.source === 'settings'">API Key: 已设置（设置页）</template>
              <template v-else-if="apiKeyInfo?.source === 'env'">API Key: 已配置（环境变量）</template>
              <template v-else>API Key: 未配置（mock 模式可离线渲染）</template>
            </span>
            <span class="badge" :class="verifClass(profile?.verification.status)">
              {{ verifLabel(profile?.verification.status) }}
            </span>
          </div>
          <label class="field">
            API Key（RunningHub 控制台 → 设置 → API Token）
            <input v-model="apiKeyInput" type="password" autocomplete="off" placeholder="留空则沿用环境变量 RUNNINGHUB_API_KEY" />
          </label>
          <div class="row">
            <button class="sm" :disabled="savingKey" @click="saveApiKey">{{ savingKey ? '保存中…' : '保存 API Key' }}</button>
          </div>
          <p class="muted">
            AI App: <span class="mono">{{ profile?.appId }}</span> — 可换成你自己的 H3 工作流：在 RunningHub 控制台复制
            AI App ID 粘贴到下方 Profile 的 <span class="mono">appId</span>，保存后点「检测并获取节点映射」即可自动适配新工作流。
          </p>
          <div class="row">
            <button class="sm" :disabled="verifying" @click="verify">{{ verifying ? '检测中…' : '检测并获取节点映射（apiCallDemo）' }}</button>
            <button class="sm" @click="editingProfile = !editingProfile">编辑 Profile（JSON）</button>
          </div>
          <div v-if="profile?.verification.note" class="muted">上次检测：{{ profile.verification.note }}</div>
          <textarea v-if="editingProfile" v-model="profileJson" rows="12" class="mono" placeholder="在此粘贴 / 编辑 RunningHub AI App Profile JSON（appId、节点映射 inputs、成本、能力）"></textarea>
          <button v-if="editingProfile" class="primary sm" @click="saveProfile">保存 Profile</button>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">AI（可选）</div>
        <div class="panel-body col">
          <span class="badge" :class="health?.aiConfigured ? 'ok' : 'muted'">
            Built-in AI: {{ health?.aiConfigured ? 'Configured' : 'Not configured' }}
          </span>
          <p class="muted">
            无内置 AI 时产品完整可用。要启用，请在启动前设置环境变量：
            <span class="mono">AI_BASE_URL / AI_API_KEY / AI_MODEL</span>
            （OpenAI-compatible：OpenAI / DeepSeek / MiniMax / Ollama）。
          </p>
          <p class="muted">外部 AI 流程始终可用：Director Desk → External AI → Copy Context Package，粘贴到任意外部 AI。</p>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">Environment</div>
        <div class="panel-body col">
          <div class="row">
            <span class="badge" :class="health === null ? 'muted' : health?.ffmpeg.available ? 'ok' : 'bad'">
              <template v-if="health === null">ffmpeg 检测中…</template>
              <template v-else>ffmpeg {{ health?.ffmpeg.available ? '可用' : '缺失' }}</template>
            </span>
            <span v-if="health" class="muted mono">{{ health?.ffmpeg.ffmpegVersion }}</span>
            <span v-if="healthError" class="badge bad">health 接口异常：{{ healthError }}</span>
          </div>
          <p class="muted">启动顺序：Node Local Server → SQLite 初始化 → RenderQueue 恢复 → Web。渲染队列的 taskId 持久化，重启后可恢复轮询。</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 24px 32px; max-width: 1000px; margin: 0 auto; }
h1 { font-size: 21px; margin: 0 0 16px; }
.grid { grid-template-columns: 1fr 1fr; }
@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
</style>
