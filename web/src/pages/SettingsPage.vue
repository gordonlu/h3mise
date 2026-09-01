<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { get, post, put } from '../api/client';
import { useProjectStore } from '../stores/project';
import { locale, t } from '../stores/locale';
import type { AiAppProfile, ComfyUiWorkflowProfile, DirectorStylePreset, StoryboardProviderProfile } from '@h3mise/shared';

const project = useProjectStore();
const health = ref<{ ffmpeg: { available: boolean; ffmpegVersion: string | null }; runningHubConfigured: boolean; comfyUiConfigured: boolean; aiConfigured: boolean } | null>(null);
const healthError = ref('');
const profile = ref<AiAppProfile | null>(null);
const verifying = ref(false);
const notice = ref('');
const profileJson = ref('');
const editingProfile = ref(false);
const apiKeyInfo = ref<{ source: 'settings' | 'env' | 'none'; configured: boolean } | null>(null);
const apiKeyInput = ref('');
const savingKey = ref(false);
const comfyProfile = ref<ComfyUiWorkflowProfile | null>(null);
const comfyProfileJson = ref('');
const editingComfyProfile = ref(false);
const verifyingComfy = ref(false);
const storyboardProfile = ref<StoryboardProviderProfile | null>(null);
const verifyingStoryboard = ref(false);
const directorStyles = ref<DirectorStylePreset[]>([]);

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
  try {
    storyboardProfile.value = await get<StoryboardProviderProfile>('/api/providers/runninghub/storyboard-profile');
  } catch {
    /* keep null */
  }
  try {
    directorStyles.value = (await get<{ presets: DirectorStylePreset[] }>('/api/director-styles')).presets;
  } catch {
    /* free text remains available */
  }
  try {
    comfyProfile.value = await get<ComfyUiWorkflowProfile>('/api/providers/comfyui/profile');
    comfyProfileJson.value = JSON.stringify(comfyProfile.value, null, 2);
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

async function saveProviderConcurrency(provider: 'runninghub' | 'comfyui', value: number) {
  const concurrency = Math.min(4, Math.max(1, Math.round(value || 1)));
  try {
    await put(`/api/providers/${provider}/concurrency`, { concurrency });
    await load();
    notice.value = `并发上限已保存为 ${concurrency}；等待中的任务会按新上限调度`;
  } catch (e) {
    notice.value = `保存并发上限失败：${e instanceof Error ? e.message : e}`;
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

async function importComfyWorkflow(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    comfyProfile.value = await post<ComfyUiWorkflowProfile>('/api/providers/comfyui/import', parsed);
    comfyProfileJson.value = JSON.stringify(comfyProfile.value, null, 2);
    notice.value = `已导入 ${Object.keys(comfyProfile.value.workflow).length} 个节点。请检查自动映射，然后检测连接。`;
    await project.refreshProviders();
  } catch (e) {
    notice.value = `ComfyUI 工作流导入失败：${e instanceof Error ? e.message : e}`;
  }
}

async function saveComfyProfile() {
  try {
    const parsed = JSON.parse(comfyProfileJson.value);
    comfyProfile.value = await put<ComfyUiWorkflowProfile>('/api/providers/comfyui/profile', parsed);
    comfyProfileJson.value = JSON.stringify(comfyProfile.value, null, 2);
    editingComfyProfile.value = false;
    notice.value = 'ComfyUI Profile 已保存，请重新检测连接与映射';
    await project.refreshProviders();
  } catch (e) {
    notice.value = `ComfyUI Profile 保存失败：${e instanceof Error ? e.message : e}`;
  }
}

async function verifyComfyProfile() {
  verifyingComfy.value = true;
  try {
    comfyProfile.value = await post<ComfyUiWorkflowProfile>('/api/providers/comfyui/verify', {});
    comfyProfileJson.value = JSON.stringify(comfyProfile.value, null, 2);
    notice.value = `ComfyUI 检测完成：${comfyProfile.value.verification.note}`;
    await project.refreshProviders();
  } catch (e) {
    notice.value = `ComfyUI 检测失败：${e instanceof Error ? e.message : e}`;
  } finally {
    verifyingComfy.value = false;
  }
}

async function saveStoryboardProfile() {
  if (!storyboardProfile.value) return;
  try {
    storyboardProfile.value = await put<StoryboardProviderProfile>('/api/providers/runninghub/storyboard-profile', storyboardProfile.value);
    notice.value = 'Storyboard 生图配置已保存；修改 AI App 后请重新检测节点';
  } catch (e) {
    notice.value = `Storyboard 配置保存失败：${e instanceof Error ? e.message : e}`;
  }
}

async function verifyStoryboardProfile() {
  verifyingStoryboard.value = true;
  try {
    await saveStoryboardProfile();
    storyboardProfile.value = await post<StoryboardProviderProfile>('/api/providers/runninghub/storyboard-profile/verify', {});
    notice.value = `Storyboard 节点检测完成：${storyboardProfile.value.verification.note}`;
  } catch (e) {
    notice.value = `Storyboard 节点检测失败：${e instanceof Error ? e.message : e}`;
  } finally {
    verifyingStoryboard.value = false;
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
            默认生成服务
            <select :value="project.current.config.default_provider" @change="saveProjectConfig({ default_provider: ($event.target as HTMLSelectElement).value })">
              <option v-for="provider in project.providers" :key="provider.id" :value="provider.id">
                {{ provider.name }}{{ provider.configured ? '' : '（未配置）' }}
              </option>
            </select>
            <span class="muted">镜头会严格使用这里选择的 Provider；未配置时不会静默切换到其他服务。</span>
          </label>
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
            <input list="director-style-presets" :value="project.current.config.visual_style ?? ''" placeholder="如：武林外传风格、邵氏电影风格、港片警匪感" @change="saveProjectConfig({ visual_style: ($event.target as HTMLInputElement).value })" />
            <datalist id="director-style-presets"><option v-for="style in directorStyles" :key="style.id" :value="style.name" /></datalist>
            <span class="muted">熟悉的作品名只用于匹配；H3Mise AI 会接收通用导演属性，最终提示词不会照搬作品名。</span>
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
          <label class="field">
            同时生成任务数（1–4）
            <input type="number" min="1" max="4" :value="profile?.concurrency ?? 1" @change="saveProviderConcurrency('runninghub', Number(($event.target as HTMLInputElement).value))" />
            <span class="muted">按你的 RunningHub 账户并发额度设置。提高后可能同时创建多个付费任务。</span>
          </label>
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
        <div class="panel-title">Provider — Storyboard 生图（可选付费）</div>
        <div v-if="storyboardProfile" class="panel-body col">
          <div class="row">
            <span class="badge" :class="verifClass(storyboardProfile.verification.status)">{{ verifLabel(storyboardProfile.verification.status) }}</span>
            <label class="row"><input v-model="storyboardProfile.enabled" type="checkbox" /> 启用</label>
          </div>
          <p class="muted">复用 RunningHub API Key，但与视频 AI App 完全分开。只有在 Storyboard 页明确确认后才创建付费任务。</p>
          <label class="field">生图 AI App ID<input v-model="storyboardProfile.appId" class="mono" /></label>
          <label class="field">单次预估费用（CNY，仅用于确认提示）<input v-model.number="storyboardProfile.estimatedCostCny" type="number" min="0" step="0.01" /></label>
          <div class="grid two">
            <label class="field">3 格输出尺寸<input v-model="storyboardProfile.sizeValues[3]" /></label>
            <label class="field">6 格输出尺寸<input v-model="storyboardProfile.sizeValues[6]" /></label>
            <label class="field">9 格输出尺寸<input v-model="storyboardProfile.sizeValues[9]" /></label>
          </div>
          <div class="muted mono">Prompt {{ storyboardProfile.inputs.prompt.nodeId || '—' }}/{{ storyboardProfile.inputs.prompt.fieldName }} · Size {{ storyboardProfile.inputs.size.nodeId || '—' }}/{{ storyboardProfile.inputs.size.fieldName }} · Layout {{ storyboardProfile.inputs.layoutImage.nodeId || '—' }}/{{ storyboardProfile.inputs.layoutImage.fieldName }}</div>
          <div v-if="storyboardProfile.verification.note" class="muted">{{ storyboardProfile.verification.note }}</div>
          <div class="row">
            <button class="sm" @click="saveStoryboardProfile">保存</button>
            <button class="primary sm" :disabled="verifyingStoryboard" @click="verifyStoryboardProfile">{{ verifyingStoryboard ? '检测中…' : '保存并检测节点' }}</button>
          </div>
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
          <label class="field">
            同时生成任务数（1–4）
            <input type="number" min="1" max="4" :value="comfyProfile?.concurrency ?? 1" @change="saveProviderConcurrency('comfyui', Number(($event.target as HTMLInputElement).value))" />
            <span class="muted">默认 1；只有显存和工作流允许时才提高。</span>
          </label>
          <p class="muted">外部 AI 流程始终可用：Director Desk → External AI → Copy Context Package，粘贴到任意外部 AI。</p>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">Provider — ComfyUI Local</div>
        <div class="panel-body col">
          <div class="row">
            <span class="badge" :class="verifClass(comfyProfile?.verification.status)">{{ verifLabel(comfyProfile?.verification.status) }}</span>
            <span class="mono muted">{{ comfyProfile?.baseUrl }}{{ comfyProfile?.apiPrefix }}</span>
          </div>
          <p class="muted">
            导入 ComfyUI 的 <strong>API Format</strong> 工作流。H3Mise 会推断 Prompt、首尾帧、参考图、时长、画幅和像素输入；推断结果必须检查并检测后才可生成。
          </p>
          <div class="row wrap">
            <label class="sm file-button">
              导入 workflow_api.json
              <input type="file" accept="application/json,.json" hidden @change="importComfyWorkflow" />
            </label>
            <button class="sm" :disabled="verifyingComfy || !comfyProfile || !Object.keys(comfyProfile.workflow).length" @click="verifyComfyProfile">
              {{ verifyingComfy ? '检测中…' : '检测连接与映射' }}
            </button>
            <button class="sm" @click="editingComfyProfile = !editingComfyProfile">编辑 Profile（JSON）</button>
            <a class="sm button-link" href="https://github.com/gordonlu/h3mise/blob/master/ComfyUI.md" target="_blank" rel="noreferrer">Agent 接入指引</a>
          </div>
          <div v-if="comfyProfile?.verification.note" class="muted">状态：{{ comfyProfile.verification.note }}</div>
          <textarea v-if="editingComfyProfile" v-model="comfyProfileJson" rows="14" class="mono" placeholder="ComfyUI Profile JSON"></textarea>
          <button v-if="editingComfyProfile" class="primary sm" @click="saveComfyProfile">保存 ComfyUI Profile</button>
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
.file-button, .button-link {
  display: inline-flex;
  align-items: center;
  padding: 5px 11px;
  color: var(--text);
  background: var(--bg-2);
  border: 1px solid var(--line-2);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12px;
  text-decoration: none;
}
.file-button:hover, .button-link:hover { background: var(--accent-soft); border-color: var(--accent-line); text-decoration: none; }
@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
</style>
