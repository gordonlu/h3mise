<script setup lang="ts">
import { computed } from 'vue';
import { SHOT_USER_STATUS_LABEL, type ShotNodeData } from '@h3mise/shared';
import { useStudioStore } from '../../stores/studio';
import { t } from '../../stores/locale';

const store = useStudioStore();

interface ShotRow {
  id: string;
  title: string;
  storyBeatId: string | null;
  order: number;
  data: ShotNodeData;
}

const beats = computed(() =>
  (store.graph?.nodes ?? [])
    .filter((node) => node.kind === 'beat')
    .sort((a, b) => a.rowKey - b.rowKey)
    .map((node) => ({ id: node.id, domainId: node.domainId, title: node.title })),
);

const shots = computed<ShotRow[]>(() =>
  (store.graph?.nodes ?? [])
    .filter((node) => node.kind === 'shot')
    .map((node) => {
      const data = node.data as ShotNodeData;
      return { id: node.id, title: node.title, storyBeatId: data.storyBeatId, order: data.order, data };
    })
    .sort((a, b) => a.order - b.order),
);

function shotsFor(beatDomainId: string): ShotRow[] {
  return shots.value.filter((shot) => shot.storyBeatId === beatDomainId);
}

function meta(shot: ShotRow): string {
  return `${shot.data.h3Mode?.toUpperCase() ?? ''} · ${SHOT_USER_STATUS_LABEL[shot.data.userStatus]}`;
}

const unassigned = computed(() => shots.value.filter((shot) => !shot.storyBeatId));
</script>

<template>
  <div class="hf-outline">
    <div v-for="beat in beats" :key="beat.id" class="hf-outline-group">
      <button class="hf-outline-row beat" @click="store.select(beat.id)">
        <span class="hf-outline-dot" />{{ beat.title }}
      </button>
      <button
        v-for="shot in shotsFor(beat.domainId)"
        :key="shot.id"
        class="hf-outline-row shot"
        @click="store.select(shot.id)"
      >
        <span class="hf-outline-dot" />{{ shot.title }}
        <span class="hf-outline-meta">{{ meta(shot) }}</span>
      </button>
    </div>
    <div v-if="unassigned.length" class="hf-outline-group">
      <div class="hf-outline-row group">{{ t('studio.outline.unassigned') }}</div>
      <button v-for="shot in unassigned" :key="shot.id" class="hf-outline-row shot" @click="store.select(shot.id)">
        <span class="hf-outline-dot" />{{ shot.title }}
        <span class="hf-outline-meta">{{ meta(shot) }}</span>
      </button>
    </div>
  </div>
</template>
