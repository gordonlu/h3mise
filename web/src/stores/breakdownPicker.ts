// Reference-breakdown picker: choose a local video asset and run the existing
// local FFmpeg breakdown. No paid provider is involved.

import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useBreakdownPickerStore = defineStore('breakdownPicker', () => {
  const open = ref(false);

  function show(): void {
    open.value = true;
  }

  function close(): void {
    open.value = false;
  }

  return { open, show, close };
});
