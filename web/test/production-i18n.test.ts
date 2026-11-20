import { test } from 'node:test';
import assert from 'node:assert/strict';
import { productionTranslations } from '../src/i18n/production.js';
import { shotTranslations } from '../src/i18n/shot.js';

test('production UI has matching zh/en/ja translation keys', () => {
  const zhKeys = Object.keys(productionTranslations.zh).sort();
  assert.deepEqual(Object.keys(productionTranslations.en).sort(), zhKeys);
  assert.deepEqual(Object.keys(productionTranslations.ja).sort(), zhKeys);
  assert.equal(productionTranslations.en['shot.production.title'], 'Production & post · Camera / Audio / CCTV');
  assert.ok(productionTranslations.ja['shot.production.quality']);
});

test('previous-Take frame bridge action is localized in all supported languages', () => {
  for (const locale of ['zh', 'en', 'ja'] as const) assert.ok(shotTranslations[locale]['shot.bindPreviousLastFrame']);
});
