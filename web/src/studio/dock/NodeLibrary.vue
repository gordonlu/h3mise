<script setup lang="ts">
import { computed } from 'vue';
import { t } from '../../stores/locale';
import { CREATE_MIME, useCanvasCreate, type CreateDescriptor } from '../../composables/useCanvasCreate';
import { useBreakdownPickerStore } from '../../stores/breakdownPicker';

const { create } = useCanvasCreate();
const breakdownPicker = useBreakdownPickerStore();

const groups = computed<Array<{ key: string; items: CreateDescriptor[] }>>(() => [
  {
    key: 'shots',
    items: [
      { kind: 'shot', mode: 't2va', label: t('studio.create.newShot') },
      { kind: 'shot', mode: 'i2va', label: t('studio.create.newShotI2va') },
      { kind: 'shot', mode: 'ref2va', label: t('studio.create.newShotRef2va') },
    ],
  },
  {
    key: 'story',
    items: [{ kind: 'beat', label: t('studio.create.newBeat') }],
  },
  {
    key: 'assets',
    items: [
      { kind: 'entity', entityKind: 'character', label: t('studio.create.newCharacter') },
      { kind: 'entity', entityKind: 'creature', label: t('studio.create.newCreature') },
      { kind: 'entity', entityKind: 'scene', label: t('studio.create.newScene') },
      { kind: 'entity', entityKind: 'prop', label: t('studio.create.newProp') },
    ],
  },
  {
    key: 'aux',
    items: [
      { kind: 'note', label: t('studio.create.newNote') },
      { kind: 'frame', label: t('studio.create.newFrame') },
    ],
  },
]);

function onDragStart(event: DragEvent, descriptor: CreateDescriptor): void {
  event.dataTransfer?.setData(CREATE_MIME, JSON.stringify(descriptor));
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copy';
}

async function onClick(descriptor: CreateDescriptor): Promise<void> {
  await create(descriptor, { x: 220, y: 220 });
}
</script>

<template>
  <div class="hf-lib">
    <p class="hf-muted hf-lib-hint">{{ t('studio.create.hint') }}</p>
    <div v-for="group in groups" :key="group.key" class="hf-lib-group">
      <button
        v-for="item in group.items"
        :key="item.label"
        class="hf-lib-item"
        draggable="true"
        @dragstart="onDragStart($event, item)"
        @click="onClick(item)"
      >{{ item.label }}</button>
    </div>
    <div class="hf-lib-group">
      <button class="hf-lib-item" @click="breakdownPicker.show()">{{ t('studio.breakdown.create') }}</button>
    </div>
  </div>
</template>
