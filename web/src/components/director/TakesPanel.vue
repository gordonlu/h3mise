<script setup lang="ts">
import { ref, computed } from 'vue';
import type { Take, VisualContinuityState } from '@h3mise/shared';
import { FAILURE_TAGS } from '@h3mise/shared';
import { takeVideoUrl } from '../../api/client';
import VideoPlayer from '../VideoPlayer.vue';

const props = defineProps<{
  takes: Take[];
  selectedTakeId: string | null;
  aiEnabled: boolean;
  /** Latest committed actual visual continuity (prefill for select+commit). */
  actualState: VisualContinuityState | null;
  onSelect: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
  onUpdate: (id: string, patch: Partial<Take>) => Promise<void>;
  onAiDiagnose: (takeId: string) => Promise<void>;
  onSelectCommit: (takeId: string, state: VisualContinuityState) => Promise<void>;
  onUseLastFrame: (takeId: string) => Promise<void>;
  onUseFirstFrame: (takeId: string) => Promise<void>;
}>();

const compare = ref<string | null>(null);
const active = ref<string | null>(null);
const tagEdit = ref<string | null>(null);

const activeTake = computed(() => props.takes.find((t) => t.id === active.value) ?? null);
const compareTake = computed(() => props.takes.find((t) => t.id === compare.value) ?? null);

function toggleTag(take: Take, tag: string) {
  const next = take.failureTags.includes(tag as never) ? take.failureTags.filter((t) => t !== tag) : [...take.failureTags, tag as never];
  void props.onUpdate(take.id, { failureTags: next });
}

const emptyState = (): VisualContinuityState => ({
  characterStates: {}, costume: {}, hair: {}, injury: {}, heldItems: {}, location: '', timeOfDay: '',
  weather: '', wind: '', screenDirection: '', facing: '', vehicleState: {}, notes: '',
});

const commitTarget = ref<string | null>(null);
const commitBusy = ref(false);
const commitForm = ref<VisualContinuityState>(emptyState());

function openCommit(takeId: string) {
  commitTarget.value = takeId;
  // Prefill from the previous shot's committed actual continuity (Frame Bridge).
  commitForm.value = structuredClone(props.actualState ?? emptyState());
}

async function doSelectCommit() {
  if (!commitTarget.value) return;
  commitBusy.value = true;
  try {
    await props.onSelectCommit(commitTarget.value, structuredClone(commitForm.value));
    commitTarget.value = null;
  } finally {
    commitBusy.value = false;
  }
}
</script>

<template>
  <div class="col">
    <div v-if="activeTake && compareTake && activeTake.id !== compareTake.id" class="panel compare-row">
      <div class="panel-title">A/B Compare</div>
      <div class="compare-grid">
        <div>
          <VideoPlayer :src="takeVideoUrl(activeTake.id)" :poster="activeTake.posterPath ? `/api/file/${encodeURIComponent(activeTake.posterPath)}` : undefined" :label="activeTake.id" />
          <div class="muted center">A · {{ activeTake.id }}</div>
        </div>
        <div>
          <VideoPlayer :src="takeVideoUrl(compareTake.id)" :poster="compareTake.posterPath ? `/api/file/${encodeURIComponent(compareTake.posterPath)}` : undefined" :label="compareTake.id" />
          <div class="muted center">B · {{ compareTake.id }}</div>
        </div>
      </div>
    </div>

    <div v-else-if="activeTake" class="panel">
      <div class="panel-title spread">
        <span>播放 Take {{ activeTake.id }}</span>
        <button class="sm ghost" @click="active = null">关闭</button>
      </div>
      <VideoPlayer :src="takeVideoUrl(activeTake.id)" :poster="activeTake.posterPath ? `/api/file/${encodeURIComponent(activeTake.posterPath)}` : undefined" />
    </div>

    <div v-if="!takes.length" class="muted">还没有 Take。渲染完成后会出现在这里。</div>

    <!-- Select + Commit continuity form -->
    <div v-if="commitTarget" class="panel commit-panel">
      <div class="panel-title">Select {{ commitTarget }} 并提交 Actual Visual Continuity</div>
      <div class="panel-body">
        <div class="grid commit-grid">
          <label class="field">地点<input v-model="commitForm.location" /></label>
          <label class="field">时间<input v-model="commitForm.timeOfDay" /></label>
          <label class="field">天气<input v-model="commitForm.weather" /></label>
          <label class="field">风<input v-model="commitForm.wind" /></label>
          <label class="field">银幕方向<input v-model="commitForm.screenDirection" placeholder="left-to-right" /></label>
          <label class="field">朝向<input v-model="commitForm.facing" /></label>
          <label class="field" style="grid-column: 1 / -1">备注<textarea v-model="commitForm.notes" rows="2"></textarea></label>
        </div>
        <div class="row">
          <button class="primary sm" :disabled="commitBusy" @click="doSelectCommit">{{ commitBusy ? '提交中…' : 'Select + Commit（选片即提交连续性）' }}</button>
          <button class="sm" @click="commitTarget = null">取消</button>
        </div>
        <p class="muted">只有 Selected Take 才能提交 Actual Continuity（PRD §31）；NarrativeState 不受影响。</p>
      </div>
    </div>

    <div class="takes grid">
      <div v-for="t in takes" :key="t.id" class="panel take" :class="{ selected: t.status === 'selected', rejected: t.status === 'rejected' }">
        <div class="take-cover" @click="active = active === t.id ? null : t.id">
          <img v-if="t.posterPath" :src="`/api/file/${encodeURIComponent(t.posterPath)}`" :alt="t.id" />
          <span v-else class="muted mono">no poster</span>
          <span class="badge status-badge" :class="{ ok: t.status === 'selected', bad: t.status === 'rejected' }">
            {{ t.status === 'selected' ? 'SELECTED' : t.status === 'rejected' ? 'REJECTED' : 'CANDIDATE' }}
          </span>
        </div>
        <div class="take-body col">
          <div class="spread">
            <span class="mono">{{ t.id }}</span>
            <span class="muted">{{ t.duration.toFixed(1) }}s</span>
          </div>
          <div class="row">
            <button
              class="sm"
              :disabled="t.status === 'selected'"
              @click="onSelect(t.id)"
            >Select</button>
            <button class="sm primary" :disabled="t.status === 'selected'" @click="openCommit(t.id)">Select + Commit</button>
            <button class="sm" @click="compare = compare === t.id ? null : t.id">
              {{ compare === t.id ? '退出对比' : 'Compare' }}
            </button>
            <button v-if="t.status !== 'rejected'" class="sm" @click="onReject(t.id)">Reject</button>
            <button v-if="aiEnabled" class="sm ghost" @click="onAiDiagnose(t.id)">Analyze Failure</button>
          </div>
          <div class="row">
            <button class="sm ghost" title="把本 Take 的最后一帧作为下一镜头的首帧（Frame Bridge）" @click="onUseLastFrame(t.id)">↗ 尾帧作首帧</button>
            <button class="sm ghost" title="把本 Take 的首帧作为首帧参考" @click="onUseFirstFrame(t.id)">↗ 首帧作参考</button>
          </div>
          <div class="row">
            <label class="muted">评分</label>
            <select class="rating" :value="t.rating ?? ''" @change="onUpdate(t.id, { rating: Number(($event.target as HTMLSelectElement).value) || null })">
              <option value="">—</option>
              <option v-for="i in 5" :key="i" :value="i">{{ i }}</option>
            </select>
          </div>
          <div class="tags">
            <span
              v-for="tag in FAILURE_TAGS"
              :key="tag"
              class="tag"
              :class="{ active: t.failureTags.includes(tag) }"
              @click="toggleTag(t, tag)"
            >{{ tag }}</span>
          </div>
          <textarea
            v-if="tagEdit === t.id"
            :value="t.notes"
            rows="2"
            placeholder="笔记 / 失败原因…"
            @blur="tagEdit = null"
            @input="onUpdate(t.id, { notes: ($event.target as HTMLTextAreaElement).value })"
          />
          <button v-else class="sm ghost" @click="tagEdit = t.id">{{ t.notes || '＋ 笔记' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.takes { grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); }
.take { overflow: hidden; }
.take.selected { border-color: var(--ok); }
.take.rejected { opacity: 0.55; }
.take-cover { position: relative; height: 110px; background: var(--bg-3); display: flex; align-items: center; justify-content: center; cursor: pointer; }
.take-cover img { width: 100%; height: 100%; object-fit: cover; }
.status-badge { position: absolute; top: 6px; left: 6px; background: rgba(0,0,0,0.6); }
.take-body { padding: 8px 10px; }
.rating { width: 56px; }
.tags { display: flex; flex-wrap: wrap; }
.compare-row { padding-bottom: 12px; }
.compare-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 12px; }
.commit-panel { margin-bottom: 10px; }
.commit-grid { grid-template-columns: 1fr 1fr 1fr; }
.center { text-align: center; margin-top: 4px; }
</style>
