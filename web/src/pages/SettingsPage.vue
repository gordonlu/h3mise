<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { get, post, put } from '../api/client';
import { useProjectStore } from '../stores/project';
import { locale, t } from '../stores/locale';
import type { AiAppProfile, ComfyUiWorkflowProfile, DirectorStylePreset, ProjectConfig, RunningHubRegion, StoryboardProviderProfile, WorkflowProfile } from '@h3mise/shared';

const project = useProjectStore();
const route = useRoute();
const health = ref<{ ffmpeg: { available: boolean; ffmpegVersion: string | null }; runningHubConfigured: boolean; comfyUiConfigured: boolean; aiConfigured: boolean } | null>(null);
const healthError = ref('');
const profile = ref<AiAppProfile | null>(null);
const verifying = ref(false);
const notice = ref('');
const profileJson = ref('');
const editingProfile = ref(false);
const apiKeyInfo = ref<{ source: 'settings' | 'env' | 'none'; configured: boolean } | null>(null);
const apiKeyInput = ref('');
const agentCopied = ref(false);
const agentInstruction = computed(() => t('pages.settings.agentInstruction'));

async function copyAgentInstruction(): Promise<void> {
  try {
    await navigator.clipboard.writeText(agentInstruction.value);
    agentCopied.value = true;
    setTimeout(() => (agentCopied.value = false), 2200);
  } catch {
    /* clipboard unavailable — the textarea is selectable as a fallback */
  }
}
const savingKey = ref(false);
const comfyProfile = ref<ComfyUiWorkflowProfile | null>(null);
const comfyProfileJson = ref('');
const editingComfyProfile = ref(false);
const verifyingComfy = ref(false);
const storyboardProfile = ref<StoryboardProviderProfile | null>(null);
const verifyingStoryboard = ref(false);
const savingRegion = ref(false);
const aiApps = ref<WorkflowProfile[]>([]);
const savingAiApps = ref(false);
const payloadPreview = ref('');
const frameProfile = ref<AiAppProfile | null>(null);
const frameAppIdInput = ref('');
const savingFrame = ref(false);
const verifyingFrame = ref(false);
const directorStyles = ref<DirectorStylePreset[]>([]);
const projectConfigForm = ref<Pick<ProjectConfig, 'title' | 'default_provider' | 'default_aspect_ratio' | 'default_duration_seconds' | 'visual_style'>>({
  title: '',
  default_provider: 'runninghub',
  default_aspect_ratio: '16:9',
  default_duration_seconds: 12,
  visual_style: '',
});
const projectConfigDirty = ref(false);
const savingProjectConfig = ref(false);

watch(() => project.current?.config, (config) => {
  if (!config) return;
  projectConfigForm.value = {
    title: config.title,
    default_provider: config.default_provider,
    default_aspect_ratio: config.default_aspect_ratio,
    default_duration_seconds: config.default_duration_seconds,
    visual_style: config.visual_style ?? '',
  };
  projectConfigDirty.value = false;
}, { immediate: true });

// P0-6 semantics: only a successful real submit marks the profile verified;
// discovery alone only ever reaches "nodes_detected".
const VERIF: Record<string, { cls: string; cn: string; en: string; ja: string }> = {
  unconfigured: { cls: 'muted', cn: '未配置', en: 'Unconfigured', ja: '未設定' },
  nodes_detected: { cls: 'warn', cn: '已探测节点（未确认）', en: 'Nodes detected (unverified)', ja: 'ノード検出済み（未検証）' },
  verified: { cls: 'ok', cn: '已验证（真实渲染成功）', en: 'Verified (real render ok)', ja: '検証済み（実レンダー成功）' },
  failed: { cls: 'bad', cn: '检测失败', en: 'Detection failed', ja: '検出失敗' },
};
function verifClass(s: string | undefined): string {
  return VERIF[s ?? 'unconfigured']?.cls ?? 'muted';
}
function verifLabel(s: string | undefined): string {
  const v = VERIF[s ?? 'unconfigured'];
  if (!v) return '';
  return locale.value === 'en' ? v.en : locale.value === 'ja' ? v.ja : v.cn;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localizedProviderNote(note: string | undefined): string {
  if (!note) return '';
  const exact: Record<string, string> = {
    'a real render submission succeeded against this profile': 'pages.settings.noteVideoVerified',
    'Storyboard 生图是可选付费功能；请先检测 AI App 节点映射': 'pages.settings.noteStoryboardSetup',
    'RunningHub 站点、AI App 或节点映射已修改，请重新检测': 'pages.settings.noteRunningHubChanged',
    'RunningHub 站点已修改，请重新检测 Storyboard AI App 节点': 'pages.settings.noteStoryboardChanged',
    '真实 Storyboard 任务已成功提交': 'pages.settings.noteStoryboardVerified',
    'import a ComfyUI workflow in API format, then test the connection and mapping': 'pages.settings.noteComfySetup',
    'a real ComfyUI prompt was accepted with this workflow mapping': 'pages.settings.noteComfyVerified',
  };
  if (exact[note]) return t(exact[note]);
  const detected = note.match(/^已检测 (\d+) 个节点；首次真实生图成功后标记为已验证$/);
  if (detected) return t('pages.settings.noteNodesDetected', { n: detected[1] ?? '0' });
  const connected = note.match(/^connected to (.+); workflow has (\d+) nodes — mapping awaits one successful render$/);
  if (connected) return t('pages.settings.noteComfyConnected', { url: connected[1] ?? '', n: connected[2] ?? '0' });
  return note;
}

async function saveRunningHubRegion(region: RunningHubRegion) {
  if (!profile.value || profile.value.region === region || savingRegion.value) return;
  savingRegion.value = true;
  try {
    const result = await put<{ profile: AiAppProfile; storyboardProfile: StoryboardProviderProfile }>('/api/providers/runninghub/region', { region });
    profile.value = result.profile;
    storyboardProfile.value = result.storyboardProfile;
    profileJson.value = JSON.stringify(result.profile, null, 2);
    apiKeyInfo.value = await get<{ source: 'settings' | 'env' | 'none'; configured: boolean }>('/api/providers/runninghub/apikey');
    await project.refreshProviders();
    notice.value = t('pages.settings.regionSaved');
  } catch (e) {
    notice.value = t('pages.settings.regionSaveFailed', { msg: e instanceof Error ? e.message : String(e) });
  } finally {
    savingRegion.value = false;
  }
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
    // Sync AI Apps list from profile
    aiApps.value = profile.value?.apps?.length
      ? profile.value.apps.map((app) => ({ ...app }))
      : [{ id: 'app-primary', name: '主视频生成', appId: profile.value?.appId ?? '', description: '默认 H3 视频生成 App' }];
  } catch {
    /* profile stays null */
  }
  try {
    apiKeyInfo.value = await get<{ source: 'settings' | 'env' | 'none'; configured: boolean }>('/api/providers/runninghub/apikey');
  } catch {
    /* keep null */
  }
  try {
    frameProfile.value = await get<AiAppProfile | null>('/api/providers/runninghub/frame-profile');
    frameAppIdInput.value = frameProfile.value?.appId ?? '';
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

async function saveProjectConfig() {
  if (!project.current || savingProjectConfig.value) return;
  const title = projectConfigForm.value.title.trim();
  const duration = Number(projectConfigForm.value.default_duration_seconds);
  if (!title || !Number.isFinite(duration) || duration < 1 || duration > 15) {
    notice.value = t('pages.settings.projectSaveInvalid');
    return;
  }
  savingProjectConfig.value = true;
  try {
    await project.saveConfig({ ...projectConfigForm.value, title, default_duration_seconds: duration });
    await project.refreshProjects();
    projectConfigDirty.value = false;
    notice.value = t('pages.settings.projectSaved');
  } catch (e) {
    notice.value = t('pages.settings.projectSaveFailed', { msg: errorMessage(e) });
  } finally {
    savingProjectConfig.value = false;
  }
}

async function verify() {
  verifying.value = true;
  notice.value = '';
  try {
    profile.value = await post<AiAppProfile>('/api/providers/runninghub/verify');
    profileJson.value = JSON.stringify(profile.value, null, 2);
    notice.value = t('pages.settings.detectDone', { note: localizedProviderNote(profile.value.verification.note) });
  } catch (e) {
    notice.value = t('pages.settings.detectFailed', { msg: errorMessage(e) });
  } finally {
    verifying.value = false;
  }
}

async function saveProfile() {
  let parsed: unknown;
  try {
    parsed = JSON.parse(profileJson.value);
  } catch (e) {
    notice.value = t('pages.settings.jsonParseFailed', { msg: errorMessage(e) });
    return;
  }
  try {
    profile.value = await put('/api/providers/runninghub/profile', parsed);
    editingProfile.value = false;
    notice.value = t('pages.settings.profileSaved');
  } catch (e) {
    notice.value = t('pages.settings.saveFailed', { msg: errorMessage(e) });
  }
}

async function saveProviderConcurrency(provider: 'runninghub' | 'comfyui', value: number) {
  const concurrency = Math.min(4, Math.max(1, Math.round(value || 1)));
  try {
    await put(`/api/providers/${provider}/concurrency`, { concurrency });
    await load();
    notice.value = t('pages.settings.concurrencySaved', { n: concurrency });
  } catch (e) {
    notice.value = t('pages.settings.concurrencySaveFailed', { msg: errorMessage(e) });
  }
}

async function saveApiKey() {
  if (!apiKeyInput.value.trim()) {
    notice.value = t('pages.settings.enterApiKey');
    return;
  }
  savingKey.value = true;
  try {
    apiKeyInfo.value = await put('/api/providers/runninghub/apikey', { key: apiKeyInput.value });
    apiKeyInput.value = '';
    notice.value = t('pages.settings.apiKeySaved');
  } catch (e) {
    notice.value = t('pages.settings.apiKeySaveFailed', { msg: errorMessage(e) });
  } finally {
    savingKey.value = false;
  }
}

function addAiApp() {
  aiApps.value.push({
    id: `app-${Date.now()}`,
    name: '',
    appId: '',
    description: '',
  });
}

function removeAiApp(id: string) {
  const removedActive = profile.value?.activeWorkflowId === id;
  aiApps.value = aiApps.value.filter((a) => a.id !== id);
  if (removedActive && profile.value) profile.value.activeWorkflowId = aiApps.value[0]?.id;
}

async function saveAiApps() {
  savingAiApps.value = true;
  try {
    const updated = await put<AiAppProfile>('/api/providers/runninghub/profile', {
      ...profile.value,
      apps: aiApps.value,
    });
    profile.value = updated;
    profileJson.value = JSON.stringify(updated, null, 2);
    aiApps.value = updated.apps.map((app) => ({ ...app }));
    notice.value = t('pages.settings.aiAppsSaved');
    await project.refreshProviders();
  } catch (e) {
    notice.value = t('pages.settings.aiAppsSaveFailed', { msg: errorMessage(e) });
  } finally {
    savingAiApps.value = false;
  }
}

async function activateAiApp(app: WorkflowProfile) {
  if (!app.inputs?.prompt?.nodeId) {
    notice.value = '该 App 还没有节点映射：请先保存，再检测节点，之后才能设为当前工作流。';
    return;
  }
  try {
    profile.value = await post<AiAppProfile>(`/api/providers/runninghub/workflows/${encodeURIComponent(app.id)}/activate`, {});
    profileJson.value = JSON.stringify(profile.value, null, 2);
    aiApps.value = profile.value.apps.map((entry) => ({ ...entry }));
    notice.value = `已切换到 ${app.name || app.appId}`;
    await project.refreshProviders();
  } catch (e) {
    notice.value = errorMessage(e);
  }
}

async function verifyAiApp(app: WorkflowProfile) {
  if (!profile.value?.apps?.some((entry) => entry.id === app.id)) {
    notice.value = '请先保存 AI App 列表，再检测节点。';
    return;
  }
  notice.value = '正在检测节点…';
  try {
    const workflow = await post<WorkflowProfile>(`/api/providers/runninghub/workflows/${encodeURIComponent(app.id)}/verify`, {});
    profile.value = await get<AiAppProfile | null>('/api/providers/runninghub/profile');
    if (profile.value) {
      profileJson.value = JSON.stringify(profile.value, null, 2);
      aiApps.value = profile.value.apps.map((entry) => ({ ...entry }));
    }
    notice.value = workflow.verification?.note ?? '节点检测完成';
    await project.refreshProviders();
  } catch (e) {
    notice.value = errorMessage(e);
    profile.value = await get<AiAppProfile | null>('/api/providers/runninghub/profile').catch(() => profile.value);
    if (profile.value) {
      profileJson.value = JSON.stringify(profile.value, null, 2);
      aiApps.value = profile.value.apps.map((entry) => ({ ...entry }));
    }
  }
}

async function previewAiApp(app: WorkflowProfile) {
  const mode = app.modes?.[0];
  if (!mode) {
    payloadPreview.value = '该工作流还没有可预览的模式。';
    return;
  }
  try {
    const result = await post<{ nodeInfoList: Array<{ nodeId: string; fieldName: string; fieldValue: string }> }>(
      `/api/providers/runninghub/workflows/${encodeURIComponent(app.id)}/preview`,
      { mode },
    );
    payloadPreview.value = JSON.stringify(result.nodeInfoList, null, 2);
  } catch (e) {
    payloadPreview.value = errorMessage(e);
  }
}

async function saveFrameApp() {
  savingFrame.value = true;
  try {
    frameProfile.value = await put<AiAppProfile>('/api/providers/runninghub/frame-profile', {
      ...(frameProfile.value ?? {}),
      appId: frameAppIdInput.value.trim(),
    });
    frameAppIdInput.value = frameProfile.value.appId;
    notice.value = 'Frame App 已保存；现在可以检测节点。';
    await project.refreshProviders();
  } catch (e) {
    notice.value = `Frame App 保存失败：${errorMessage(e)}`;
  } finally {
    savingFrame.value = false;
  }
}

async function verifyFrameApp() {
  verifyingFrame.value = true;
  try {
    frameProfile.value = await post<AiAppProfile>('/api/providers/runninghub/frame-profile/verify', {});
    notice.value = localizedProviderNote(frameProfile.value.verification.note);
    await project.refreshProviders();
  } catch (e) {
    notice.value = `Frame 节点检测失败：${errorMessage(e)}`;
  } finally {
    verifyingFrame.value = false;
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
    notice.value = t('pages.settings.comfyImported', { n: Object.keys(comfyProfile.value.workflow).length });
    await project.refreshProviders();
  } catch (e) {
    notice.value = t('pages.settings.comfyImportFailed', { msg: errorMessage(e) });
  }
}

async function saveComfyProfile() {
  try {
    const parsed = JSON.parse(comfyProfileJson.value);
    comfyProfile.value = await put<ComfyUiWorkflowProfile>('/api/providers/comfyui/profile', parsed);
    comfyProfileJson.value = JSON.stringify(comfyProfile.value, null, 2);
    editingComfyProfile.value = false;
    notice.value = t('pages.settings.comfyProfileSaved');
    await project.refreshProviders();
  } catch (e) {
    notice.value = t('pages.settings.comfyProfileSaveFailed', { msg: errorMessage(e) });
  }
}

async function verifyComfyProfile() {
  verifyingComfy.value = true;
  try {
    comfyProfile.value = await post<ComfyUiWorkflowProfile>('/api/providers/comfyui/verify', {});
    comfyProfileJson.value = JSON.stringify(comfyProfile.value, null, 2);
    notice.value = t('pages.settings.comfyVerified', { note: localizedProviderNote(comfyProfile.value.verification.note) });
    await project.refreshProviders();
  } catch (e) {
    notice.value = t('pages.settings.comfyVerifyFailed', { msg: errorMessage(e) });
  } finally {
    verifyingComfy.value = false;
  }
}

async function saveStoryboardProfile() {
  if (!storyboardProfile.value) return;
  try {
    storyboardProfile.value = await put<StoryboardProviderProfile>('/api/providers/runninghub/storyboard-profile', storyboardProfile.value);
    notice.value = t('pages.settings.storyboardSaved');
  } catch (e) {
    notice.value = t('pages.settings.storyboardSaveFailed', { msg: errorMessage(e) });
  }
}

async function verifyStoryboardProfile() {
  verifyingStoryboard.value = true;
  try {
    await saveStoryboardProfile();
    storyboardProfile.value = await post<StoryboardProviderProfile>('/api/providers/runninghub/storyboard-profile/verify', {});
    notice.value = t('pages.settings.storyboardVerified', { note: localizedProviderNote(storyboardProfile.value.verification.note) });
  } catch (e) {
    notice.value = t('pages.settings.storyboardVerifyFailed', { msg: errorMessage(e) });
  } finally {
    verifyingStoryboard.value = false;
  }
}
function scrollToSetting(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
// Sections are mounted synchronously; wait for rendering before following guide links.
watch(() => route.hash, async (hash) => {
  await nextTick();
  if (hash.startsWith('#set-')) scrollToSetting(hash.slice(1));
}, { immediate: true });
</script>

<template>
  <div class="page">
    <h1>{{ t('pages.settings.title') }}</h1>
    <p><RouterLink to="/welcome">{{ t('welcome.guide') }}</RouterLink></p>

    <div class="settings-layout">
      <nav class="settings-nav" :aria-label="t('pages.settings.title')">
        <button @click="scrollToSetting('set-project')">{{ t('pages.settings.currentProject') }}</button>
        <button @click="scrollToSetting('set-runninghub')">RunningHub</button>
        <button @click="scrollToSetting('set-storyboard')">Storyboard</button>
        <button @click="scrollToSetting('set-comfyui')">ComfyUI</button>
        <button @click="scrollToSetting('set-ai')">AI</button>
        <button @click="scrollToSetting('set-env')">{{ t('pages.settings.environment') }}</button>
      </nav>

      <div class="grid">
      <div id="set-project" class="panel">
        <div class="panel-title">{{ t('pages.settings.currentProject') }}</div>
        <div class="panel-body col" v-if="project.current">
          <p class="muted">{{ t('pages.settings.projectHelp') }}</p>
          <label class="field">{{ t('pages.settings.projectTitle') }}<input v-model="projectConfigForm.title" :placeholder="t('pages.settings.projectNamePlaceholder')" @input="projectConfigDirty = true" /></label>
          <label class="field">
            {{ t('pages.settings.defaultProvider') }}
            <select v-model="projectConfigForm.default_provider" @change="projectConfigDirty = true">
              <option v-for="provider in project.providers" :key="provider.id" :value="provider.id">
                {{ provider.name }}{{ provider.configured ? '' : ` (${t('common.unconfigured')})` }}
              </option>
            </select>
            <span class="muted">{{ t('pages.settings.providerStrictHelp') }}</span>
          </label>
          <label class="field">
            {{ t('pages.settings.aspectRatio') }}
            <select v-model="projectConfigForm.default_aspect_ratio" @change="projectConfigDirty = true">
              <option>16:9</option><option>9:16</option><option>4:3</option><option>1:1</option>
            </select>
            <span class="muted">{{ t('pages.settings.aspectRatioHelp') }}</span>
          </label>
          <label class="field">
            {{ t('pages.settings.defaultDuration') }}
            <input v-model.number="projectConfigForm.default_duration_seconds" type="number" min="1" max="15" :title="t('pages.settings.defaultDurationTitle')" placeholder="12" @input="projectConfigDirty = true" />
          </label>
          <label class="field">
            {{ t('pages.settings.visualStyle') }}
            <input v-model="projectConfigForm.visual_style" list="director-style-presets" :placeholder="t('pages.settings.visualStylePlaceholder')" @input="projectConfigDirty = true" />
            <datalist id="director-style-presets"><option v-for="style in directorStyles" :key="style.id" :value="style.name" /></datalist>
            <span class="muted">{{ t('pages.settings.visualStyleHelp') }}</span>
          </label>
          <div class="muted mono">{{ project.current.meta.dirPath }}</div>
          <div class="project-save-row">
            <span v-if="projectConfigDirty" class="muted">{{ t('pages.settings.unsavedChanges') }}</span>
            <button class="primary" :disabled="savingProjectConfig || !projectConfigDirty" @click="saveProjectConfig">
              {{ savingProjectConfig ? t('pages.settings.savingProject') : t('pages.settings.saveProject') }}
            </button>
          </div>
        </div>
      </div>

      <div id="set-runninghub" class="panel">
        <div class="panel-title">{{ t('pages.settings.runningHubProvider') }}</div>
        <div class="panel-body col">
          <p v-if="apiKeyInfo && !apiKeyInfo.configured" class="muted">
            {{ t('welcome.missingKeyHelp') }} <RouterLink to="/welcome">{{ t('welcome.guide') }}</RouterLink>
          </p>
          <div class="row">
            <span class="badge" :class="health === null || apiKeyInfo === null ? 'muted' : apiKeyInfo?.configured ? 'ok' : 'warn'">
              <template v-if="health === null || apiKeyInfo === null">{{ t('pages.settings.apiKeyChecking') }}</template>
              <template v-else-if="apiKeyInfo?.source === 'settings'">{{ t('pages.settings.apiKeySettings') }}</template>
              <template v-else-if="apiKeyInfo?.source === 'env'">{{ t('pages.settings.apiKeyEnv') }}</template>
              <template v-else>{{ t('pages.settings.apiKeyMissing') }}</template>
            </span>
            <span class="badge" :class="verifClass(profile?.verification.status)">
              {{ verifLabel(profile?.verification.status) }}
            </span>
          </div>
          <label v-if="profile" class="field">
            {{ t('pages.settings.region') }}
            <select :value="profile.region" :disabled="savingRegion" @change="saveRunningHubRegion(($event.target as HTMLSelectElement).value as RunningHubRegion)">
              <option value="cn">{{ t('pages.settings.regionCn') }}</option>
              <option value="global">{{ t('pages.settings.regionGlobal') }}</option>
            </select>
            <span class="muted">{{ savingRegion ? t('pages.settings.regionSaving') : t('pages.settings.regionHelp') }}</span>
          </label>
          <div class="row wrap">
            <a class="sm button-link" href="https://www.runninghub.cn/" target="_blank" rel="noreferrer">{{ t('pages.settings.mainlandSite') }}</a>
            <a class="sm button-link" href="https://www.runninghub.ai/" target="_blank" rel="noreferrer">{{ t('pages.settings.globalSite') }}</a>
          </div>
          <label class="field">
            {{ t('pages.settings.apiKeyLabel') }}
            <input v-model="apiKeyInput" type="password" autocomplete="off" :placeholder="t('pages.settings.apiKeyPlaceholder')" />
          </label>
          <div class="row">
            <button class="sm" :disabled="savingKey" @click="saveApiKey">{{ savingKey ? t('pages.settings.saving') : t('pages.settings.saveApiKey') }}</button>
          </div>
          <p class="muted">{{ t('pages.settings.aiAppHelp') }}</p>
          <div class="ai-apps">
            <div v-for="app in aiApps" :key="app.id" class="ai-app-card">
              <div class="ai-app-header row">
                <span class="badge" :class="profile?.activeWorkflowId === app.id ? 'ok' : 'muted'">{{ profile?.activeWorkflowId === app.id ? t('pages.settings.primaryApp') : t('pages.settings.secondaryApp') }}</span>
                <span class="badge" :class="app.runnable ? 'ok' : 'warn'">{{ app.runnable ? '已映射' : '无映射' }}</span>
                <span class="badge" :class="verifClass(app.verification?.status)">{{ verifLabel(app.verification?.status) }}</span>
                <button v-if="aiApps.length > 1" class="sm danger" @click="removeAiApp(app.id)">{{ t('pages.settings.deleteApp') }}</button>
              </div>
              <label class="field">{{ t('pages.settings.appName') }}<input v-model="app.name" /></label>
              <label class="field">{{ t('pages.settings.appIdLabel') }}<input v-model="app.appId" class="mono" /></label>
              <label class="field">{{ t('pages.settings.appDescription') }}<input v-model="app.description" :placeholder="t('pages.settings.appDescriptionPlaceholder')" /></label>
              <div class="muted mono app-mapping">
                prompt {{ app.inputs?.prompt?.nodeId || '—' }} · images {{ app.inputs?.refImages?.filter((slot) => slot.nodeId).length ?? 0 }} · audio {{ app.inputs?.refAudios?.filter((slot) => slot.nodeId).length ?? 0 }} · video {{ app.inputs?.refVideos?.filter((slot) => slot.nodeId).length ?? 0 }}
                <template v-if="app.modes?.length"> · {{ app.modes.join(', ') }}</template>
              </div>
              <div v-if="app.readiness?.some((item) => item.supported)" class="readiness">
                <span v-for="item in app.readiness.filter((entry) => entry.supported)" :key="item.mode" class="badge" :class="item.ready ? 'ok' : 'warn'">
                  {{ item.mode }}{{ item.ready ? ' ✓' : ` 缺：${item.missing.join('、')}` }}
                </span>
              </div>
              <div class="row wrap">
                <button class="sm" :disabled="!app.runnable || profile?.activeWorkflowId === app.id" @click="activateAiApp(app)">设为当前</button>
                <button class="sm" :disabled="!profile?.apps?.some((entry) => entry.id === app.id)" @click="verifyAiApp(app)">检测节点</button>
                <button class="sm" :disabled="!app.runnable" @click="previewAiApp(app)">预览载荷</button>
                <span v-if="!profile?.apps?.some((entry) => entry.id === app.id)" class="muted">先保存再检测</span>
              </div>
            </div>
            <div class="row">
              <button class="sm" @click="addAiApp">+ {{ t('pages.settings.addApp') }}</button>
              <button class="sm primary" :disabled="savingAiApps" @click="saveAiApps">{{ savingAiApps ? t('pages.settings.saving') : t('pages.settings.saveAiApps') }}</button>
            </div>
          </div>
          <details class="frame-app" :open="Boolean(frameProfile)">
            <summary>Frame App（首帧 / 尾帧，I2VA / L2VA / FL2VA）</summary>
            <p class="muted">先保存 App ID，再点检测节点；Frame App 的映射与主工作流完全独立。</p>
            <label class="field">Frame AI App ID
              <input v-model="frameAppIdInput" class="mono" placeholder="填写发布后的 Frame App ID" />
            </label>
            <div class="row wrap">
              <button class="sm" :disabled="savingFrame || !frameAppIdInput.trim()" @click="saveFrameApp">{{ savingFrame ? t('pages.settings.saving') : t('common.save') }}</button>
              <button class="sm" :disabled="verifyingFrame || !frameProfile" @click="verifyFrameApp">{{ verifyingFrame ? t('pages.settings.detecting') : '保存后检测节点' }}</button>
              <span v-if="frameProfile" class="badge" :class="verifClass(frameProfile.verification.status)">{{ verifLabel(frameProfile.verification.status) }}</span>
            </div>
            <div v-if="frameProfile" class="muted mono app-mapping">
              first {{ frameProfile.inputs.firstFrame?.nodeId || '—' }} · last {{ frameProfile.inputs.lastFrame?.nodeId || '—' }} · prompt {{ frameProfile.inputs.prompt.nodeId || '—' }}
            </div>
            <div v-if="frameProfile?.verification.note" class="muted">{{ localizedProviderNote(frameProfile.verification.note) }}</div>
          </details>
          <div v-if="payloadPreview" class="col">
            <div class="row"><strong>不提交的载荷预览</strong><button class="sm ghost" @click="payloadPreview = ''">关闭</button></div>
            <pre class="payload-preview mono">{{ payloadPreview }}</pre>
          </div>
          <label class="field">
            {{ t('pages.settings.concurrency') }}
            <input type="number" min="1" max="4" :value="profile?.concurrency ?? 1" @change="saveProviderConcurrency('runninghub', Number(($event.target as HTMLInputElement).value))" />
            <span class="muted">{{ t('pages.settings.concurrencyHelp') }}</span>
          </label>
          <div class="row">
            <button class="sm" :disabled="verifying" @click="verify">{{ verifying ? t('pages.settings.detecting') : t('pages.settings.detectNodes') }}</button>
            <button class="sm" @click="editingProfile = !editingProfile">{{ t('pages.settings.editProfile') }}</button>
          </div>
          <div v-if="profile?.verification.note" class="muted">{{ t('pages.settings.lastDetection', { note: localizedProviderNote(profile.verification.note) }) }}</div>
          <textarea v-if="editingProfile" v-model="profileJson" rows="12" class="mono" :placeholder="t('pages.settings.profileJsonPlaceholder')"></textarea>
          <button v-if="editingProfile" class="primary sm" @click="saveProfile">{{ t('pages.settings.saveProfile') }}</button>
        </div>
      </div>

      <div id="set-storyboard" class="panel">
        <div class="panel-title">{{ t('pages.settings.storyboardProvider') }}</div>
        <div v-if="storyboardProfile" class="panel-body col">
          <div class="row">
            <span class="badge" :class="verifClass(storyboardProfile.verification.status)">{{ verifLabel(storyboardProfile.verification.status) }}</span>
            <label class="row"><input v-model="storyboardProfile.enabled" type="checkbox" /> {{ t('pages.settings.enabled') }}</label>
          </div>
          <p class="muted">{{ t('pages.settings.storyboardHelp') }}</p>
          <label class="field">{{ t('pages.settings.storyboardAppId') }}<input v-model="storyboardProfile.appId" class="mono" /></label>
          <label class="field">{{ t('pages.settings.estimatedCost') }}<input v-model.number="storyboardProfile.estimatedCostCny" type="number" min="0" step="0.01" /></label>
          <div class="grid two">
            <label class="field">{{ t('pages.settings.panelSize', { n: 3 }) }}<input v-model="storyboardProfile.sizeValues[3]" /></label>
            <label class="field">{{ t('pages.settings.panelSize', { n: 6 }) }}<input v-model="storyboardProfile.sizeValues[6]" /></label>
            <label class="field">{{ t('pages.settings.panelSize', { n: 9 }) }}<input v-model="storyboardProfile.sizeValues[9]" /></label>
          </div>
          <div class="muted mono">Prompt {{ storyboardProfile.inputs.prompt.nodeId || '—' }}/{{ storyboardProfile.inputs.prompt.fieldName }} · Size {{ storyboardProfile.inputs.size.nodeId || '—' }}/{{ storyboardProfile.inputs.size.fieldName }} · Layout {{ storyboardProfile.inputs.layoutImage.nodeId || '—' }}/{{ storyboardProfile.inputs.layoutImage.fieldName }}</div>
          <div v-if="storyboardProfile.verification.note" class="muted">{{ localizedProviderNote(storyboardProfile.verification.note) }}</div>
          <div class="row">
            <button class="sm" @click="saveStoryboardProfile">{{ t('common.save') }}</button>
            <button class="primary sm" :disabled="verifyingStoryboard" @click="verifyStoryboardProfile">{{ verifyingStoryboard ? t('pages.settings.detecting') : t('pages.settings.saveAndDetect') }}</button>
          </div>
        </div>
      </div>

      <div id="set-ai" class="panel">
        <div class="panel-title">{{ t('pages.settings.aiOptional') }}</div>
        <div class="panel-body col">
          <div class="agent-card">
            <div class="agent-card-head">
              <strong>{{ t('pages.settings.agentCardTitle') }}</strong>
              <span class="badge accent no-dot">{{ t('pages.settings.agentCardTag') }}</span>
            </div>
            <p class="muted">{{ t('pages.settings.agentCardDesc') }}</p>
            <textarea class="agent-instruction" rows="4" readonly :value="agentInstruction"></textarea>
            <div class="row">
              <button class="primary sm" @click="copyAgentInstruction">{{ agentCopied ? t('pages.settings.agentCardCopied') : t('pages.settings.agentCardCopy') }}</button>
              <a class="sm button-link" href="https://github.com/gordonlu/h3mise/blob/master/AGENTS.md" target="_blank" rel="noopener">{{ t('pages.settings.agentsGuide') }} ↗</a>
            </div>
          </div>
          <span class="badge" :class="health?.aiConfigured ? 'ok' : 'muted'">
            {{ t('pages.settings.builtInAi', { status: health?.aiConfigured ? t('pages.settings.configured') : t('pages.settings.notConfigured') }) }}
          </span>
          <p class="muted">
            {{ t('pages.settings.aiHelp') }}
            <span class="mono">AI_BASE_URL / AI_API_KEY / AI_MODEL</span>
            {{ t('pages.settings.aiCompatibility') }}
          </p>
          <label class="field">
            {{ t('pages.settings.concurrency') }}
            <input type="number" min="1" max="4" :value="comfyProfile?.concurrency ?? 1" @change="saveProviderConcurrency('comfyui', Number(($event.target as HTMLInputElement).value))" />
            <span class="muted">{{ t('pages.settings.aiConcurrencyHelp') }}</span>
          </label>
          <p class="muted">{{ t('pages.settings.externalAiHelp') }}</p>
          <div class="resource-links">
            <span class="muted">{{ t('pages.settings.skillsResources') }}</span>
            <a href="https://www.h3skills.com/" target="_blank" rel="noopener">{{ t('pages.settings.skillsSite') }} ↗</a>
            <a href="https://github.com/gordonlu/awesome-minimax-h3-skills" target="_blank" rel="noopener">{{ t('pages.settings.skillsRepo') }} ↗</a>
            <a href="https://github.com/gordonlu/h3mise/blob/master/AGENTS.md" target="_blank" rel="noopener">{{ t('pages.settings.agentsGuide') }} ↗</a>
          </div>
        </div>
      </div>

      <div id="set-comfyui" class="panel">
        <div class="panel-title">{{ t('pages.settings.comfyProvider') }}</div>
        <div class="panel-body col">
          <div class="row">
            <span class="badge" :class="verifClass(comfyProfile?.verification.status)">{{ verifLabel(comfyProfile?.verification.status) }}</span>
            <span class="mono muted">{{ comfyProfile?.baseUrl }}{{ comfyProfile?.apiPrefix }}</span>
          </div>
          <p class="muted">
            {{ t('pages.settings.comfyHelpBefore') }} <strong>API Format</strong> {{ t('pages.settings.comfyHelpAfter') }}
          </p>
          <div class="row wrap">
            <label class="sm file-button">
              {{ t('pages.settings.importWorkflow') }}
              <input type="file" accept="application/json,.json" hidden @change="importComfyWorkflow" />
            </label>
            <button class="sm" :disabled="verifyingComfy || !comfyProfile || !Object.keys(comfyProfile.workflow).length" @click="verifyComfyProfile">
              {{ verifyingComfy ? t('pages.settings.detecting') : t('pages.settings.verifyComfy') }}
            </button>
            <button class="sm" @click="editingComfyProfile = !editingComfyProfile">{{ t('pages.settings.editProfile') }}</button>
            <a class="sm button-link" href="https://github.com/gordonlu/h3mise/blob/master/ComfyUI.md" target="_blank" rel="noreferrer">{{ t('pages.settings.agentGuide') }}</a>
          </div>
          <div v-if="comfyProfile?.verification.note" class="muted">{{ t('pages.settings.status', { note: localizedProviderNote(comfyProfile.verification.note) }) }}</div>
          <textarea v-if="editingComfyProfile" v-model="comfyProfileJson" rows="14" class="mono" placeholder="ComfyUI Profile JSON"></textarea>
          <button v-if="editingComfyProfile" class="primary sm" @click="saveComfyProfile">{{ t('pages.settings.saveComfyProfile') }}</button>
        </div>
      </div>

      <div id="set-env" class="panel">
        <div class="panel-title">{{ t('pages.settings.environment') }}</div>
        <div class="panel-body col">
          <div class="row">
            <span class="badge" :class="health === null ? 'muted' : health?.ffmpeg.available ? 'ok' : 'bad'">
              <template v-if="health === null">{{ t('pages.settings.ffmpegChecking') }}</template>
              <template v-else>{{ health?.ffmpeg.available ? t('pages.settings.ffmpegAvailable') : t('pages.settings.ffmpegMissing') }}</template>
            </span>
            <span v-if="health" class="muted mono">{{ health?.ffmpeg.ffmpegVersion }}</span>
            <span v-if="healthError" class="badge bad">{{ t('pages.settings.healthError', { msg: healthError }) }}</span>
          </div>
          <p class="muted">{{ t('pages.settings.startupHelp') }}</p>
        </div>
      </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { padding: 28px 36px 56px; max-width: 1240px; margin: 0 auto; }
.settings-layout { display: grid; grid-template-columns: 184px minmax(0, 1fr); gap: 20px; align-items: start; }
.settings-nav { position: sticky; top: 14px; display: flex; flex-direction: column; gap: 3px; }
.settings-nav button {
  padding: 9px 12px; border: none; border-radius: 9px; background: none; box-shadow: none;
  color: var(--text-2); font-size: 13px; text-align: left;
}
.settings-nav button:hover { background: var(--bg-subtle); color: var(--text); }
.panel { scroll-margin-top: 14px; }
.agent-card { display: grid; gap: 9px; padding: 13px 14px; border: 1px solid var(--accent-line); border-radius: var(--radius-sm); background: var(--accent-soft); }
.agent-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.agent-card-head strong { font-size: 13.5px; }
.agent-instruction { width: 100%; font-size: 12px; line-height: 1.6; background: var(--bg-2); }
.resource-links { display: grid; gap: 5px; padding: 11px 13px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg-subtle); }
.resource-links .muted { font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
.resource-links a { font-size: 12.5px; }
h1 { font-size: 28px; line-height: 1.15; margin: 0; font-weight: 700; letter-spacing: -0.03em; margin-bottom: 22px; }
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
.ai-apps { display: flex; flex-direction: column; gap: 10px; }
.ai-app-card { border: 1px solid var(--line-2); border-radius: var(--radius-sm); padding: 10px 12px; background: var(--bg-2); }
.app-mapping { font-size: 11px; margin: 4px 0 8px; }
.readiness { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 8px; }
.readiness .badge { font-size: 10.5px; }
.frame-app { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 10px 12px; background: var(--bg-subtle); }
.frame-app summary { cursor: pointer; font-weight: 600; font-size: 12.5px; margin-bottom: 8px; }
.payload-preview { max-height: 260px; overflow: auto; padding: 10px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--inset); font-size: 11px; white-space: pre-wrap; }
.ai-app-header { justify-content: space-between; margin-bottom: 6px; }
.project-save-row { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding-top: 12px; border-top: 1px solid var(--line); }
.danger { color: var(--err); border-color: var(--err-line); }
.danger:hover { background: var(--err-soft); }
@media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
</style>
