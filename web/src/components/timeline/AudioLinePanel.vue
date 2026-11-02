<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { AudioLine, AudioLineKind, AudioSegment, MediaAsset } from '@h3mise/shared';
import { del, fileUrl, get, mediaUrl, patch, post, put } from '../../api/client';
import { confirmDialog } from '../../stores/confirm';

const props = defineProps<{ shotId: string | null }>();

const lines = ref<AudioLine[]>([]);
const segments = ref<AudioSegment[]>([]);
const audioAssets = ref<MediaAsset[]>([]);
const boundIds = ref<string[]>([]);
const selectedAssetId = ref('');
const newKind = ref<AudioLineKind>('master');
const busy = ref(false);
const notice = ref('');
const waveforms = ref<Record<string, string>>({});
const drafts = ref<Record<string, string>>({});
const players = ref<Record<string, HTMLAudioElement | null>>({});
const stopAt = ref<Record<string, number | null>>({});
const transcribing = ref<string | null>(null);
const masterLineId = ref<string | null>(null);

const availableAssets = computed(() => audioAssets.value.filter((asset) => asset.kind === 'audio'));
const canCreate = computed(() => Boolean(selectedAssetId.value) && !busy.value);
const activeSegments = computed(() => segments.value.filter((segment) => boundIds.value.includes(segment.id)));

async function refresh() {
  busy.value = true;
  try {
    const [data, assets, bound, timeline] = await Promise.all([
      get<{ lines: AudioLine[]; segments: AudioSegment[] }>('/api/audio-lines'),
      get<MediaAsset[]>('/api/assets/media?kind=audio'),
      props.shotId ? get<AudioSegment[]>(`/api/shots/${props.shotId}/audio-segments`) : Promise.resolve([]),
      get<{ masterAudioLineId: string | null }>('/api/timeline'),
    ]);
    lines.value = data.lines;
    segments.value = data.segments;
    audioAssets.value = assets;
    boundIds.value = bound.map((segment) => segment.id);
    masterLineId.value = timeline.masterAudioLineId;
    for (const segment of data.segments) {
      if (drafts.value[segment.id] === undefined) drafts.value[segment.id] = segment.text;
    }
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

async function createLine() {
  if (!selectedAssetId.value) return;
  busy.value = true;
  try {
    await post('/api/audio-lines', { assetId: selectedAssetId.value, kind: newKind.value });
    selectedAssetId.value = '';
    notice.value = 'Audio Line 已创建';
    await refresh();
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

async function removeLine(line: AudioLine) {
  if (!(await confirmDialog({ title: '删除 Audio Line', message: '会同时删除该线及其所有切片；镜头绑定也会解除。', confirmLabel: '删除', danger: true }))) return;
  busy.value = true;
  try {
    await del(`/api/audio-lines/${line.id}`);
    await refresh();
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

async function detect(line: AudioLine) {
  const existing = segments.value.filter((segment) => segment.lineId === line.id);
  if (existing.length && !(await confirmDialog({ title: '重新按静音切句', message: '现有切片的文本会被删除。确定覆盖吗？', confirmLabel: '覆盖', danger: true }))) return;
  busy.value = true;
  try {
    const result = await post<{ created: AudioSegment[]; preserved: boolean }>(`/api/audio-lines/${line.id}/detect-silence`, { replace: existing.length > 0 });
    notice.value = result.preserved ? '已有切片；未覆盖。' : `已按静音切出 ${result.created.length} 段`;
    await refresh();
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

async function loadWaveform(line: AudioLine) {
  try {
    const result = await get<{ relPath: string }>(`/api/audio-lines/${line.id}/waveform`);
    waveforms.value[line.id] = result.relPath;
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  }
}

async function saveText(segment: AudioSegment) {
  const text = (drafts.value[segment.id] ?? '').trim();
  if (text === segment.text) return;
  try {
    await patch(`/api/audio-segments/${segment.id}`, { text });
    segment.text = text;
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  }
}

function setPlayer(lineId: string, element: unknown) {
  players.value[lineId] = (element as HTMLAudioElement | null) ?? null;
}

function lineDuration(line: AudioLine): number {
  const el = players.value[line.id];
  if (el && Number.isFinite(el.duration) && el.duration > 0) return el.duration;
  return segments.value.filter((segment) => segment.lineId === line.id).reduce((end, segment) => Math.max(end, segment.endSeconds), 0);
}

function seekLine(line: AudioLine, event: MouseEvent) {
  const el = players.value[line.id];
  if (!el) return;
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  el.currentTime = ratio * lineDuration(line);
}

function playSegment(line: AudioLine, segment: AudioSegment) {
  const el = players.value[line.id];
  if (!el) return;
  el.currentTime = segment.startSeconds;
  stopAt.value[line.id] = segment.endSeconds;
  void el.play();
}

function onTimeUpdate(line: AudioLine) {
  const el = players.value[line.id];
  const end = stopAt.value[line.id];
  if (el && end != null && el.currentTime >= end) {
    el.pause();
    stopAt.value[line.id] = null;
  }
}

async function saveBoundary(segment: AudioSegment, field: 'startSeconds' | 'endSeconds', value: number) {
  if (!Number.isFinite(value)) return;
  try {
    const updated = await patch<AudioSegment>(`/api/audio-segments/${segment.id}`, { [field]: value });
    Object.assign(segment, updated);
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  }
}

async function transcribe(line: AudioLine) {
  const existing = lineSegments(line.id);
  transcribing.value = line.id;
  try {
    const result = await post<{ provider: string; filled: number; segments: AudioSegment[] }>(`/api/audio-lines/${line.id}/transcribe`, {
      replace: existing.length === 0,
    });
    notice.value = `转写完成（${result.provider}）：${result.filled || result.segments.length} 句`;
    await refresh();
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  } finally {
    transcribing.value = null;
  }
}

async function autoBind(line: AudioLine) {
  if (!(await confirmDialog({ title: '自动绑定 Audio Line', message: '会按镜头时长重排并覆盖当前集所有镜头的 Audio Line 绑定。', confirmLabel: '自动绑定' }))) return;
  busy.value = true;
  try {
    const result = await post<{ bound: number }>(`/api/audio-lines/${line.id}/auto-bind`, {});
    notice.value = `已自动绑定 ${result.bound} 句到镜头`;
    await refresh();
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

async function setMaster(line: AudioLine | null) {
  try {
    const timeline = await put<{ masterAudioLineId: string | null }>('/api/timeline/master-audio', { lineId: line?.id ?? null });
    masterLineId.value = timeline.masterAudioLineId;
    notice.value = line ? `成片将使用 ${line.label} 作为 Master 音频` : '已恢复使用 Take 自带音频';
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  }
}

async function toggleBind(segment: AudioSegment) {
  if (!props.shotId) {
    notice.value = '先在时间线选中一个片段，再绑定 Audio Line。';
    return;
  }
  const next = boundIds.value.includes(segment.id)
    ? boundIds.value.filter((id) => id !== segment.id)
    : [...boundIds.value, segment.id];
  try {
    const bound = await put<AudioSegment[]>(`/api/shots/${props.shotId}/audio-segments`, { segmentIds: next });
    boundIds.value = bound.map((item) => item.id);
  } catch (error) {
    notice.value = error instanceof Error ? error.message : String(error);
  }
}

function lineSegments(lineId: string): AudioSegment[] {
  return segments.value.filter((segment) => segment.lineId === lineId).sort((a, b) => a.startSeconds - b.startSeconds);
}

watch(() => props.shotId, () => { void refresh(); });
onMounted(() => { void refresh(); });
</script>

<template>
  <div class="panel audio-line-panel">
    <div class="panel-title">Audio Line（MV 对齐）</div>
    <div class="panel-body col">
      <p class="muted">项目级 master / vocal 线与逐句切片。切片文本会作为镜头提示词的权威歌词；本地按静音切句，不调用 AI。</p>
      <div class="row wrap">
        <select v-model="selectedAssetId">
          <option value="">选择已导入的音频素材</option>
          <option v-for="asset in availableAssets" :key="asset.id" :value="asset.id">{{ asset.label || asset.fileName }}</option>
        </select>
        <select v-model="newKind">
          <option value="master">Master</option>
          <option value="vocal">Vocal</option>
        </select>
        <button class="sm primary" :disabled="!canCreate" @click="createLine">添加 Audio Line</button>
      </div>
      <div v-if="!availableAssets.length" class="muted">还没有音频素材，请先到 Assets 导入 master 或 vocal。</div>
      <div v-if="notice" class="notice">{{ notice }}</div>

      <div v-for="line in lines" :key="line.id" class="audio-line">
        <div class="audio-line-head">
          <div>
            <strong>{{ line.label }}</strong>
            <span class="badge accent no-dot">{{ line.kind }}</span>
            <span class="muted mono">{{ line.id }}</span>
          </div>
          <div class="row wrap">
            <button class="sm" @click="loadWaveform(line)">波形</button>
            <button class="sm" :disabled="busy" @click="detect(line)">按静音切句</button>
            <button class="sm" :disabled="transcribing === line.id" @click="transcribe(line)">{{ transcribing === line.id ? '转写中…' : '自动转写' }}</button>
            <button class="sm" :disabled="busy" @click="autoBind(line)">自动绑定镜头</button>
            <button class="sm" :class="{ primary: masterLineId === line.id }" @click="setMaster(masterLineId === line.id ? null : line)">{{ masterLineId === line.id ? '取消成片 Master' : '用作成片 Master' }}</button>
            <button class="sm danger" @click="removeLine(line)">删除</button>
          </div>
        </div>
        <audio :ref="(el) => setPlayer(line.id, el)" :src="mediaUrl(line.assetId)" controls preload="metadata" class="audio-player" @timeupdate="onTimeUpdate(line)" />
        <div v-if="waveforms[line.id]" class="waveform" @click="seekLine(line, $event)"><img :src="fileUrl(waveforms[line.id]!)" alt="" /></div>
        <div v-if="!lineSegments(line.id).length" class="muted">还没有切片。点“按静音切句”生成边界，再填写每句实际歌词/台词。</div>
        <div v-for="segment in lineSegments(line.id)" :key="segment.id" class="audio-segment" :class="{ bound: boundIds.includes(segment.id) }">
          <span class="mono time">
            <input type="number" step="0.01" min="0" :value="segment.startSeconds" @change="saveBoundary(segment, 'startSeconds', Number(($event.target as HTMLInputElement).value))" /> –
            <input type="number" step="0.01" min="0" :value="segment.endSeconds" @change="saveBoundary(segment, 'endSeconds', Number(($event.target as HTMLInputElement).value))" />s
          </span>
          <input v-model="drafts[segment.id]" class="text" placeholder="这一句的实际歌词/台词（完整句）" @change="saveText(segment)" />
          <div class="row">
            <button class="sm" @click="playSegment(line, segment)">试听</button>
            <button class="sm" :disabled="!shotId" @click="toggleBind(segment)">{{ boundIds.includes(segment.id) ? '解除绑定' : '绑定到镜头' }}</button>
          </div>
        </div>
      </div>
      <div v-if="activeSegments.length" class="muted">当前镜头已绑定 {{ activeSegments.length }} 句；重新编译 Prompt 后会写入完整文本。</div>
    </div>
  </div>
</template>

<style scoped>
.audio-line-panel { display: grid; gap: 6px; }
.audio-line { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg-subtle); }
.audio-line-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.audio-line-head strong { margin-right: 8px; }
.audio-player { width: 100%; height: 34px; }
.waveform { background: var(--inset); border-radius: 5px; overflow: hidden; }
.waveform img { display: block; width: 100%; max-height: 120px; object-fit: cover; }
.audio-segment { display: grid; grid-template-columns: 132px minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 5px 7px; border-radius: 5px; }
.audio-segment.bound { background: var(--accent-soft); }
.audio-segment .time { color: var(--text-3); font-size: 10.5px; display: flex; align-items: center; gap: 4px; }
.audio-segment .time input { width: 58px; padding: 2px 4px; font-size: 10.5px; }
.waveform { cursor: crosshair; }
.audio-segment .text { min-width: 0; }
.notice { padding: 8px 10px; border-radius: 5px; background: var(--accent-soft); font-size: 12px; }
.danger { color: var(--err); border-color: var(--err-line); }
</style>
