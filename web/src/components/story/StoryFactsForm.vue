<script setup lang="ts">
// Story facts form (title / duration / synopsis / script body). Extracted from
// StoryPage so it can be reused (e.g. a Studio inspector).

import { t } from '../../stores/locale';

const props = defineProps<{
  draft: { title: string; plannedDurationSeconds: string; synopsis: string; body: string };
  disabled?: boolean;
  dirty?: boolean;
}>();

const emit = defineEmits<{ save: [] }>();
</script>

<template>
  <div class="panel facts-panel">
    <div class="panel-title">{{ t('pages.story.subtitle') }}</div>
    <div class="panel-body col facts-body">
      <div class="spread">
        <span class="muted">{{ t('workflow.story.clickSaveAfterMakingChanges') }}</span>
        <button class="primary sm" :disabled="!props.dirty" @click="emit('save')">{{ t('workflow.story.saveStory') }}</button>
      </div>
      <div class="grid two">
        <label class="field">
          {{ t('pages.story.titleField') }}
          <input v-model="props.draft.title" :disabled="props.disabled" :placeholder="t('workflow.story.storyTitle')" />
        </label>
        <label class="field">
          {{ t('workflow.story.plannedTotalDurationS') }}
          <input v-model="props.draft.plannedDurationSeconds" :disabled="props.disabled" type="number" min="0" max="900" :placeholder="t('workflow.story.eG90AIUsesThisTo')" />
        </label>
      </div>
      <label class="field">
        {{ t('pages.story.synopsis') }}
        <textarea v-model="props.draft.synopsis" :disabled="props.disabled" class="field-synopsis" rows="6" :placeholder="t('workflow.story.synopsisProtagonistWhatHappensAndHowIt')"></textarea>
      </label>
      <div class="script-frame">
        <div class="script-head">
          <span>{{ t('workflow.story.scriptBody') }}</span>
          <span class="script-count mono">{{ props.draft.body.length }} {{ t('workflow.story.characters') }}</span>
        </div>
        <textarea
          v-model="props.draft.body"
          class="script-body"
          rows="16"
          :disabled="props.disabled"
          :placeholder="t('workflow.story.pasteAScriptOrStoryExcerptHere')"
        ></textarea>
      </div>
    </div>
  </div>
</template>

<style scoped>
.facts-panel { align-self: start; }
.facts-body { padding: 18px; gap: 14px; }
.grid.two { grid-template-columns: 1fr 1fr; gap: 14px; }
.script-frame { border: 1px solid var(--line-2); border-radius: 10px; background: var(--bg-4); padding: 12px 16px 14px; transition: border-color 0.15s, box-shadow 0.15s; }
.script-frame:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(255, 108, 55, 0.12); }
.script-head { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; font-weight: 600; letter-spacing: 0.06em; color: var(--text-2); padding-bottom: 9px; border-bottom: 1px dashed var(--line); margin-bottom: 10px; }
.script-count { font-size: 11px; color: var(--text-3); font-weight: 400; }
.script-body { width: 100%; border: none; background: transparent; box-shadow: none; padding: 0; border-radius: 0; font-family: var(--serif); font-size: 14.5px; line-height: 1.9; color: var(--text); resize: vertical; min-height: 240px; }
.script-body:focus { border: none; box-shadow: none; }
.script-body::placeholder { color: var(--text-3); font-family: var(--serif); }
.field-synopsis { font-family: var(--serif); font-size: 14.5px; line-height: 1.9; min-height: 140px; }
</style>
