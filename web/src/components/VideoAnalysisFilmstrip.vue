<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { VideoAnalysis } from '@h3mise/shared';
import { fileUrl, post } from '../api/client';
import { t } from '../stores/locale';

const props = defineProps<{ takeId: string }>();
const analysis = ref<VideoAnalysis | null>(null);
const loading = ref(false);
const error = ref('');

const cuts = computed(() => analysis.value?.sceneCuts.filter((time) => time > 0.02) ?? []);

watch(() => props.takeId, () => {
  analysis.value = null;
  error.value = '';
});

async function analyze(force = false) {
  loading.value = true;
  error.value = '';
  try {
    analysis.value = await post<VideoAnalysis>(`/api/takes/${props.takeId}/analyze`, { force });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}

function position(time: number): string {
  const duration = analysis.value?.durationSeconds ?? 1;
  return `${Math.max(0, Math.min(100, time / duration * 100))}%`;
}
</script>

<template>
  <section class="analysis-strip">
    <div class="strip-head">
      <div>
        <strong>{{ t('shot.filmstrip.title') }}</strong>
        <span>{{ t('shot.filmstrip.hint') }}</span>
      </div>
      <button v-if="!analysis" class="sm" :disabled="loading" @click="analyze(false)">{{ loading ? t('shot.filmstrip.analyzing') : t('shot.filmstrip.analyze') }}</button>
      <button v-else class="sm ghost" :disabled="loading" :title="t('shot.filmstrip.forceHint')" @click="analyze(true)">{{ loading ? t('shot.filmstrip.reanalyze') : t('shot.filmstrip.reanalyzeIdle') }}</button>
    </div>
    <p v-if="error" class="analysis-error">{{ t('shot.filmstrip.error', { msg: error }) }}</p>
    <template v-if="analysis">
      <div class="risk" :class="analysis.suitability.level">
        <b>{{ analysis.suitability.level === 'good' ? t('shot.filmstrip.riskGood') : analysis.suitability.level === 'warning' ? t('shot.filmstrip.riskWarning') : t('shot.filmstrip.riskPoor') }}</b>
        <span>{{ analysis.suitability.reasons.join('；') }}</span>
      </div>
      <div class="frames-wrap">
        <div class="frames">
          <figure v-for="frame in analysis.frames" :key="frame.relPath">
            <img :src="fileUrl(frame.relPath)" :alt="t('shot.filmstrip.frameAlt', { t: frame.timeSeconds.toFixed(1) })" />
            <figcaption>{{ frame.timeSeconds.toFixed(1) }}s</figcaption>
          </figure>
        </div>
        <i v-for="cut in cuts" :key="cut" class="cut" :style="{ left: position(cut) }" :title="t('shot.filmstrip.cutTitle', { t: cut.toFixed(2) })"><span>{{ cut.toFixed(1) }}s cut</span></i>
      </div>
      <div class="strip-meta">
        <span>{{ analysis.width ?? '—' }} × {{ analysis.height ?? '—' }}</span>
        <span>{{ analysis.durationSeconds.toFixed(1) }}s</span>
        <span>{{ t('shot.filmstrip.framesPreview', { n: analysis.frames.length }) }}</span>
        <span :class="cuts.length ? 'cut-count warn' : 'cut-count'">{{ t('shot.filmstrip.cutsCount', { n: cuts.length }) }}</span>
      </div>
    </template>
  </section>
</template>

<style scoped>
.analysis-strip { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); display: grid; gap: 10px; }
.strip-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.strip-head > div { display: grid; gap: 2px; }.strip-head strong { font-size: 12.5px; }.strip-head span { color: var(--text-3); font-size: 11px; }
.analysis-error { margin: 0; color: var(--bad); font-size: 11px; }
.risk { display: flex; align-items: baseline; gap: 8px; padding: 7px 9px; border-radius: var(--radius-sm); background: var(--ok-soft); color: var(--ok); font-size: 11px; }
.risk.warning { background: var(--warn-soft); color: var(--warn); }.risk.poor { background: var(--bad-soft); color: var(--bad); }.risk span { color: var(--text-2); }
.frames-wrap { position: relative; padding-top: 18px; overflow-x: auto; }
.frames { min-width: 720px; display: flex; gap: 3px; padding: 3px; border-radius: var(--radius-sm); background: var(--inset); }
figure { flex: 1 0 76px; min-width: 0; margin: 0; position: relative; overflow: hidden; border-radius: 3px; background: var(--bg-muted); aspect-ratio: 16 / 10; }
img { width: 100%; height: 100%; display: block; object-fit: cover; }
figcaption { position: absolute; right: 3px; bottom: 2px; padding: 0 3px; border-radius: 2px; color: white; background: rgba(0,0,0,.58); font: 9px var(--mono); }
.cut { position: absolute; top: 13px; bottom: 0; width: 2px; z-index: 2; background: var(--bad); pointer-events: none; box-shadow: 0 0 0 1px rgba(255,255,255,.65); }
.cut span { position: absolute; top: -13px; left: 4px; white-space: nowrap; color: var(--bad); font: 700 9px var(--mono); }
.strip-meta { display: flex; gap: 12px; color: var(--text-3); font-size: 10.5px; }.cut-count.warn { color: var(--warn); font-weight: 600; }
</style>
