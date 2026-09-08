<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, toRaw } from 'vue';
import type { PromptVersion, Take, TakeReview, TakeUsableRange, VisualContinuityState } from '@h3mise/shared';
import { FAILURE_TAGS } from '@h3mise/shared';
import { takeVideoUrl, fileUrl } from '../../api/client';
import { confirmDialog } from '../../stores/confirm';
import { t as tr } from '../../stores/locale';
import VideoPlayer from '../VideoPlayer.vue';
import VideoAnalysisFilmstrip from '../VideoAnalysisFilmstrip.vue';

interface EntityLite {
  id: string;
  name: string;
  kind: string;
}
interface StateLite {
  id: string;
  characterId: string;
  name: string;
}

const props = defineProps<{
  takes: Take[];
  prompts: PromptVersion[];
  selectedTakeId: string | null;
  aiEnabled: boolean;
  /** Latest committed actual visual continuity (prefill for select+commit). */
  actualState: VisualContinuityState | null;
  committedTakeId: string | null;
  entities: EntityLite[];
  characterStates: StateLite[];
  onImport: (file: File) => Promise<Take>;
  onSelect: (id: string) => Promise<void>;
  onReject: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onUpdate: (id: string, patch: Partial<Take>) => Promise<void>;
  onCreateRevision: (input: {
    text: string;
    mode: string;
    sourceTakeId: string;
    revisionReason: string;
    preservedAspects: string[];
  }) => Promise<PromptVersion>;
  onAiDiagnose: (takeId: string) => Promise<void>;
  onAiContinuity: (takeId: string) => Promise<{ state: VisualContinuityState }>;
  onSelectCommit: (takeId: string, state: VisualContinuityState) => Promise<void>;
  onUseLastFrame: (takeId: string) => Promise<void>;
  onUseFirstFrame: (takeId: string) => Promise<void>;
}>();

/** Currently focused take (click cover) — player + keyboard shortcut target. */
const active = ref<string | null>(null);
/** Explicit A/B compare slots. */
const slotA = ref<string | null>(null);
const slotB = ref<string | null>(null);
const syncPlay = ref(true);
const playerA = ref<InstanceType<typeof VideoPlayer> | null>(null);
const playerB = ref<InstanceType<typeof VideoPlayer> | null>(null);
const tagOpen = ref<Record<string, boolean>>({});
const noteEdit = ref<string | null>(null);
const busyId = ref<string | null>(null);
const importInput = ref<HTMLInputElement | null>(null);
const importBusy = ref(false);
const importError = ref('');
const reviewOpen = ref<Record<string, boolean>>({});
const reviewDrafts = ref<Record<string, TakeReview>>({});
const pictureRanges = ref<Record<string, string>>({});
const audioRanges = ref<Record<string, string>>({});
const reviewError = ref<Record<string, string>>({});
const revisionTarget = ref<string | null>(null);
const revisionText = ref('');
const revisionReason = ref('');
const revisionPreserve = ref('');
const revisionBusy = ref(false);

const activeTake = computed(() => props.takes.find((t) => t.id === active.value) ?? null);
const takeA = computed(() => props.takes.find((t) => t.id === slotA.value) ?? null);
const takeB = computed(() => props.takes.find((t) => t.id === slotB.value) ?? null);
const compareMode = computed(() => !!(takeA.value && takeB.value));
const compareRelation = computed(() => {
  if (!takeA.value || !takeB.value) return null;
  const promptA = promptForTake(takeA.value);
  const promptB = promptForTake(takeB.value);
  if (promptB?.sourceTakeId === takeA.value.id) return { source: takeA.value, candidate: takeB.value, prompt: promptB };
  if (promptA?.sourceTakeId === takeB.value.id) return { source: takeB.value, candidate: takeA.value, prompt: promptA };
  return null;
});

function promptForTake(take: Take): PromptVersion | null {
  return props.prompts.find((prompt) => prompt.id === take.promptVersionId) ?? null;
}

function sourceTakeFor(take: Take): Take | null {
  const sourceTakeId = promptForTake(take)?.sourceTakeId;
  return sourceTakeId ? props.takes.find((item) => item.id === sourceTakeId) ?? null : null;
}

async function run(id: string, fn: () => Promise<void>) {
  busyId.value = id;
  try {
    await fn();
  } finally {
    busyId.value = null;
  }
}

async function removeRejectedTake(take: Take) {
  const ok = await confirmDialog({
    title: tr('shot.takes.deleteTitle', { id: take.id }),
    message: tr('shot.takes.deleteMessage'),
    confirmLabel: tr('shot.takes.deleteTake'),
    danger: true,
  });
  if (!ok) return;
  await run(take.id, () => props.onDelete(take.id));
  if (active.value === take.id) active.value = null;
  if (slotA.value === take.id) slotA.value = null;
  if (slotB.value === take.id) slotB.value = null;
}

async function onImportPick(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  importBusy.value = true;
  importError.value = '';
  try {
    await props.onImport(file);
  } catch (error) {
    importError.value = error instanceof Error ? error.message : String(error);
  } finally {
    importBusy.value = false;
    input.value = '';
  }
}

// --- A/B sync ---------------------------------------------------------------
let mirroring = false;
function mirror(src: 'A' | 'B', action: 'play' | 'pause' | 'seek') {
  if (!syncPlay.value || mirroring) return;
  const from = src === 'A' ? playerA.value : playerB.value;
  const to = src === 'A' ? playerB.value : playerA.value;
  if (!from || !to) return;
  mirroring = true;
  try {
    if (action === 'play') {
      to.seek(from.currentTime());
      to.play();
    } else if (action === 'pause') to.pause();
    else to.seek(from.currentTime());
  } finally {
    setTimeout(() => (mirroring = false), 60);
  }
}

function assignSlot(takeId: string, slot: 'A' | 'B') {
  if (slot === 'A') slotA.value = slotA.value === takeId ? null : takeId;
  else slotB.value = slotB.value === takeId ? null : takeId;
  if (slotA.value && slotA.value === slotB.value) slotB.value = null;
}

function swapSlots() {
  const a = slotA.value;
  slotA.value = slotB.value;
  slotB.value = a;
}

// --- failure tags -----------------------------------------------------------
function toggleTag(take: Take, tag: string) {
  const next = take.failureTags.includes(tag as never) ? take.failureTags.filter((t) => t !== tag) : [...take.failureTags, tag as never];
  void props.onUpdate(take.id, { failureTags: next });
}

// --- rating -----------------------------------------------------------------
function setRating(take: Take, n: number) {
  void props.onUpdate(take.id, { rating: take.rating === n ? null : n });
}

function compareWithSource(take: Take) {
  const source = sourceTakeFor(take);
  if (!source) return;
  slotA.value = source.id;
  slotB.value = take.id;
}

async function confirmComparisonOutcome(outcome: TakeReview['iterationOutcome']) {
  const relation = compareRelation.value;
  if (!relation) return;
  const review = relation.candidate.review;
  await run(relation.candidate.id, () => props.onUpdate(relation.candidate.id, {
    review: {
      ...review,
      usableRanges: review.usableRanges.map((range) => ({ ...range })),
      preservedAspects: [...review.preservedAspects],
      iterationOutcome: outcome,
    },
  }));
}

function rangesToText(take: Take, media: 'picture' | 'audio'): string {
  return take.review.usableRanges
    .filter((range) => range.media === media)
    .map((range) => `${range.start}-${range.end}`)
    .join(', ');
}

function openReview(take: Take) {
  reviewOpen.value[take.id] = !reviewOpen.value[take.id];
  if (!reviewOpen.value[take.id]) return;
  reviewDrafts.value[take.id] = {
    ...toRaw(take.review),
    usableRanges: take.review.usableRanges.map((range) => ({ ...toRaw(range) })),
    preservedAspects: [...take.review.preservedAspects],
  };
  pictureRanges.value[take.id] = rangesToText(take, 'picture');
  audioRanges.value[take.id] = rangesToText(take, 'audio');
  reviewError.value[take.id] = '';
}

function reviewDraft(take: Take): TakeReview {
  return reviewDrafts.value[take.id] ?? take.review;
}

function parseRanges(text: string, media: 'picture' | 'audio'): TakeUsableRange[] {
  if (!text.trim()) return [];
  return text.split(',').map((part) => {
    const match = part.trim().match(/^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/);
    if (!match) throw new Error(tr('shot.takes.rangeFormatError'));
    return { start: Number(match[1]), end: Number(match[2]), media };
  });
}

async function saveReview(take: Take) {
  const draft = reviewDrafts.value[take.id];
  if (!draft) return;
  reviewError.value[take.id] = '';
  try {
    draft.usableRanges = [
      ...parseRanges(pictureRanges.value[take.id] ?? '', 'picture'),
      ...parseRanges(audioRanges.value[take.id] ?? '', 'audio'),
    ];
    draft.preservedAspects = draft.preservedAspects.map((item) => item.trim()).filter(Boolean);
    await run(take.id, () => props.onUpdate(take.id, { review: draft }));
    reviewOpen.value[take.id] = false;
  } catch (error) {
    reviewError.value[take.id] = error instanceof Error ? error.message : String(error);
  }
}

function openRevision(take: Take) {
  const prompt = props.prompts.find((item) => item.id === take.promptVersionId);
  revisionTarget.value = take.id;
  revisionText.value = prompt?.text ?? take.provenance.prompt ?? '';
  revisionReason.value = take.review.changeRequest || take.notes || take.failureTags.join(', ');
  revisionPreserve.value = take.review.preservedAspects.join(', ');
}

async function createRevision() {
  const take = props.takes.find((item) => item.id === revisionTarget.value);
  if (!take || !revisionText.value.trim() || !revisionReason.value.trim()) return;
  const prompt = props.prompts.find((item) => item.id === take.promptVersionId);
  revisionBusy.value = true;
  try {
    await props.onCreateRevision({
      text: revisionText.value.trim(),
      mode: prompt?.h3Mode ?? 't2va',
      sourceTakeId: take.id,
      revisionReason: revisionReason.value.trim(),
      preservedAspects: revisionPreserve.value.split(',').map((item) => item.trim()).filter(Boolean),
    });
    revisionTarget.value = null;
  } finally {
    revisionBusy.value = false;
  }
}

// --- continuity commit form --------------------------------------------------
const emptyState = (): VisualContinuityState => ({
  characterStates: {}, costume: {}, hair: {}, injury: {}, heldItems: {}, location: '', timeOfDay: '',
  weather: '', wind: '', screenDirection: '', facing: '', vehicleState: {}, notes: '',
});

const commitTarget = ref<string | null>(null);
const commitPanel = ref<HTMLElement | null>(null);
const commitBusy = ref(false);
const aiContinuityBusy = ref(false);
const commitForm = ref<VisualContinuityState>(emptyState());
const heldItemsText = ref<Record<string, string>>({});

const characters = computed(() => props.entities.filter((e) => e.kind === 'character' || e.kind === 'creature'));
const vehicles = computed(() => props.entities.filter((e) => e.kind === 'vehicle'));
const needsContinuity = computed(() => Boolean(props.selectedTakeId && props.committedTakeId !== props.selectedTakeId));

function statesOf(characterId: string): StateLite[] {
  return props.characterStates.filter((s) => s.characterId === characterId);
}

function appearanceLabel(character: EntityLite, field: 'costume' | 'hair'): string {
  if (character.kind !== 'creature') return field === 'costume' ? tr('shot.takes.costume') : tr('shot.takes.hair');
  return field === 'costume' ? tr('shot.takes.creatureAppearance') : tr('shot.takes.creatureSurface');
}

async function openCommit(takeId: string) {
  commitTarget.value = takeId;
  commitForm.value = structuredClone(toRaw(props.actualState ?? emptyState()));
  // heldItems edited as comma-separated text per character.
  const ht: Record<string, string> = {};
  for (const [k, v] of Object.entries(commitForm.value.heldItems ?? {})) ht[k] = v.join(', ');
  heldItemsText.value = ht;
  await nextTick();
  commitPanel.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function selectAndOpenCommit(takeId: string) {
  await run(takeId, () => props.onSelect(takeId));
  await openCommit(takeId);
}

function syncHeldItems(state: VisualContinuityState) {
  const text: Record<string, string> = {};
  for (const [entityId, items] of Object.entries(state.heldItems ?? {})) text[entityId] = items.join(', ');
  heldItemsText.value = text;
}

async function fillContinuityFromLastFrame() {
  if (!commitTarget.value) return;
  aiContinuityBusy.value = true;
  try {
    const result = await props.onAiContinuity(commitTarget.value);
    commitForm.value = structuredClone(result.state);
    syncHeldItems(commitForm.value);
  } finally {
    aiContinuityBusy.value = false;
  }
}

async function doSelectCommit() {
  if (!commitTarget.value) return;
  commitBusy.value = true;
  try {
    const form = structuredClone(toRaw(commitForm.value));
    form.heldItems = {};
    for (const [k, v] of Object.entries(heldItemsText.value)) {
      const items = v.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      if (items.length) form.heldItems[k] = items;
    }
    await props.onSelectCommit(commitTarget.value, form);
    commitTarget.value = null;
  } finally {
    commitBusy.value = false;
  }
}

// --- keyboard shortcuts ------------------------------------------------------
function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable;
}

function onKey(e: KeyboardEvent) {
  if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = activeTake.value;
  if (!t) return;
  const k = e.key.toLowerCase();
  if (k === 's' && t.status !== 'selected') { e.preventDefault(); void selectAndOpenCommit(t.id); }
  else if (k === 'r' && t.status !== 'rejected') { e.preventDefault(); void run(t.id, () => props.onReject(t.id)); }
  else if (k === 'a') { e.preventDefault(); assignSlot(t.id, 'A'); }
  else if (k === 'b') { e.preventDefault(); assignSlot(t.id, 'B'); }
}

onMounted(() => {
  window.addEventListener('keydown', onKey);
  if (needsContinuity.value && props.selectedTakeId) void openCommit(props.selectedTakeId);
});
onUnmounted(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <div class="col">
    <div class="panel import-take-bar">
      <input
        ref="importInput"
        class="file-input"
        type="file"
        accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov"
        @change="onImportPick"
      />
      <div>
        <strong>{{ tr('shot.takes.generatedElsewhere') }}</strong>
        <span>{{ tr('shot.takes.importExplanation') }}</span>
        <span v-if="importError" class="import-error">{{ tr('shot.takes.importFailed') }}{{ importError }}</span>
      </div>
      <button class="sm" :disabled="importBusy" @click="importInput?.click()">
        {{ importBusy ? tr('shot.takes.importing') : tr('shot.takes.importVideo') }}
      </button>
    </div>

    <!-- A/B compare tray -->
    <div v-if="slotA || slotB" class="panel compare-tray">
      <div class="panel-title spread">
        <span>A/B Compare</span>
        <div class="row">
          <label class="row muted sync-toggle" :title="tr('shot.takes.syncTitle')">
            <input type="checkbox" v-model="syncPlay" /> {{ tr('shot.takes.syncPlayback') }}
          </label>
          <button class="sm ghost" :title="tr('shot.takes.swapTitle')" @click="swapSlots">⇄ {{ tr('shot.takes.swap') }}</button>
          <button class="sm ghost" @click="slotA = null; slotB = null">{{ tr('shot.takes.clear') }}</button>
        </div>
      </div>
      <div class="compare-grid">
        <div class="cmp-slot">
          <template v-if="takeA">
            <VideoPlayer
              ref="playerA"
              :src="takeVideoUrl(takeA.id)"
              :poster="takeA.posterPath ? fileUrl(takeA.posterPath) : undefined"
              :label="takeA.id"
              @play="mirror('A', 'play')"
              @pause="mirror('A', 'pause')"
              @seeked="mirror('A', 'seek')"
            />
            <div class="row cmp-label">
              <span class="badge accent no-dot">A</span>
              <span class="mono">{{ takeA.id }}</span>
              <span v-if="compareRelation?.source.id === takeA.id" class="badge no-dot">{{ tr('shot.takes.sourceTake') }}</span>
              <span v-if="compareRelation?.candidate.id === takeA.id" class="badge info no-dot">{{ tr('shot.takes.revisionCandidate') }}</span>
              <span class="muted">{{ takeA.duration.toFixed(1) }}s</span>
              <span class="grow" />
              <button class="sm ghost" @click="slotA = null">✕</button>
            </div>
          </template>
          <div v-else class="cmp-empty muted">{{ tr('shot.takes.assignCompareBefore') }} <span class="kbd">A</span> {{ tr('shot.takes.assignCompareAfter', { slot: 'A' }) }}</div>
        </div>
        <div class="cmp-slot">
          <template v-if="takeB">
            <VideoPlayer
              ref="playerB"
              :src="takeVideoUrl(takeB.id)"
              :poster="takeB.posterPath ? fileUrl(takeB.posterPath) : undefined"
              :label="takeB.id"
              @play="mirror('B', 'play')"
              @pause="mirror('B', 'pause')"
              @seeked="mirror('B', 'seek')"
            />
            <div class="row cmp-label">
              <span class="badge info no-dot">B</span>
              <span class="mono">{{ takeB.id }}</span>
              <span v-if="compareRelation?.source.id === takeB.id" class="badge no-dot">{{ tr('shot.takes.sourceTake') }}</span>
              <span v-if="compareRelation?.candidate.id === takeB.id" class="badge info no-dot">{{ tr('shot.takes.revisionCandidate') }}</span>
              <span class="muted">{{ takeB.duration.toFixed(1) }}s</span>
              <span class="grow" />
              <button class="sm ghost" @click="slotB = null">✕</button>
            </div>
          </template>
          <div v-else class="cmp-empty muted">{{ tr('shot.takes.assignCompareBefore') }} <span class="kbd">B</span> {{ tr('shot.takes.assignCompareAfter', { slot: 'B' }) }}</div>
        </div>
      </div>
      <div v-if="compareMode" class="comparison-decision">
        <template v-if="compareRelation">
          <div class="decision-context">
            <div class="row wrap">
              <strong>{{ tr('shot.takes.revisionComparison') }}</strong>
              <span class="mono">{{ compareRelation.source.id }}</span>
              <span>→</span>
              <span class="mono">{{ compareRelation.candidate.id }}</span>
            </div>
            <p>{{ compareRelation.prompt.revisionReason }}</p>
            <div v-if="compareRelation.prompt.preservedAspects.length" class="row wrap preserve-row">
              <span class="muted">{{ tr('shot.takes.preserve') }}:</span>
              <span v-for="item in compareRelation.prompt.preservedAspects" :key="item" class="tag active">{{ item }}</span>
            </div>
          </div>
          <div class="outcome-actions">
            <span>{{ tr('shot.takes.didItImprove') }}</span>
            <button
              class="sm"
              :class="{ primary: compareRelation.candidate.review.iterationOutcome === 'improved' }"
              :disabled="busyId === compareRelation.candidate.id"
              @click="confirmComparisonOutcome('improved')"
            >{{ tr('shot.takes.improved') }}</button>
            <button
              class="sm"
              :class="{ primary: compareRelation.candidate.review.iterationOutcome === 'same' }"
              :disabled="busyId === compareRelation.candidate.id"
              @click="confirmComparisonOutcome('same')"
            >{{ tr('shot.takes.same') }}</button>
            <button
              class="sm"
              :class="{ danger: compareRelation.candidate.review.iterationOutcome === 'worse' }"
              :disabled="busyId === compareRelation.candidate.id"
              @click="confirmComparisonOutcome('worse')"
            >{{ tr('shot.takes.worse') }}</button>
          </div>
        </template>
        <span v-else class="muted">{{ tr('shot.takes.noDirectRelation') }}</span>
      </div>
    </div>

    <!-- focused single player -->
    <div v-else-if="activeTake" class="panel">
      <div class="panel-title spread">
        <span>{{ tr('shot.takes.playTake') }} <span class="mono">{{ activeTake.id }}</span></span>
        <button class="sm ghost" @click="active = null">{{ tr('common.close') }}</button>
      </div>
      <div class="panel-body">
        <VideoPlayer :src="takeVideoUrl(activeTake.id)" :poster="activeTake.posterPath ? fileUrl(activeTake.posterPath) : undefined" :max-height="420" />
        <VideoAnalysisFilmstrip :take-id="activeTake.id" />
      </div>
    </div>

    <div v-if="!takes.length" class="muted takes-empty">{{ tr('shot.takes.noTakes') }}</div>

    <div v-if="needsContinuity && !commitTarget" class="panel continuity-next-step">
      <div>
        <strong>{{ tr('shot.takes.nextRecordLastFrame') }}</strong>
        <span>{{ tr('shot.takes.continuityExplanation') }}</span>
      </div>
      <button class="primary sm" @click="selectedTakeId && openCommit(selectedTakeId)">{{ tr('shot.takes.fillContinuity') }}</button>
    </div>

    <!-- Select + Commit continuity form -->
    <div v-if="commitTarget" ref="commitPanel" class="panel commit-panel">
      <div class="panel-title">{{ tr('shot.takes.recordLastFrame') }} <span class="mono">{{ commitTarget }}</span></div>
      <div class="panel-body col">
        <p class="commit-intro">{{ tr('shot.takes.commitIntro') }}</p>
        <div class="grid commit-grid">
          <label class="field">{{ tr('shot.takes.location') }}<input v-model="commitForm.location" :placeholder="tr('shot.takes.locationPlaceholder')" /></label>
          <label class="field">{{ tr('shot.takes.time') }}<input v-model="commitForm.timeOfDay" :placeholder="tr('shot.takes.timePlaceholder')" /></label>
          <label class="field">{{ tr('shot.takes.weather') }}<input v-model="commitForm.weather" :placeholder="tr('shot.takes.weatherPlaceholder')" /></label>
          <label class="field">{{ tr('shot.takes.wind') }}<input v-model="commitForm.wind" :placeholder="tr('shot.takes.windPlaceholder')" /></label>
          <label class="field">{{ tr('shot.takes.screenDirection') }}<input v-model="commitForm.screenDirection" placeholder="left-to-right" /></label>
          <label class="field">{{ tr('shot.takes.facing') }}<input v-model="commitForm.facing" :placeholder="tr('shot.takes.facingPlaceholder')" /></label>
        </div>

        <div v-if="aiEnabled" class="ai-continuity-assist">
          <div>
            <strong>{{ tr('shot.takes.aiRecommended') }}</strong>
            <span>{{ tr('shot.takes.aiDraftExplanation') }}</span>
          </div>
          <button class="sm" :disabled="aiContinuityBusy || commitBusy" @click="fillContinuityFromLastFrame">
            {{ aiContinuityBusy ? tr('shot.takes.aiReadingLastFrame') : tr('shot.takes.aiReadAndFill') }}
          </button>
        </div>

        <template v-if="characters.length">
          <div class="muted sec-caption">{{ tr('shot.takes.characterVisualState') }}</div>
          <div v-for="ch in characters" :key="ch.id" class="char-block">
            <div class="row char-head">
              <span class="badge accent no-dot">{{ ch.name }}</span>
              <select
                :value="commitForm.characterStates[ch.id] ?? ''"
                :title="tr('shot.takes.linkCharacterState')"
                @change="commitForm.characterStates[ch.id] = ($event.target as HTMLSelectElement).value || undefined as never"
              >
                <option value="">— CharacterState —</option>
                <option v-for="st in statesOf(ch.id)" :key="st.id" :value="st.id">{{ st.name }}</option>
              </select>
            </div>
            <div class="grid commit-grid">
              <label class="field">{{ appearanceLabel(ch, 'costume') }}<input :value="commitForm.costume[ch.id] ?? ''" :placeholder="ch.kind === 'creature' ? tr('shot.takes.creatureClothingPlaceholder') : 'wet_white_shirt'" @input="commitForm.costume[ch.id] = ($event.target as HTMLInputElement).value" /></label>
              <label class="field">{{ appearanceLabel(ch, 'hair') }}<input :value="commitForm.hair[ch.id] ?? ''" :placeholder="ch.kind === 'creature' ? tr('shot.takes.creatureHairPlaceholder') : 'wet'" @input="commitForm.hair[ch.id] = ($event.target as HTMLInputElement).value" /></label>
              <label class="field">{{ tr('shot.takes.injury') }}<input :value="commitForm.injury[ch.id] ?? ''" placeholder="forehead_cut" @input="commitForm.injury[ch.id] = ($event.target as HTMLInputElement).value" /></label>
              <label class="field">{{ tr('shot.takes.heldItems') }}<input :value="heldItemsText[ch.id] ?? ''" placeholder="umbrella, phone" @input="heldItemsText[ch.id] = ($event.target as HTMLInputElement).value" /></label>
            </div>
          </div>
        </template>

        <template v-if="vehicles.length">
          <div class="muted sec-caption">{{ tr('shot.takes.vehicleState') }}</div>
          <div class="grid commit-grid">
            <label v-for="v in vehicles" :key="v.id" class="field">
              {{ v.name }}
              <input :value="commitForm.vehicleState[v.id] ?? ''" :placeholder="tr('shot.takes.vehiclePlaceholder')" @input="commitForm.vehicleState[v.id] = ($event.target as HTMLInputElement).value" />
            </label>
          </div>
        </template>

        <label class="field">{{ tr('shot.takes.notes') }}<textarea v-model="commitForm.notes" rows="2" :placeholder="tr('shot.takes.notesPlaceholder')"></textarea></label>

        <div class="row">
          <button class="primary sm" :disabled="commitBusy || aiContinuityBusy" @click="doSelectCommit">{{ commitBusy ? tr('shot.common.saving') : tr('shot.takes.confirmContinuity') }}</button>
          <button class="sm" @click="commitTarget = null">{{ tr('common.cancel') }}</button>
        </div>
        <p class="muted">{{ tr('shot.takes.onlyRecordsVisualState') }}</p>
      </div>
    </div>

    <div v-if="revisionTarget" class="panel revision-panel">
      <div class="panel-title spread">
        <span>{{ tr('shot.takes.reviseFrom') }} <span class="mono">{{ revisionTarget }}</span></span>
        <button class="sm ghost" @click="revisionTarget = null">{{ tr('common.close') }}</button>
      </div>
      <div class="panel-body col">
        <p class="revision-intro">{{ tr('shot.takes.revisionSafety') }}</p>
        <label class="field">{{ tr('shot.takes.changeRequest') }}<textarea v-model="revisionReason" rows="2" /></label>
        <label class="field">{{ tr('shot.takes.preserve') }}<input v-model="revisionPreserve" :placeholder="tr('shot.takes.preservePlaceholder')" /></label>
        <label class="field">{{ tr('shot.takes.revisedPrompt') }}<textarea v-model="revisionText" rows="8" /></label>
        <div class="row">
          <button class="primary sm" :disabled="revisionBusy || !revisionReason.trim() || !revisionText.trim()" @click="createRevision">
            {{ revisionBusy ? tr('shot.common.saving') : tr('shot.takes.saveRevision') }}
          </button>
          <span class="muted">{{ tr('shot.takes.preflightStillRequired') }}</span>
        </div>
      </div>
    </div>

    <!-- take cards -->
    <div class="takes grid">
      <div
        v-for="t in takes"
        :key="t.id"
        class="panel take"
        :class="{ selected: t.status === 'selected', rejected: t.status === 'rejected', focused: active === t.id }"
      >
        <div class="take-cover" @click="active = active === t.id ? null : t.id">
          <img v-if="t.posterPath" :src="fileUrl(t.posterPath)" :alt="t.id" />
          <span v-else class="muted mono">no poster</span>
          <span class="badge status-badge" :class="{ ok: t.status === 'selected', bad: t.status === 'rejected' }">
            {{ t.status === 'selected' ? 'SELECTED' : t.status === 'rejected' ? 'REJECTED' : 'CANDIDATE' }}
          </span>
          <span class="dur-chip mono">{{ t.duration.toFixed(1) }}s</span>
          <span class="play-hint">▶</span>
        </div>
        <div class="take-body col">
          <div class="spread">
            <div class="row take-identity">
              <span class="mono take-id">{{ t.id }}</span>
              <span v-if="t.source === 'import'" class="badge info no-dot" :title="t.provenance.originalFileName">IMPORTED</span>
            </div>
            <div class="stars" :title="tr('shot.takes.rating', { value: t.rating ?? '—' })">
              <span v-for="i in 5" :key="i" class="star" :class="{ on: (t.rating ?? 0) >= i }" @click="setRating(t, i)">★</span>
            </div>
          </div>

          <!-- contextual primary actions -->
          <div class="row wrap">
            <template v-if="t.status === 'candidate'">
              <button class="sm primary" :disabled="busyId === t.id" :title="tr('shot.takes.selectTitle')" @click="selectAndOpenCommit(t.id)">{{ tr('shot.takes.selectThis') }}</button>
              <button class="sm" @click="openCommit(t.id)">{{ tr('shot.takes.selectAndFill') }}</button>
              <button class="sm danger ghost" :title="tr('shot.takes.rejectTitle')" @click="run(t.id, () => onReject(t.id))">Reject</button>
            </template>
            <template v-else-if="t.status === 'selected'">
              <button class="sm primary" @click="openCommit(t.id)">{{ committedTakeId === t.id ? tr('shot.takes.viewUpdateContinuity') : tr('shot.takes.nextFillContinuity') }}</button>
              <button class="sm danger ghost" @click="run(t.id, () => onReject(t.id))">{{ tr('shot.takes.cancelSelection') }}</button>
            </template>
            <template v-else>
              <button class="sm primary" :disabled="busyId === t.id" @click="run(t.id, () => onSelect(t.id))">{{ tr('shot.takes.selectInstead') }}</button>
              <button class="sm danger" :disabled="busyId === t.id" @click="removeRejectedTake(t)">{{ tr('common.delete') }}</button>
            </template>
          </div>

          <div class="row wrap take-tools">
            <button class="sm" :class="{ 'slot-a': slotA === t.id }" :title="tr('shot.takes.compareSlotTitle', { slot: 'A' })" @click="assignSlot(t.id, 'A')">A</button>
            <button class="sm" :class="{ 'slot-b': slotB === t.id }" :title="tr('shot.takes.compareSlotTitle', { slot: 'B' })" @click="assignSlot(t.id, 'B')">B</button>
            <button class="sm ghost" :title="tr('shot.takes.lastFrameBridgeTitle')" @click="onUseLastFrame(t.id)">↗ {{ tr('shot.takes.lastFrameAsFirst') }}</button>
            <button class="sm ghost" :title="tr('shot.takes.firstFrameReferenceTitle')" @click="onUseFirstFrame(t.id)">↗ {{ tr('shot.takes.firstFrameAsReference') }}</button>
            <button v-if="aiEnabled" class="sm ghost" @click="onAiDiagnose(t.id)">{{ tr('shot.takes.aiDiagnosis') }}</button>
            <button v-if="sourceTakeFor(t)" class="sm ghost" @click="compareWithSource(t)">{{ tr('shot.takes.compareWithSource') }}</button>
            <button class="sm ghost" @click="openReview(t)">{{ tr('shot.takes.reviewRecord') }}</button>
            <button class="sm ghost" @click="openRevision(t)">{{ tr('shot.takes.startRevision') }}</button>
          </div>

          <!-- failure tags, collapsible -->
          <div class="tag-area">
            <div class="row tag-head" @click="tagOpen[t.id] = !tagOpen[t.id]">
              <span class="muted">{{ tr('shot.takes.failureTags') }}</span>
              <span v-if="t.failureTags.length" class="badge bad no-dot">{{ t.failureTags.length }}</span>
              <span class="muted chev-sm">{{ tagOpen[t.id] ? '▾' : '▸' }}</span>
            </div>
            <div v-if="tagOpen[t.id]" class="tags">
              <span
                v-for="tag in FAILURE_TAGS"
                :key="tag"
                class="tag"
                :class="{ active: t.failureTags.includes(tag) }"
                @click="toggleTag(t, tag)"
              >{{ tag }}</span>
            </div>
            <div v-else-if="t.failureTags.length" class="tags static">
              <span v-for="tag in t.failureTags" :key="tag" class="tag active">{{ tag }}</span>
            </div>
          </div>

          <div v-if="reviewOpen[t.id] && reviewDrafts[t.id]" class="review-editor col">
            <div class="grid review-verdicts">
              <label class="field">{{ tr('shot.takes.pictureVerdict') }}
                <select v-model="reviewDraft(t).pictureVerdict">
                  <option value="unreviewed">{{ tr('shot.takes.unreviewed') }}</option>
                  <option value="usable">{{ tr('shot.takes.usable') }}</option>
                  <option value="partial">{{ tr('shot.takes.partial') }}</option>
                  <option value="unusable">{{ tr('shot.takes.unusable') }}</option>
                </select>
              </label>
              <label class="field">{{ tr('shot.takes.audioVerdict') }}
                <select v-model="reviewDraft(t).audioVerdict">
                  <option value="unreviewed">{{ tr('shot.takes.unreviewed') }}</option>
                  <option value="usable">{{ tr('shot.takes.usable') }}</option>
                  <option value="partial">{{ tr('shot.takes.partial') }}</option>
                  <option value="unusable">{{ tr('shot.takes.unusable') }}</option>
                </select>
              </label>
            </div>
            <div class="grid review-verdicts">
              <label class="field">{{ tr('shot.takes.pictureRanges') }}<input v-model="pictureRanges[t.id]" placeholder="0-4, 6-8" /></label>
              <label class="field">{{ tr('shot.takes.audioRanges') }}<input v-model="audioRanges[t.id]" placeholder="0-8" /></label>
            </div>
            <label class="field">{{ tr('shot.takes.changeRequest') }}<textarea v-model="reviewDraft(t).changeRequest" rows="2" /></label>
            <label class="field">{{ tr('shot.takes.preserve') }}
              <input
                :value="reviewDraft(t).preservedAspects.join(', ')"
                :placeholder="tr('shot.takes.preservePlaceholder')"
                @input="reviewDraft(t).preservedAspects = ($event.target as HTMLInputElement).value.split(',')"
              />
            </label>
            <label v-if="prompts.find((prompt) => prompt.id === t.promptVersionId)?.sourceTakeId" class="field">{{ tr('shot.takes.iterationOutcome') }}
              <select v-model="reviewDraft(t).iterationOutcome">
                <option value="unreviewed">{{ tr('shot.takes.unreviewed') }}</option>
                <option value="improved">{{ tr('shot.takes.improved') }}</option>
                <option value="same">{{ tr('shot.takes.same') }}</option>
                <option value="worse">{{ tr('shot.takes.worse') }}</option>
              </select>
            </label>
            <div v-if="reviewError[t.id]" class="bad review-error">{{ reviewError[t.id] }}</div>
            <div class="row"><button class="primary sm" :disabled="busyId === t.id" @click="saveReview(t)">{{ tr('shot.takes.saveReview') }}</button></div>
          </div>

          <div v-else-if="t.review.pictureVerdict !== 'unreviewed' || t.review.audioVerdict !== 'unreviewed'" class="review-summary">
            <span>{{ tr('shot.takes.pictureVerdict') }}: {{ tr(`shot.takes.${t.review.pictureVerdict}`) }}</span>
            <span>{{ tr('shot.takes.audioVerdict') }}: {{ tr(`shot.takes.${t.review.audioVerdict}`) }}</span>
            <span v-if="t.review.usableRanges.length">{{ tr('shot.takes.usableRangesCount', { n: t.review.usableRanges.length }) }}</span>
          </div>

          <textarea
            v-if="noteEdit === t.id"
            :value="t.notes"
            rows="2"
            :placeholder="tr('shot.takes.notesFailurePlaceholder')"
            @blur="noteEdit = null"
            @input="onUpdate(t.id, { notes: ($event.target as HTMLTextAreaElement).value })"
          />
          <button v-else class="sm ghost note-btn" @click="noteEdit = t.id">{{ t.notes || `＋ ${tr('shot.takes.note')}` }}</button>
        </div>
      </div>
    </div>

    <div class="muted shortcuts">
      {{ tr('shot.takes.shortcutsBefore') }} <span class="kbd">S</span> {{ tr('shot.takes.select') }} · <span class="kbd">R</span> {{ tr('shot.takes.reject') }} · <span class="kbd">A</span>/<span class="kbd">B</span> {{ tr('shot.takes.compare') }}
    </div>
  </div>
</template>

<style scoped>
.file-input { display: none; }
.import-take-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px; border-style: dashed; }
.import-take-bar > div { display: grid; gap: 3px; min-width: 0; }
.import-take-bar strong { font-size: 13px; }
.import-take-bar span { color: var(--text-2); font-size: 11.5px; }
.import-take-bar button { flex: none; }
.import-take-bar .import-error { color: var(--bad); }
.takes { grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); }
.take { overflow: hidden; transition: border-color 0.15s, box-shadow 0.15s; }
.take.selected { border-color: var(--ok); box-shadow: 0 0 0 1px var(--ok), var(--shadow-1); }
.take.focused { border-color: var(--accent); }
.take.rejected { opacity: 0.55; }
.take.rejected:hover { opacity: 0.85; }
.take-cover { position: relative; height: 132px; background: var(--inset); display: flex; align-items: center; justify-content: center; cursor: pointer; overflow: hidden; }
.take-cover img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.25s; }
.take-cover:hover img { transform: scale(1.03); }
.status-badge { position: absolute; top: 6px; left: 6px; background: rgba(0, 0, 0, 0.55); backdrop-filter: blur(2px); }
.dur-chip { position: absolute; bottom: 6px; right: 6px; font-size: 10.5px; color: #fff; background: rgba(0, 0, 0, 0.55); padding: 1px 6px; border-radius: 4px; }
.play-hint { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 26px; color: rgba(255,255,255,0.9); opacity: 0; transition: opacity 0.15s; text-shadow: 0 2px 8px rgba(0,0,0,0.6); }
.take-cover:hover .play-hint { opacity: 1; }
.take-body { padding: 10px 12px; }
.take-id { font-size: 11.5px; color: var(--text-2); }
.take-identity { min-width: 0; }
.stars { display: flex; gap: 1px; }
.star { color: var(--line-2); cursor: pointer; font-size: 14px; transition: color 0.1s, transform 0.1s; }
.star:hover { transform: scale(1.2); }
.star.on { color: var(--accent); }
.wrap { flex-wrap: wrap; }
.take-tools { gap: 4px; }
.slot-a { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); font-weight: 700; }
.slot-b { border-color: var(--info); color: var(--info); background: var(--info-soft); font-weight: 700; }
.tag-area { border-top: 1px dashed var(--line); padding-top: 6px; }
.tag-head { cursor: pointer; user-select: none; gap: 6px; }
.tag-head:hover .muted { color: var(--text); }
.chev-sm { font-size: 10px; }
.tags { display: flex; flex-wrap: wrap; margin-top: 4px; }
.note-btn { text-align: left; justify-content: flex-start; }
.revision-panel { border-color: var(--accent); }
.revision-intro { margin: 0; color: var(--text-2); font-size: 12px; }
.review-editor { padding: 10px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--bg-subtle); }
.review-verdicts { grid-template-columns: 1fr 1fr; }
.review-summary { display: flex; flex-wrap: wrap; gap: 6px 12px; color: var(--text-2); font-size: 11.5px; }
.review-error { font-size: 12px; }
.takes-empty { padding: 20px 0; }
.compare-tray { border-color: var(--line-2); }
.compare-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; padding: 14px; }
.cmp-label { margin-top: 6px; }
.cmp-empty { display: flex; align-items: center; justify-content: center; min-height: 140px; border: 1.5px dashed var(--line-2); border-radius: var(--radius-sm); gap: 4px; }
.comparison-decision { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 0 14px 14px; padding: 11px 12px; border: 1px solid var(--info); border-radius: var(--radius-sm); background: var(--info-soft); }
.decision-context { display: grid; gap: 5px; min-width: 0; }
.decision-context p { margin: 0; color: var(--text-2); font-size: 12px; }
.preserve-row { gap: 5px; }
.outcome-actions { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 6px; flex: none; }
.outcome-actions > span { width: 100%; color: var(--text-2); font-size: 11.5px; text-align: right; }
.sync-toggle { gap: 5px; cursor: pointer; font-size: 12px; }
.sync-toggle input { width: auto; }
.commit-panel { border-color: var(--accent); }
.commit-intro { margin: 0; padding: 9px 11px; border-radius: var(--radius-sm); background: var(--accent-soft); color: var(--text-2); font-size: 12px; line-height: 1.55; }
.continuity-next-step { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 14px; border-color: var(--accent); background: var(--accent-soft); }
.continuity-next-step div { display: grid; gap: 3px; min-width: 0; }
.continuity-next-step span { color: var(--text-2); font-size: 12px; }
.continuity-next-step button { flex: none; }
.commit-grid { grid-template-columns: 1fr 1fr 1fr; }
.ai-continuity-assist { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid var(--info); border-radius: var(--radius-sm); background: var(--info-soft); }
.ai-continuity-assist div { display: grid; gap: 2px; min-width: 0; }
.ai-continuity-assist strong { font-size: 12.5px; }
.ai-continuity-assist span { color: var(--text-2); font-size: 11.5px; }
.ai-continuity-assist button { flex: none; }
.sec-caption { font-weight: 600; color: var(--text-2); margin-top: 4px; }
.char-block { border: 1px dashed var(--line); border-radius: var(--radius-sm); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.char-head select { width: auto; }
.shortcuts { display: flex; align-items: center; gap: 4px; padding-top: 4px; }
@media (max-width: 760px) {
  .compare-grid, .review-verdicts, .commit-grid { grid-template-columns: 1fr; }
  .comparison-decision { align-items: stretch; flex-direction: column; }
  .outcome-actions { justify-content: flex-start; }
  .outcome-actions > span { text-align: left; }
}
</style>
