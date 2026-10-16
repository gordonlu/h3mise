<script setup lang="ts">
import { ref, watch } from 'vue';
import { del, patch } from '../../api/client';
import { useNoteEditorStore } from '../../stores/noteEditor';
import { useStudioStore } from '../../stores/studio';
import { useToastStore } from '../../stores/toast';
import { t } from '../../stores/locale';

const editor = useNoteEditorStore();
const studio = useStudioStore();
const toasts = useToastStore();
const text = ref('');
const busy = ref(false);

watch(
  () => editor.pending,
  (pending) => {
    text.value = pending?.annotation.text ?? '';
  },
  { immediate: true },
);

async function save(): Promise<void> {
  const current = editor.pending;
  if (!current) return;
  busy.value = true;
  try {
    await patch(`/api/canvas/annotations/${current.annotation.id}`, { text: text.value });
    await studio.load();
    editor.close();
  } finally {
    busy.value = false;
  }
}

async function remove(): Promise<void> {
  const current = editor.pending;
  if (!current) return;
  busy.value = true;
  try {
    await del(`/api/canvas/annotations/${current.annotation.id}`);
    await studio.load();
    toasts.push({ kind: 'ok', text: t('studio.note.deleted') });
    editor.close();
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="editor.pending" class="dlg-backdrop" @click.self="editor.close()">
      <div class="dlg" role="dialog" :aria-label="t('studio.note.title')">
        <div class="dlg-head">{{ t('studio.note.title') }}</div>
        <div class="dlg-body">
          <textarea v-model="text" class="hf-note-input" rows="5" :placeholder="t('studio.note.placeholder')" />
        </div>
        <div class="dlg-foot">
          <button class="danger ghost" :disabled="busy" @click="remove">{{ t('common.delete') }}</button>
          <span class="hf-note-spacer" />
          <button :disabled="busy" @click="editor.close()">{{ t('common.cancel') }}</button>
          <button class="primary" :disabled="busy" @click="save">{{ t('common.save') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.hf-note-input { width: 100%; box-sizing: border-box; resize: vertical; min-height: 110px; }
.hf-note-spacer { flex: 1; }
</style>
