<script setup lang="ts">
import { computed } from 'vue';
import type { TemporalBeat } from '@h3mise/shared';
import { t as tr } from '../../stores/locale';

const props = defineProps<{ beats: TemporalBeat[] }>();

const NEW_ID = () => `beat-${Date.now()}-${Math.round(Math.random() * 1e5)}`;

/** Recompute sequential windows from per-beat weights (kept proportional). */
function renormalize(): void {
  const total = props.beats.reduce((sum, b) => sum + weightOf(b), 0) || 1;
  let cursor = 0;
  props.beats.forEach((b) => {
    const width = weightOf(b) / total;
    b.start = cursor;
    b.end = Math.min(1, cursor + width);
    cursor = b.end;
  });
}

function weightOf(b: TemporalBeat): number {
  return Math.max(0.01, Math.min(1, Number(b.end) - Number(b.start) || 0.01));
}

function addBeat(preset: string): void {
  props.beats.push({ id: NEW_ID(), label: preset, start: 0, end: 1 });
  renormalize();
}

function removeBeat(index: number): void {
  props.beats.splice(index, 1);
  if (props.beats.length) renormalize();
}

function setWeight(b: TemporalBeat, percent: number): void {
  const w = Math.min(400, Math.max(1, percent));
  b.end = b.start + w / 100;
  renormalize();
}

const totalPercent = computed(() => {
  const last = props.beats[props.beats.length - 1];
  return Math.round(((last?.end ?? 0) / 1) * 100);
});

function widthOf(b: TemporalBeat): number {
  return Math.max(2, (b.end - b.start) * 100);
}
</script>

<template>
  <div class="beats-editor">
    <div class="spread beats-head">
      <span class="beats-title">{{ tr('shot.temporalBeats.title') }}</span>
      <div class="row">
        <button v-for="p in ['Approach', 'Action', 'Recovery']" :key="p" class="sm ghost" @click="addBeat(p)">＋ {{ p }}</button>
        <button class="sm" @click="addBeat('Beat')">＋</button>
      </div>
    </div>
    <p class="muted beats-hint">{{ tr('shot.temporalBeats.hint') }}</p>
    <div v-if="!beats.length" class="muted">{{ tr('shot.temporalBeats.empty') }}</div>
    <template v-else>
      <div class="beats-strip">
        <div v-for="b in beats" :key="b.id" class="beat-seg" :style="{ width: widthOf(b) + '%' }">
          <span>{{ b.label }}</span>
        </div>
      </div>
      <div class="beats-rows">
        <div v-for="(b, i) in beats" :key="b.id" class="beat-row">
          <input v-model="b.label" class="beat-name" :placeholder="tr('shot.temporalBeats.label')" />
          <span class="muted">≈</span>
          <input
            :value="Math.round(weightOf(b) * 100)"
            type="number" min="1" max="400" step="5"
            class="mono beat-num"
            @change="setWeight(b, Number(($event.target as HTMLInputElement).value))"
          />
          <span class="muted">%</span>
          <button class="sm ghost" :title="tr('shot.temporalBeats.remove')" @click="removeBeat(i)">✕</button>
        </div>
      </div>
      <div class="muted beats-total">{{ tr('shot.temporalBeats.sum', { v0: totalPercent }) }}</div>
    </template>
  </div>
</template>

<style scoped>
.beats-editor { border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg-subtle); padding: 10px 12px; display: grid; gap: 6px; }
.beats-head { align-items: center; }
.beats-title { font-size: 12.5px; font-weight: 700; }
.beats-hint { margin: 0; font-size: 11.5px; line-height: 1.5; }
.beats-strip { display: flex; gap: 2px; background: var(--inset); border-radius: 6px; padding: 4px; height: 26px; }
.beat-seg { display: flex; align-items: center; justify-content: center; overflow: hidden; background: var(--accent-soft); border: 1px solid var(--accent-line); color: var(--accent-text); font-size: 10.5px; font-weight: 700; border-radius: 4px; white-space: nowrap; }
.beats-rows { display: grid; gap: 4px; }
.beat-row { display: grid; grid-template-columns: minmax(0, 1fr) auto 64px auto 24px; gap: 6px; align-items: center; }
.beat-name { min-width: 0; }
.beat-num { width: 100%; }
.beats-total { font-size: 11px; }
</style>
