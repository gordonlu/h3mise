// Human-readable SSE activity log for the Studio bottom dock. Presentation
// only: raw events are kept so labels can re-render on locale change.

import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { AppEvent } from '@h3mise/shared';

export interface ActivityEntry {
  id: number;
  at: string;
  event: AppEvent;
}

const MAX_ENTRIES = 200;
let nextId = 1;

export const useActivityStore = defineStore('activity', () => {
  const entries = ref<ActivityEntry[]>([]);

  function push(event: AppEvent): void {
    entries.value = [{ id: nextId++, at: new Date().toISOString(), event }, ...entries.value].slice(0, MAX_ENTRIES);
  }

  function clear(): void {
    entries.value = [];
  }

  return { entries, push, clear };
});
