// Promise-based role picker used when connecting a reference to a shot.

import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ReferenceRole } from '@h3mise/shared';

export const ROLE_OPTIONS: ReferenceRole[] = [
  'identity', 'costume', 'environment', 'lighting', 'style', 'motion', 'audio',
];

export const useRolePickerStore = defineStore('rolePicker', () => {
  const pending = ref<{ defaults: ReferenceRole[]; resolve: (roles: ReferenceRole[] | null) => void } | null>(null);

  function ask(defaults: ReferenceRole[] = ['style']): Promise<ReferenceRole[] | null> {
    return new Promise((resolve) => {
      pending.value = { defaults, resolve };
    });
  }

  function answer(roles: ReferenceRole[] | null): void {
    pending.value?.resolve(roles);
    pending.value = null;
  }

  return { pending, ask, answer };
});
