// Theme store — light (default) / dark, persisted in localStorage.

import { defineStore } from 'pinia';
import { ref } from 'vue';

const KEY = 'h3mise-theme';

function initial(): 'light' | 'dark' {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* ignore */
  }
  return 'light';
}

export const useThemeStore = defineStore('theme', () => {
  const theme = ref<'light' | 'dark'>(initial());

  function apply() {
    document.documentElement.dataset.theme = theme.value;
  }

  function toggle() {
    theme.value = theme.value === 'light' ? 'dark' : 'light';
    try {
      localStorage.setItem(KEY, theme.value);
    } catch {
      /* ignore */
    }
    apply();
  }

  return { theme, apply, toggle };
});
