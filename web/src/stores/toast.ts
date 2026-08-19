// Global toast notifications — fed by SSE events and page actions.

import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface Toast {
  id: number;
  kind: 'ok' | 'err' | 'info';
  text: string;
  actionLabel?: string;
  actionTo?: string;
  timeout?: number;
  leaving?: boolean;
}

let nextToastId = 1;

export const useToastStore = defineStore('toast', () => {
  const toasts = ref<Toast[]>([]);

  function dismiss(id: number) {
    const t = toasts.value.find((x) => x.id === id);
    if (!t) return;
    t.leaving = true;
    setTimeout(() => {
      toasts.value = toasts.value.filter((x) => x.id !== id);
    }, 180);
  }

  function push(input: { kind?: Toast['kind']; text: string; actionLabel?: string; actionTo?: string; timeout?: number }) {
    const t: Toast = { id: nextToastId++, kind: input.kind ?? 'info', text: input.text, actionLabel: input.actionLabel, actionTo: input.actionTo };
    toasts.value.push(t);
    const ms = input.timeout ?? (t.kind === 'err' ? 7000 : 4200);
    if (ms > 0) setTimeout(() => dismiss(t.id), ms);
    return t.id;
  }

  return { toasts, push, dismiss };
});

/** Convenience for non-component callers. */
export function toast(text: string, kind: Toast['kind'] = 'info', extra?: { actionLabel?: string; actionTo?: string }) {
  // Lazily import to avoid circular deps at module scope.
  const store = useToastStore();
  store.push({ text, kind, ...extra });
}
