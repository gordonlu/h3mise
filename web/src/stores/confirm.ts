// Promise-based confirm dialog — replaces native window.confirm.

import { defineStore } from 'pinia';
import { ref } from 'vue';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

export const useConfirmStore = defineStore('confirm', () => {
  const pending = ref<(ConfirmOptions & { resolve: (ok: boolean) => void }) | null>(null);

  function ask(opts: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      pending.value = { ...opts, resolve };
    });
  }

  function answer(ok: boolean) {
    pending.value?.resolve(ok);
    pending.value = null;
  }

  return { pending, ask, answer };
});

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return useConfirmStore().ask(opts);
}
