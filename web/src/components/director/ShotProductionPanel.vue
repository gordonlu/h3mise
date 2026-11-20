<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { cctvWallClock, normalizeShotProduction, type MediaAsset, type ProjectAudioSettings, type SegmentKind, type Shot, type ShotProductionConfig } from '@h3mise/shared';
import { get, patch, post } from '../../api/client';
import { t } from '../../stores/locale';

const props = defineProps<{ shot: Shot }>();
const emit = defineEmits<{ updated: [] }>();
const draft = ref<ShotProductionConfig>(normalizeShotProduction(props.shot.production));
const audioAssets = ref<MediaAsset[]>([]);
const projectAudio = ref<ProjectAudioSettings>({ bgmAssetId: null, bgmGainDb: -18, duckingEnabled: true, duckingGainDb: -9 });
const bgmInput = ref<HTMLInputElement | null>(null);
const busy = ref('');
const error = ref('');
const savedMessage = ref('');
const segmentDuration = ref(props.shot.durationSeconds);
const timeJumpSeconds = ref(10);
const frameSkip = ref(3);
const createdSegmentId = ref('');

watch(() => [props.shot.id, props.shot.updatedAt], () => {
  draft.value = normalizeShotProduction(props.shot.production);
  segmentDuration.value = props.shot.durationSeconds;
});

onMounted(async () => {
  try {
    [audioAssets.value, projectAudio.value] = await Promise.all([
      get<MediaAsset[]>('/api/assets/media?kind=audio'),
      get<ProjectAudioSettings>('/api/production/audio'),
    ]);
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
});

const cctvTimes = computed(() =>
  [0, props.shot.durationSeconds / 2, props.shot.durationSeconds].map((offset) =>
    cctvWallClock(draft.value.cctv.startTime, offset + draft.value.segment.timeJumpSeconds)
      .toISOString().replace('T', ' ').slice(0, 19)));

async function saveProduction() {
  busy.value = 'production'; error.value = '';
  savedMessage.value = '';
  try {
    await patch(`/api/shots/${props.shot.id}/production`, draft.value);
    savedMessage.value = t('shot.production.savedProduction');
    emit('updated');
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = ''; }
}

async function saveProjectAudio() {
  busy.value = 'audio'; error.value = '';
  savedMessage.value = '';
  try {
    projectAudio.value = await patch<ProjectAudioSettings>('/api/production/audio', projectAudio.value);
    savedMessage.value = t('shot.production.savedAudio');
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = ''; }
}

async function uploadBgm(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  busy.value = 'audio'; error.value = ''; savedMessage.value = '';
  try {
    const form = new FormData();
    form.append('file', file);
    form.append('label', file.name);
    const asset = await post<MediaAsset>('/api/assets/media/upload', form);
    audioAssets.value = [asset, ...audioAssets.value];
    projectAudio.value = { ...projectAudio.value, bgmAssetId: asset.id };
    savedMessage.value = t('shot.production.bgmUploaded');
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = ''; input.value = ''; }
}

function addCue() {
  const start = draft.value.audio.dialogue.at(-1)?.endSeconds ?? 0;
  draft.value.audio.dialogue.push({ id: `cue-${Date.now()}`, speaker: '', text: '', startSeconds: start, endSeconds: Math.min(props.shot.durationSeconds, start + 1.5) });
}

async function createSegment(kind: Exclude<SegmentKind, 'single'>) {
  busy.value = kind; error.value = '';
  try {
    const result = await post<{ segment: Shot }>(`/api/shots/${props.shot.id}/segments`, {
      kind, durationSeconds: segmentDuration.value, timeJumpSeconds: timeJumpSeconds.value, frameSkip: frameSkip.value,
    });
    createdSegmentId.value = result.segment.id;
    emit('updated');
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = ''; }
}
</script>

<template>
  <details class="panel production-panel" open>
    <summary>{{ t('shot.production.title') }}</summary>
    <div class="panel-body col">
      <div class="production-grid">
        <fieldset><legend>{{ t('shot.production.camera') }}</legend>
          <label>{{ t('shot.production.height') }}<input v-model.number="draft.camera.heightMeters" type="number" min="0" step="0.1" /></label>
          <label>{{ t('shot.production.focal') }}<input v-model.number="draft.camera.focalLengthMm" type="number" min="1" step="1" /></label>
          <label>{{ t('shot.production.tilt') }}<input v-model.number="draft.camera.tiltDegrees" type="number" min="-90" max="90" step="1" /></label>
          <label class="check"><input v-model="draft.camera.locked" type="checkbox" />{{ t('shot.production.locked') }}</label>
        </fieldset>
        <fieldset><legend>{{ t('shot.production.audio') }}</legend>
          <select v-model="draft.audio.mode">
            <option value="none">{{ t('shot.production.audio.none') }}</option>
            <option value="native_dialogue">{{ t('shot.production.audio.native') }}</option>
            <option value="tts_dry">{{ t('shot.production.audio.tts') }}</option>
            <option value="reference_audio">{{ t('shot.production.audio.reference') }}</option>
          </select>
          <p v-if="draft.audio.mode === 'native_dialogue'" class="hint warn-text">{{ t('shot.production.audio.nativeHint') }}</p>
          <p v-if="draft.audio.mode === 'reference_audio'" class="hint">{{ t('shot.production.audio.referenceHint') }}</p>
          <p v-if="draft.audio.mode === 'tts_dry'" class="hint">{{ t('shot.production.audio.ttsHint') }}</p>
        </fieldset>
      </div>

      <div v-if="draft.audio.mode === 'native_dialogue'" class="cue-editor">
        <div v-for="(cue, index) in draft.audio.dialogue" :key="cue.id" class="cue-row">
          <input v-model="cue.speaker" :placeholder="t('shot.production.speaker')" />
          <input v-model="cue.text" :placeholder="t('shot.production.dialogue')" />
          <label>{{ t('shot.production.start') }}<input v-model.number="cue.startSeconds" type="number" min="0" step="0.01" /></label>
          <label>{{ t('shot.production.end') }}<input v-model.number="cue.endSeconds" type="number" min="0" step="0.01" /></label>
          <button class="sm ghost" @click="draft.audio.dialogue.splice(index, 1)">{{ t('common.remove') }}</button>
        </div>
        <button class="sm" @click="addCue">{{ t('shot.production.addCue') }}</button>
      </div>

      <fieldset><legend>{{ t('shot.production.cctv') }}</legend>
        <label class="check"><input v-model="draft.cctv.enabled" type="checkbox" />{{ t('shot.production.cctv.enable') }}</label>
        <div v-if="draft.cctv.enabled" class="cctv-editor">
          <div class="cctv-fields">
            <label>{{ t('shot.production.cctv.label') }}<input v-model="draft.cctv.cameraLabel" /></label>
            <label>{{ t('shot.production.cctv.location') }}<input v-model="draft.cctv.location" :placeholder="t('shot.production.cctv.locationPlaceholder')" /></label>
            <label>{{ t('shot.production.cctv.start') }}<input v-model="draft.cctv.startTime" type="datetime-local" step="1" /></label>
            <label class="check"><input v-model="draft.cctv.showRec" type="checkbox" />REC</label>
            <label class="check"><input v-model="draft.cctv.lowResolution" type="checkbox" />{{ t('shot.production.cctv.low') }}</label>
            <label class="check"><input v-model="draft.cctv.dotMatrix" type="checkbox" />{{ t('shot.production.cctv.dots') }}</label>
            <label class="check"><input v-model="draft.cctv.blurUpscale" type="checkbox" />{{ t('shot.production.cctv.blur') }}</label>
          </div>
          <div class="cctv-preview" :class="{ dots: draft.cctv.dotMatrix, blur: draft.cctv.blurUpscale, low: draft.cctv.lowResolution }">
            <div class="cctv-top"><span>{{ draft.cctv.cameraLabel }} · {{ draft.cctv.location || t('shot.production.cctv.noLocation') }}</span><span v-if="draft.cctv.showRec" class="rec">● REC</span></div>
            <span class="clean-plate">{{ t('shot.production.cctv.clean1') }}<br />{{ t('shot.production.cctv.clean2') }}</span>
            <div class="cctv-time">{{ cctvTimes[0] }} → {{ cctvTimes[2] }}</div>
          </div>
        </div>
      </fieldset>

      <div class="row wrap production-actions">
        <button class="primary sm" :disabled="busy !== ''" @click="saveProduction">{{ t('shot.production.save') }}</button>
        <span class="hint">{{ t('shot.production.saveHint') }}</span>
      </div>

      <details class="segment-tools">
        <summary>{{ t('shot.production.segments') }}</summary>
        <div class="row wrap">
          <label>{{ t('shot.production.segmentDuration') }}<input v-model.number="segmentDuration" type="number" min="1" max="15" step="0.5" /></label>
          <label>{{ t('shot.production.timeJump') }}<input v-model.number="timeJumpSeconds" type="number" min="0" /></label>
          <label>{{ t('shot.production.frameSkip') }}<input v-model.number="frameSkip" type="number" min="1" /></label>
        </div>
        <div class="row wrap">
          <button class="sm" :disabled="busy !== ''" @click="createSegment('continuous')">{{ t('shot.production.createAB') }}</button>
          <button class="sm" :disabled="busy !== ''" @click="createSegment('time_jump')">{{ t('shot.production.createTime') }}</button>
          <button class="sm" :disabled="busy !== ''" @click="createSegment('surveillance_skip')">{{ t('shot.production.createSkip') }}</button>
          <router-link v-if="createdSegmentId" :to="`/shots/${createdSegmentId}`">{{ t('shot.production.openSegment', { id: createdSegmentId }) }}</router-link>
        </div>
        <p class="hint">{{ t('shot.production.segmentHint') }}</p>
      </details>

      <details class="project-audio">
        <summary>{{ t('shot.production.projectAudio') }}</summary>
        <div class="row wrap">
          <input ref="bgmInput" class="file-input" type="file" accept="audio/*" @change="uploadBgm" />
          <button class="sm" :disabled="busy !== ''" @click="bgmInput?.click()">{{ t('shot.production.uploadBgm') }}</button>
          <select v-model="projectAudio.bgmAssetId"><option :value="null">{{ t('shot.production.noBgm') }}</option><option v-for="asset in audioAssets" :key="asset.id" :value="asset.id">{{ asset.label || asset.id }}</option></select>
          <label>{{ t('shot.production.bgmGain') }}<input v-model.number="projectAudio.bgmGainDb" type="number" min="-60" max="12" /></label>
          <label class="check"><input v-model="projectAudio.duckingEnabled" type="checkbox" />{{ t('shot.production.ducking') }}</label>
          <label>{{ t('shot.production.duckGain') }}<input v-model.number="projectAudio.duckingGainDb" type="number" min="-60" max="0" /></label>
          <button class="sm" :disabled="busy !== ''" @click="saveProjectAudio">{{ t('shot.production.saveAudio') }}</button>
        </div>
        <p class="hint">{{ t('shot.production.bgmUploadHint') }}</p>
      </details>
      <div v-if="error" class="error-text">{{ error }}</div>
      <div v-if="savedMessage" class="saved-text">{{ savedMessage }}</div>
    </div>
  </details>
</template>

<style scoped>
.production-panel { border-style: dashed; }
.file-input { display: none; }
summary { cursor: pointer; font-weight: 650; }
.production-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
fieldset { min-width: 0; border: 1px solid var(--line); border-radius: 8px; display: grid; gap: 8px; }
legend { color: var(--text-2); font-size: 12px; font-weight: 650; }
label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-2); }
input, select { min-width: 0; max-width: 100%; }
.check { display: flex; align-items: center; }
.hint { margin: 0; color: var(--text-3); font-size: 11px; line-height: 1.6; }
.warn-text, .error-text { color: var(--warn); }
.saved-text { color: var(--ok); font-size: 12px; }
.cue-editor, .cue-row, .cctv-editor, .cctv-fields { display: grid; gap: 8px; }
.cue-row { grid-template-columns: 1fr 2fr 90px 90px auto; align-items: center; }
.cue-row label input { width: 54px; }
.cctv-editor { grid-template-columns: minmax(220px, 1fr) minmax(260px, 1fr); }
.cctv-fields { align-content: start; }
.cctv-preview { position: relative; min-height: 190px; padding: 12px; overflow: hidden; display: flex; flex-direction: column; justify-content: space-between; color: #d8ffcf; background: #17231e; border: 1px solid #56705f; font: 12px var(--mono); text-shadow: 1px 1px #000; }
.cctv-preview.dots::after { content: ''; position: absolute; inset: 0; pointer-events: none; background: radial-gradient(#b7d9b455 1px, transparent 1px); background-size: 4px 4px; }
.cctv-preview.blur .clean-plate { filter: blur(1.2px); transform: scale(1.04); }
.cctv-preview.low { image-rendering: pixelated; }
.cctv-top, .cctv-time { display: flex; justify-content: space-between; gap: 8px; z-index: 1; }
.rec { color: #ff6b61; }
.clean-plate { text-align: center; color: #b9c9bd; }
.segment-tools, .project-audio { border-top: 1px solid var(--line); padding-top: 10px; }
.segment-tools > *, .project-audio > * { margin-top: 10px; }
@media (max-width: 760px) { .production-grid, .cctv-editor { grid-template-columns: 1fr; } .cue-row { grid-template-columns: 1fr 1fr; } }
</style>
