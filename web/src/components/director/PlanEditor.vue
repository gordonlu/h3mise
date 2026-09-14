<script setup lang="ts">
import { ref, watch, computed, toRaw } from 'vue';
import { emptyDirectorPlan } from '@h3mise/shared';
import type { DirectorPlan } from '@h3mise/shared';
import { t } from '../../stores/locale';
import TemporalBeatsEditor from './TemporalBeatsEditor.vue';

const props = defineProps<{
  plan: DirectorPlan;
  aiEnabled: boolean;
  onAiSuggest: (plan: DirectorPlan) => void;
  /** Living brief: parse free text into a DirectorPlan (AI or delegated agent). */
  onParseBrief?: (brief: string) => Promise<DirectorPlan | null>;
  aiBusy?: boolean;
}>();
const emit = defineEmits<{ save: [plan: DirectorPlan]; paste: []; dirtyChange: [dirty: boolean] }>();

const draft = ref<DirectorPlan>(emptyDirectorPlan());
const savedSnapshot = ref('');
const briefText = ref('');
const briefBusy = ref(false);

/** Compose a readable director's brief from the structured plan. Pure view:
 * connectors are punctuation and the two labeled lines are localized. */
function composeBrief(p: DirectorPlan): string {
  const sentences: string[] = [];
  const sizes = p.camera.shotSizeStart && p.camera.shotSizeEnd && p.camera.shotSizeStart !== p.camera.shotSizeEnd
    ? `${p.camera.shotSizeStart} → ${p.camera.shotSizeEnd}`
    : p.camera.shotSizeStart || p.camera.shotSizeEnd;
  const camera = [sizes, p.camera.geometry, p.camera.dominantBehavior].filter(Boolean).join('，');
  if (camera) sentences.push(camera);
  const subject = [p.subject.primarySubject, p.subject.action].filter(Boolean).join('，');
  if (subject) sentences.push(subject);
  if (p.intent.visualThesis) sentences.push(p.intent.visualThesis);
  const position = [p.blocking.startPosition, p.blocking.endPosition].filter(Boolean).join(' → ');
  const blocking = [position, p.blocking.facing].filter(Boolean).join('，');
  if (blocking) sentences.push(blocking);
  const performance = [p.performance.objective, p.performance.primaryAction].filter(Boolean).join('；');
  if (performance) sentences.push(performance);
  const environment = [p.environment.location, p.environment.weather, p.environment.lighting].filter(Boolean).join('，');
  if (environment) sentences.push(environment);
  if (p.intent.endState) sentences.push(t('shot.plan.briefEnding', { value: p.intent.endState }));
  if (p.generation.audioIntent) sentences.push(t('shot.plan.briefAudio', { value: p.generation.audioIntent }));
  return sentences.length ? `${sentences.join('。')}。` : '';
}

async function parseBrief(): Promise<void> {
  if (!props.onParseBrief || briefBusy.value) return;
  const text = briefText.value.trim();
  if (!text) return;
  briefBusy.value = true;
  try {
    const parsed = await props.onParseBrief(text);
    if (!parsed) return;
    const cloned = structuredClone(toRaw(parsed));
    if (!Array.isArray(cloned.temporalBeats)) cloned.temporalBeats = [];
    draft.value = cloned;
    briefText.value = composeBrief(cloned);
  } finally {
    briefBusy.value = false;
  }
}

watch(
  () => props.plan,
  (p) => {
    const cloned = structuredClone(toRaw(p));
    // Older plans (pre temporal-beats) come back with the field missing.
    if (!Array.isArray(cloned.temporalBeats)) cloned.temporalBeats = [];
    draft.value = cloned;
    savedSnapshot.value = JSON.stringify(cloned);
    briefText.value = composeBrief(cloned);
  },
  { immediate: true, deep: true },
);

const isDirty = computed(() => JSON.stringify(draft.value) !== savedSnapshot.value);
const hasSavedVersion = computed(() => draft.value.version > 0);
watch(isDirty, (d) => emit('dirtyChange', d), { immediate: true });

interface FieldDef {
  path: readonly string[];
  type: string;
  options?: readonly string[];
}

interface SectionDef {
  key: string;
  fields: FieldDef[];
}

type EssentialFieldDef = FieldDef;

const essentialFields: EssentialFieldDef[] = [
  {
    path: ['intent', 'visualThesis'],
    type: 'textarea',
  },
  {
    path: ['subject', 'action'],
    type: 'textarea',
  },
  {
    path: ['camera', 'dominantBehavior'],
    type: 'textarea',
  },
  {
    path: ['intent', 'endState'],
    type: 'textarea',
  },
];

const essentialPathKeys = new Set(essentialFields.map((field) => field.path.join('.')));

const sections: SectionDef[] = [
  {
    key: 'intent', fields: [
      { path: ['intent', 'visualThesis'], type: 'textarea' },
      { path: ['intent', 'dramaticGoal'], type: 'textarea' },
      { path: ['intent', 'peak'], type: 'textarea' },
      { path: ['intent', 'endState'], type: 'textarea' },
    ],
  },
  {
    key: 'subject', fields: [
      { path: ['subject', 'primarySubject'], type: 'text' },
      { path: ['subject', 'action'], type: 'textarea' },
      { path: ['subject', 'primaryMotionOwner'], type: 'text' },
    ],
  },
  {
    key: 'blocking', fields: [
      { path: ['blocking', 'startPosition'], type: 'text' },
      { path: ['blocking', 'endPosition'], type: 'text' },
      { path: ['blocking', 'facing'], type: 'text' },
      { path: ['blocking', 'movementAxis'], type: 'text' },
      { path: ['blocking', 'travelPath'], type: 'text' },
      { path: ['blocking', 'spatialRelationships'], type: 'text' },
    ],
  },
  {
    key: 'camera', fields: [
      { path: ['camera', 'shotSizeStart'], type: 'text' },
      { path: ['camera', 'shotSizePeak'], type: 'text' },
      { path: ['camera', 'shotSizeEnd'], type: 'text' },
      { path: ['camera', 'geometry'], type: 'text' },
      { path: ['camera', 'lensIntent'], type: 'text' },
      { path: ['camera', 'dominantBehavior'], type: 'text' },
      { path: ['camera', 'trigger'], type: 'text' },
      { path: ['camera', 'speedRelation'], type: 'text' },
      { path: ['camera', 'stopCondition'], type: 'text' },
    ],
  },
  {
    key: 'performance', fields: [
      { path: ['performance', 'objective'], type: 'text' },
      { path: ['performance', 'obstacle'], type: 'text' },
      { path: ['performance', 'tactic'], type: 'text' },
      { path: ['performance', 'performanceTurn'], type: 'text' },
      { path: ['performance', 'movementQuality', 'weight'], type: 'text' },
      { path: ['performance', 'movementQuality', 'time'], type: 'text' },
      { path: ['performance', 'movementQuality', 'space'], type: 'text' },
      { path: ['performance', 'movementQuality', 'flow'], type: 'text' },
      { path: ['performance', 'anticipation'], type: 'text' },
      { path: ['performance', 'primaryAction'], type: 'text' },
      { path: ['performance', 'followThrough'], type: 'text' },
      { path: ['performance', 'recovery'], type: 'text' },
      { path: ['performance', 'gaze'], type: 'text' },
      { path: ['performance', 'endPose'], type: 'text' },
    ],
  },
  {
    key: 'environment', fields: [
      { path: ['environment', 'location'], type: 'text' },
      { path: ['environment', 'weather'], type: 'text' },
      { path: ['environment', 'medium'], type: 'text' },
      { path: ['environment', 'wind'], type: 'text' },
      { path: ['environment', 'lighting'], type: 'text' },
      { path: ['environment', 'foreground'], type: 'text' },
      { path: ['environment', 'midground'], type: 'text' },
      { path: ['environment', 'background'], type: 'text' },
    ],
  },
  {
    key: 'reality', fields: [
      { path: ['reality', 'mode'], type: 'select', options: ['strict_realism', 'plausible_stylized', 'deliberate_fantasy'] },
      { path: ['reality', 'constraints'], type: 'list' },
    ],
  },
  {
    key: 'continuity', fields: [
      { path: ['continuity', 'plannedStartState'], type: 'textarea' },
      { path: ['continuity', 'plannedEndState'], type: 'textarea' },
    ],
  },
  {
    key: 'generation', fields: [
      { path: ['generation', 'audioIntent'], type: 'textarea' },
    ],
  },
];

const advancedSections = sections
  .map((section) => ({ ...section, fields: section.fields.filter((field) => !essentialPathKeys.has(field.path.join('.'))) }))
  .filter((section) => section.fields.length > 0);

function pathKey(path: readonly string[]): string {
  return path.join('.');
}

function fieldLabel(field: FieldDef): string {
  return t(`shot.plan.field.${pathKey(field.path)}`);
}

function fieldPlaceholder(field: FieldDef): string {
  return t(`shot.plan.placeholder.${pathKey(field.path)}`);
}

function essentialText(field: EssentialFieldDef, part: 'question' | 'help' | 'placeholder'): string {
  return t(`shot.plan.essential.${pathKey(field.path)}.${part}`);
}

const requiredFilledCount = computed(() => essentialFields.filter((field) => {
  const value = fieldValue(field.path);
  return String(value ?? '').trim() !== '';
}).length);
const isRequiredComplete = computed(() => requiredFilledCount.value === essentialFields.length);
const advancedVisible = ref(false);

// Professional sections remember their state, but stay behind one explicit
// advanced-settings disclosure for the default guided experience.
const STORAGE_KEY = 'h3mise-plan-sections';
const open = ref<Set<string>>(new Set());
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as string[];
  if (Array.isArray(saved) && saved.length) open.value = new Set(saved);
} catch { /* ignore */ }

function toggleSection(key: string) {
  const next = new Set(open.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  open.value = next;
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
}

/** Sections that have any content — hint badge on collapsed headers. */
function filledCount(sec: SectionDef): number {
  let n = 0;
  for (const f of sec.fields) {
    const v = fieldValue(f.path);
    if (Array.isArray(v) ? v.length : String(v ?? '').trim() !== '') n++;
  }
  return n;
}

function fieldValue(path: readonly string[]): string | number | string[] {
  let v: unknown = draft.value;
  for (const k of path) v = (v as Record<string, unknown>)?.[k];
  return (v as string | number | string[]) ?? '';
}

function setField(path: readonly string[], value: string | number | string[]) {
  let v: Record<string, unknown> = draft.value as never;
  for (const k of path.slice(0, -1)) v = (v[k] ??= {}) as Record<string, unknown>;
  v[path.at(-1)!] = value;
}

function save() {
  if (!isRequiredComplete.value) return;
  emit('save', structuredClone(toRaw(draft.value)));
}

function requestAiSuggestion() {
  props.onAiSuggest(structuredClone(toRaw(draft.value)));
}
</script>

<template>
  <div class="plan-editor col">
    <div class="spread editor-bar">
      <div>
        <div class="row">
          <strong>{{ t('shot.plan.shotDesign') }}</strong>
          <span class="required-progress" :class="{ complete: isRequiredComplete }">{{ t('shot.plan.requiredProgress', { filled: requiredFilledCount, total: essentialFields.length }) }}</span>
        </div>
        <div class="save-state row">
          <span class="muted mono">DirectorPlan v{{ draft.version }}</span>
          <span v-if="isDirty" class="badge warn" :title="t('shot.plan.unsavedChangesTitle')">● {{ t('shot.plan.unsavedChanges') }}</span>
          <span v-else-if="hasSavedVersion" class="badge ok">{{ t('shot.plan.saved') }}</span>
          <span v-else class="badge warn">{{ t('shot.plan.notCreated') }}</span>
        </div>
      </div>
      <div class="row editor-actions">
        <button
          class="sm ai-fill"
          :disabled="!aiEnabled || aiBusy"
          :title="aiEnabled ? t('shot.plan.aiImproveTitle') : t('shot.plan.configureAiTitle')"
          @click="requestAiSuggestion"
        >{{ aiBusy ? t('shot.plan.aiImproving') : aiEnabled ? t('shot.plan.aiImprove') : t('shot.plan.aiNotConfigured') }}</button>
        <button class="primary sm" :class="{ pulse: isDirty && isRequiredComplete }" :disabled="!isDirty || !isRequiredComplete" @click="save">{{ t('shot.plan.saveShotDesign') }}</button>
      </div>
    </div>

    <section class="panel brief-card">
      <div class="brief-head">
        <strong>{{ t('shot.plan.briefTitle') }}</strong>
        <span class="muted">{{ t('shot.plan.briefHint') }}</span>
      </div>
      <textarea v-model="briefText" class="brief-text" rows="4" :placeholder="t('shot.plan.briefPlaceholder')" />
      <div class="row brief-actions">
        <button
          class="sm"
          :disabled="!props.onParseBrief || !aiEnabled || aiBusy || briefBusy || !briefText.trim()"
          :title="aiEnabled ? t('shot.plan.briefHint') : t('shot.plan.configureAiTitle')"
          @click="parseBrief"
        >{{ briefBusy ? t('shot.plan.briefParsing') : aiEnabled ? t('shot.plan.briefParse') : t('shot.plan.aiNotConfigured') }}</button>
        <button class="sm ghost" @click="briefText = composeBrief(draft)">{{ t('shot.plan.briefRecompose') }}</button>
      </div>
    </section>

    <section class="panel essential-card">
      <div class="essential-intro">
        <strong>{{ t('shot.plan.completeFourItems') }}</strong>
        <span>{{ t('shot.plan.plainLanguageHint') }}</span>
      </div>
      <div class="essential-fields">
        <label v-for="(f, index) in essentialFields" :key="f.path.join('.')" class="essential-field">
          <span class="essential-number" :class="{ done: String(fieldValue(f.path) ?? '').trim() }">{{ String(fieldValue(f.path) ?? '').trim() ? '✓' : index + 1 }}</span>
          <span class="essential-copy">
            <span class="essential-question">{{ essentialText(f, 'question') }} <span class="required-mark">{{ t('shot.plan.required') }}</span></span>
            <span class="essential-help">{{ essentialText(f, 'help') }}</span>
          </span>
          <textarea :value="fieldValue(f.path)" rows="2" :placeholder="essentialText(f, 'placeholder')" @input="setField(f.path, ($event.target as HTMLTextAreaElement).value)" />
        </label>
      </div>
      <div v-if="!isRequiredComplete" class="required-hint">{{ t('shot.plan.itemsRemaining', { n: essentialFields.length - requiredFilledCount }) }}</div>
      <div v-else class="required-hint complete">{{ t('shot.plan.designComplete') }}</div>
    </section>

    <section class="beats-wrap">
      <TemporalBeatsEditor :beats="draft.temporalBeats" />
    </section>

    <section class="advanced-wrap">
      <div class="advanced-head">
        <button class="advanced-toggle" :aria-expanded="advancedVisible" @click="advancedVisible = !advancedVisible">
          <span>{{ advancedVisible ? '▾' : '▸' }}</span>
          <span><strong>{{ t('shot.plan.advancedSettings') }}</strong><small>{{ t('shot.plan.advancedSettingsHint') }}</small></span>
        </button>
        <button class="sm ghost paste-btn" @click.stop="emit('paste')">{{ t('shot.plan.pasteExternalAi') }}</button>
      </div>

      <div v-if="advancedVisible" class="advanced-sections">
        <div v-for="sec in advancedSections" :key="sec.key" class="panel section" :class="{ open: open.has(sec.key) }">
          <div class="sec-head" @click="toggleSection(sec.key)">
            <span class="chev">{{ open.has(sec.key) ? '▾' : '▸' }}</span>
            <span class="sec-cn">{{ t(`shot.plan.section.${sec.key}`) }}</span>
            <span v-if="!open.has(sec.key) && filledCount(sec)" class="badge accent no-dot">{{ t('shot.plan.itemsFilled', { n: filledCount(sec) }) }}</span>
            <span class="grow" />
          </div>
          <div v-if="open.has(sec.key)" class="panel-body grid two">
            <label v-for="f in sec.fields" :key="f.path.join('.')" class="field">
              <span class="f-label">{{ fieldLabel(f) }}</span>
              <select v-if="f.type === 'select'" :value="fieldValue(f.path)" @change="setField(f.path, ($event.target as HTMLSelectElement).value)">
                <option v-for="o in f.options" :key="o" :value="o">{{ o || '—' }}</option>
              </select>
              <textarea v-else-if="f.type === 'textarea'" :value="fieldValue(f.path)" rows="2" :placeholder="fieldPlaceholder(f)" @input="setField(f.path, ($event.target as HTMLTextAreaElement).value)" />
              <input v-else-if="f.type === 'number'" type="number" :value="fieldValue(f.path)" :placeholder="fieldPlaceholder(f)" @input="setField(f.path, Number(($event.target as HTMLInputElement).value))" />
              <template v-else-if="f.type === 'list'">
                <textarea :value="(fieldValue(f.path) as string[]).join('\n')" rows="2" :placeholder="fieldPlaceholder(f)" @input="setField(f.path, ($event.target as HTMLTextAreaElement).value.split('\n').filter(Boolean))" />
              </template>
              <input v-else :value="fieldValue(f.path)" :placeholder="fieldPlaceholder(f)" @input="setField(f.path, ($event.target as HTMLInputElement).value)" />
            </label>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.plan-editor { position: relative; isolation: isolate; }
.two { grid-template-columns: minmax(0, 1fr); }
.editor-bar { position: sticky; top: 0; z-index: 20; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 12px; background: var(--bg-2); padding: 8px 0 10px; box-shadow: 0 -16px 0 16px var(--bg-2), 0 1px 0 var(--line); }
.editor-bar > :first-child { min-width: 0; }
.save-state { margin-top: 4px; flex-wrap: wrap; }
.editor-actions { flex: none; flex-wrap: nowrap; }
.editor-actions button { flex: none; min-height: 29px; white-space: nowrap; }
.required-progress { padding: 2px 8px; border-radius: 999px; background: var(--warn-soft); color: var(--warn); font-size: 11px; font-weight: 700; }
.required-progress.complete { background: var(--ok-soft); color: var(--ok); }
.essential-card { overflow: hidden; }
.beats-wrap { padding: 2px 0 10px; }
.essential-intro { display: flex; flex-direction: column; gap: 2px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.essential-intro strong { font-size: 15px; }
.essential-intro span { color: var(--text-2); font-size: 12px; }
.essential-fields { display: grid; gap: 0; }
.essential-field { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 4px 10px; padding: 9px 14px; border-bottom: 1px solid var(--line); }
.essential-field:last-child { border-bottom: 0; }
.essential-number { display: grid; place-items: center; width: 24px; height: 24px; border: 1px solid var(--line-2); border-radius: 50%; color: var(--text-2); font-size: 12px; font-weight: 700; }
.essential-number.done { border-color: var(--ok); background: var(--ok-soft); color: var(--ok); }
.essential-copy { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.essential-question { color: var(--text); font-size: 13px; font-weight: 650; }
.essential-help { color: var(--text-3); font-size: 11px; line-height: 1.45; }
.required-mark { margin-left: 4px; color: var(--accent); font-size: 10px; font-weight: 600; }
.essential-field textarea { grid-column: 2; height: 50px; min-height: 50px; resize: vertical; }
.required-hint { padding: 8px 14px; background: var(--warn-soft); color: var(--warn); font-size: 11.5px; }
.required-hint.complete { background: var(--ok-soft); color: var(--ok); }
.advanced-wrap { border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: var(--bg-2); }
.advanced-head { display: flex; align-items: center; padding-right: 10px; }
.advanced-toggle { display: flex; flex: 1; align-items: center; gap: 9px; min-width: 0; min-height: 48px; padding: 9px 12px; border: 0; border-radius: 0; background: transparent; color: var(--text); text-align: left; }
.advanced-toggle:hover { background: var(--accent-soft); }
.advanced-toggle > span:nth-child(2) { display: flex; flex-direction: column; gap: 2px; }
.advanced-toggle small { color: var(--text-3); font-size: 10.5px; font-weight: 400; }
.paste-btn { flex: 0 0 auto; }
.advanced-sections { display: grid; gap: 8px; padding: 8px; border-top: 1px solid var(--line); }
.section { overflow: hidden; }
.section .panel-body { grid-template-columns: minmax(0, 1fr); }
.section .field > :is(input, select, textarea) { width: 100%; min-width: 0; }
.section .field > :is(input, select) { min-height: 38px; }
.section .field > textarea { min-height: 72px; resize: vertical; }
.sec-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; cursor: pointer; user-select: none; }
.sec-head:hover { background: var(--accent-soft); }
.chev { color: var(--text-3); font-size: 11px; width: 12px; }
.sec-cn { font-weight: 600; font-size: 13.5px; }
.sec-en { color: var(--text-3); font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; }
.f-label { display: flex; align-items: baseline; gap: 6px; }
.f-en { color: var(--text-3); font-size: 10.5px; font-weight: 400; }
.pulse { animation: savepulse 1.6s ease-in-out infinite; }
@keyframes savepulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(255, 108, 55, 0.0); } 50% { box-shadow: 0 0 0 4px rgba(255, 108, 55, 0.18); } }
.brief-card { padding: 14px 16px; display: grid; gap: 9px; margin-bottom: 14px; }
.brief-head { display: grid; gap: 2px; }
.brief-head strong { font-size: 13.5px; }
.brief-head .muted { font-size: 11.5px; line-height: 1.5; }
.brief-text { width: 100%; line-height: 1.7; }
.brief-actions { justify-content: flex-end; }
</style>
