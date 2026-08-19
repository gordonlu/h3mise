<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { get, post, put } from '../api/client';
import { useProjectStore } from '../stores/project';
import type { AiAppProfile } from '@h3mise/shared';

const project = useProjectStore();
const health = ref<{ ffmpeg: { available: boolean; ffmpegVersion: string | null }; runningHubConfigured: boolean; aiConfigured: boolean } | null>(null);
const profile = ref<AiAppProfile | null>(null);
const verifying = ref(false);
const notice = ref('');
const profileJson = ref('');
const editingProfile = ref(false);

async function load() {
  health.value = await get('/api/health');
  profile.value = await get<AiAppProfile | null>('/api/providers/runninghub/profile');
  profileJson.value = JSON.stringify(profile.value, null, 2);
  await project.refreshProviders();
}

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
  try {
    profile.value = await put('/api/providers/runninghub/profile', JSON.parse(profileJson.value));
    editingProfile.value = false;
    notice.value = 'Provider Profile 已保存（节点映射只影响 RunningHub 适配器）';
  } catch (e) {
    notice.value = `保存失败：${e instanceof Error ? e.message : e}`;
  }
}
</script>

<template>
  <div class="page">
    <h1>Settings</h1>

    <div class="grid">
      <div class="panel">
        <div class="panel-title">Project</div>
        <div class="panel-body col" v-if="project.current">
          <label class="field">标题<input :value="project.current.config.title" @change="saveProjectConfig({ title: ($event.target as HTMLInputElement).value })" /></label>
          <label class="field">
            画幅
            <select :value="project.current.config.default_aspect_ratio" @change="saveProjectConfig({ default_aspect_ratio: ($event.target as HTMLSelectElement).value })">
              <option>16:9</option><option>9:16</option><option>4:3</option><option>1:1</option>
            </select>
          </label>
          <label class="field">
            默认时长
            <input type="number" :value="project.current.config.default_duration_seconds" @change="saveProjectConfig({ default_duration_seconds: Number(($event.target as HTMLInputElement).value) })" />
          </label>
          <label class="field">
            视觉风格
            <input :value="project.current.config.visual_style ?? ''" @change="saveProjectConfig({ visual_style: ($event.target as HTMLInputElement).value })" />
          </label>
          <div class="muted mono">{{ project.current.meta.dirPath }}</div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">Provider — RunningHub AI App</div>
        <div class="panel-body col">
          <div class="row">
            <span class="badge" :class="health?.runningHubConfigured ? 'ok' : 'warn'">
              API Key: {{ health?.runningHubConfigured ? '已配置（环境变量）' : '未配置 RUNNINGHUB_API_KEY' }}
            </span>
            <span class="badge" :class="profile?.verification.status === 'verified' ? 'ok' : profile?.verification.status === 'failed' ? 'bad' : 'muted'">
              {{ profile?.verification.status === 'verified' ? '已验证节点' : profile?.verification.status === 'failed' ? '检测失败' : '未检测' }}
            </span>
          </div>
          <p class="muted">AI App: <span class="mono">{{ profile?.appId }}</span>（用户自己的 H3 工作流，v0.1 唯一渲染后端）</p>
          <div class="row">
            <button class="sm" :disabled="verifying" @click="verify">{{ verifying ? '检测中…' : '检测并获取节点映射（apiCallDemo）' }}</button>
            <button class="sm" @click="editingProfile = !editingProfile">编辑 Profile（JSON）</button>
          </div>
          <div v-if="profile?.verification.note" class="muted">上次检测：{{ profile.verification.note }}</div>
          <textarea v-if="editingProfile" v-model="profileJson" rows="12" class="mono"></textarea>
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
          <div class="row"><span class="badge" :class="health?.ffmpeg.available ? 'ok' : 'bad'">ffmpeg {{ health?.ffmpeg.available ? '可用' : '缺失' }}</span><span class="muted mono">{{ health?.ffmpeg.ffmpegVersion }}</span></div>
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
