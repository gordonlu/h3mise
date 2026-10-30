import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, makeProject, makeShotWithPrompt, cleanupTempRoot } from './helpers.js';
import { insertMedia } from '../src/modules/assets.js';
import {
  createAudioLine,
  createAudioSegment,
  setShotAudioSegments,
  shotAudioLineContext,
  updateAudioSegment,
} from '../src/modules/audio-lines.js';
import { compilePrompt } from '../src/modules/prompt.js';
import { intentFromInput, runBasicPreflightIntent } from '../src/modules/preflight.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { Ffmpeg } from '../src/ffmpeg.js';

const roots: string[] = [];
after(() => roots.forEach((root) => cleanupTempRoot(root)));

test('Audio Line segments become authoritative prompt text and are checked by preflight', async () => {
  const { root, store } = await makeStore('audio-lines');
  roots.push(root);
  const p = await makeProject(store, 'MV');
  const { shotId } = makeShotWithPrompt(p, 't2va');
  const asset = insertMedia(p, {
    kind: 'audio',
    fileName: 'assets/vocal.mp3',
    mimeType: 'audio/mpeg',
    sizeBytes: 10,
    durationSeconds: 4,
    source: 'import',
    label: 'Vocal',
  });
  const line = createAudioLine(p, { assetId: asset.id, kind: 'vocal', label: '主唱' });
  const first = createAudioSegment(p, line.id, { startSeconds: 0.2, endSeconds: 2.1, text: '风吹过旧站台', speaker: 'Lead' });
  const second = createAudioSegment(p, line.id, { startSeconds: 2.3, endSeconds: 4, text: '最后一班车' });
  updateAudioSegment(p, second.id, { text: '最后一班车开走' });
  setShotAudioSegments(p, shotId, [first.id, second.id]);

  const context = shotAudioLineContext(p, shotId);
  assert.equal(context?.segments.length, 2);
  assert.match(context?.text ?? '', /风吹过旧站台/);
  const prompt = compilePrompt(p, shotId, 't2va');
  assert.match(prompt.text, /最后一班车开走/);

  const registry = new ProviderRegistry(() => null, () => store.registry, new Ffmpeg(), null, 'mock');
  registry.refresh();
  const intent = await intentFromInput(p, registry, { shotId, promptVersionId: prompt.id, providerId: 'mock' });
  const report = await runBasicPreflightIntent(p, registry, intent);
  const checks = report.basic.find((section) => section.key === 'audio_line')?.checks ?? [];
  assert.ok(checks.some((check) => check.key === 'audio_line.ok'));
});

test('one shot cannot bind segments from different Audio Lines', async () => {
  const { root, store } = await makeStore('audio-lines-multi');
  roots.push(root);
  const p = await makeProject(store, 'MV2');
  const { shotId } = makeShotWithPrompt(p, 't2va');
  const mk = (label: string) => {
    const asset = insertMedia(p, { kind: 'audio', fileName: `assets/${label}.mp3`, mimeType: 'audio/mpeg', sizeBytes: 1, durationSeconds: 2, source: 'import', label });
    const line = createAudioLine(p, { assetId: asset.id, label });
    return createAudioSegment(p, line.id, { startSeconds: 0, endSeconds: 1, text: label });
  };
  const a = mk('a');
  const b = mk('b');
  assert.throws(() => setShotAudioSegments(p, shotId, [a.id, b.id]), /single audio line/);
});
