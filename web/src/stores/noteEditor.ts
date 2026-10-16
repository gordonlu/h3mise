// Promise-based note/frame editor for the Studio canvas. Edits are layout-only
// annotations; the caller resolves when the editor closes.

import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { CanvasAnnotation } from '@h3mise/shared';

export const useNoteEditorStore = defineStore('noteEditor', () => {
  const pending = ref<{ annotation: CanvasAnnotation; resolve: () => void } | null>(null);

  function ask(annotation: CanvasAnnotation): Promise<void> {
    return new Promise((resolve) => {
      pending.value = { annotation, resolve };
    });
  }

  function close(): void {
    pending.value?.resolve();
    pending.value = null;
  }

  return { pending, ask, close };
});
