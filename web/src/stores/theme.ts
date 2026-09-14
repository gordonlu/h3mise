// Theme store — light (default) / dark, persisted in localStorage.
// Cinema mode is a non-persisted override: production routes (shot desk,
// timeline) force a dark "darkroom" while the user's own preference is kept
// for planning pages. Toggling the theme exits cinema explicitly.

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
  const cinema = ref(false);

  function apply() {
    document.documentElement.dataset.theme = cinema.value ? 'dark' : theme.value;
    if (cinema.value) document.documentElement.dataset.cinema = 'true';
    else delete document.documentElement.dataset.cinema;
  }

  function setCinema(on: boolean) {
    if (cinema.value === on) return;
    cinema.value = on;
    apply();
  }

  function toggle() {
    // While cinema forces dark, the user sees dark — toggling should exit
    // cinema into light instead of flipping the hidden preference.
    if (cinema.value) {
      cinema.value = false;
      theme.value = 'light';
    } else {
      theme.value = theme.value === 'light' ? 'dark' : 'light';
    }
    try {
      localStorage.setItem(KEY, theme.value);
    } catch {
      /* ignore */
    }
    apply();
  }

  return { theme, cinema, apply, toggle, setCinema };
});
