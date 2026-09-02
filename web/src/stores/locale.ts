import { ref } from 'vue';
import { translate, type Locale } from '../i18n';

const KEY = 'h3mise-locale';
const stored = localStorage.getItem(KEY);
const saved: Locale = stored === 'en' || stored === 'ja' ? stored : 'zh';
export const locale = ref<Locale>(saved);

/** Translate; reactive to locale changes when called during render. */
export function t(path: string, vars?: Record<string, string | number>): string {
  return translate(locale.value, path, vars);
}

export function setLocale(l: Locale): void {
  locale.value = l;
  localStorage.setItem(KEY, l);
}
