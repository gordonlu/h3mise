<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { get, post, put } from '../api/client';
import { useProjectStore } from '../stores/project';
import { locale, t } from '../stores/locale';
import type { AiAppProfile, ComfyUiWorkflowProfile, DirectorStylePreset, RunningHubRegion, StoryboardProviderProfile } from '@h3mise/shared';

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
const savingRegion = ref(false);
const directorStyles = ref<DirectorStylePreset[]>([]);

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
  if (detected) return t('pages.settings.noteNodesDetected', { n: detected[1] });
  const connected = note.match(/^connected to (.+); workflow has (\d+) nodes — mapping awaits one successful render$/);
  if (connected) return t('pages.settings.noteComfyConnected', { url: connected[1], n: connected[2] });
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
  notice.value = t('pages.settings.projectSaved');
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
</script>

<template>
  <div class="page">
    <h1>{{ t('pages.settings.title') }}</h1>

    <div class="grid">
      <div class="panel">
        <div class="panel-title">{{ t('pages.settings.currentProject') }}</div>
        <div class="panel-body col" v-if="project.current">
          <p class="muted">{{ t('pages.settings.projectHelp') }}</p>
          <label class="field">{{ t('pages.settings.projectTitle') }}<input :value="project.current.config.title" :placeholder="t('pages.settings.projectNamePlaceholder')" @change="saveProjectConfig({ title: ($event.target as HTMLInputElement).value })" /></label>
          <label class="field">
            {{ t('pages.settings.defaultProvider') }}
            <select :value="project.current.config.default_provider" @change="saveProjectConfig({ default_provider: ($event.target as HTMLSelectElement).value })">
              <option v-for="provider in project.providers" :key="provider.id" :value="provider.id">
                {{ provider.name }}{{ provider.configured ? '' : ` (${t('common.unconfigured')})` }}
              </option>
            </select>
            <span class="muted">{{ t('pages.settings.providerStrictHelp') }}</span>
          </label>
          <label class="field">
            {{ t('pages.settings.aspectRatio') }}
            <select :value="project.current.config.default_aspect_ratio" @change="saveProjectConfig({ default_aspect_ratio: ($event.target as HTMLSelectElement).value })">
              <option>16:9</option><option>9:16</option><option>4:3</option><option>1:1</option>
            </select>
            <span class="muted">{{ t('pages.settings.aspectRatioHelp') }}</span>
          </label>
          <label class="field">
            {{ t('pages.settings.defaultDuration') }}
            <input type="number" :value="project.current.config.default_duration_seconds" :title="t('pages.settings.defaultDurationTitle')" placeholder="5" @change="saveProjectConfig({ default_duration_seconds: Number(($event.target as HTMLInputElement).value) })" />
          </label>
          <label class="field">
            {{ t('pages.settings.visualStyle') }}
            <input list="director-style-presets" :value="project.current.config.visual_style ?? ''" :placeholder="t('pages.settings.visualStylePlaceholder')" @change="saveProjectConfig({ visual_style: ($event.target as HTMLInputElement).value })" />
            <datalist id="director-style-presets"><option v-for="style in directorStyles" :key="style.id" :value="style.name" /></datalist>
            <span class="muted">{{ t('pages.settings.visualStyleHelp') }}</span>
          </label>
          <div class="muted mono">{{ project.current.meta.dirPath }}</div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-title">{{ t('pages.settings.runningHubProvider') }}</div>
        <div class="panel-body col">
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
          <p class="muted">
            AI App: <span class="mono">{{ profile?.appId }}</span> — {{ t('pages.settings.aiAppHelp') }}
          </p>
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

      <div class="panel">
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

      <div class="panel">
        <div class="panel-title">{{ t('pages.settings.aiOptional') }}</div>
        <div class="panel-body col">
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
        </div>
      </div>

      <div class="panel">
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

      <div class="panel">
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
