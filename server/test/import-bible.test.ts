// h3mise-bible@1 import — end-to-end module test (no HTTP).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeStore, cleanupTempRoot } from './helpers.js';
import { BibleFormatError, BIBLE_FORMAT, importBible } from '../src/modules/import-bible.js';
import { getStory, listBeats, listSequences } from '../src/modules/story.js';
import { listEntities, listCharacterStates, listMedia } from '../src/modules/assets.js';

const roots: string[] = [];
after(() => {
  // fixture dirs (bible source files) first; cleanupTempRoot then closes every
  // helper-issued sqlite handle and removes the makeStore temp roots.
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  cleanupTempRoot();
});

/** A tiny valid PNG (1x1 transparent) so ffprobe/mime detection succeed. */
function pngBytes(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'h3mise-bible-'));
  roots.push(root);
  const imgA = join(root, 'chenmo.png');
  const imgB = join(root, 'alley.png');
  writeFileSync(imgA, pngBytes());
  writeFileSync(imgB, pngBytes());
  return { root, imgA, imgB };
}

test('imports a full bible into a fresh project', async () => {
  const { root, imgA, imgB } = fixture();
  const { store } = await makeStore('bible-full');
  const ffmpeg = new (await import('../src/ffmpeg.js')).Ffmpeg();

  const result = await importBible(store, ffmpeg, {
    format: BIBLE_FORMAT,
    story: {
      title: '雨夜追踪',
      synopsis: '前刑警雨夜追凶。',
      body: '第一稿正文……',
      plannedDurationSeconds: 90,
      sequences: [{ title: '第一幕', summary: '开场' }],
      beats: [
        { sequenceTitle: '第一幕', title: '追逐开始', category: 'rising_action', characters: ['陈默'], durationSeconds: 6 },
        { title: '无幕节拍', characters: ['幽灵'] }, // 幽灵不存在 → warning
      ],
    },
    worldview: {
      text: '近未来老城，雨水淹没街道。',
      locations: [{ name: '老城巷道', description: '狭窄湿滑', image: imgB }],
    },
    visualDirection: { style: '冷色 noir', aspectRatio: '2.39:1', defaultDurationSeconds: 4 },
    entities: [
      {
        kind: 'character',
        name: '陈默',
        description: '32岁前刑警',
        traits: { age: '32' },
        image: imgA,
        references: [{ path: root, role: 'costume' }], // 目录 → 导入失败 warning
        states: [{ name: '默认', costume: '灰风衣', heldItems: ['怀表'] }],
      },
      { kind: 'character', name: '陈默' }, // 重复 → skipped warning
      { kind: 'alien', name: '外星人' }, // 非法 kind → skipped warning
    ],
  });

  // Project + config
  assert.ok(result.projectId.startsWith('proj-'));
  const ctx = store.current!;
  assert.equal(ctx.config.visual_style, '冷色 noir');
  assert.equal(ctx.config.default_aspect_ratio, '2.39:1');
  assert.equal(ctx.config.default_duration_seconds, 4);

  // Story
  const story = getStory(ctx);
  assert.equal(story.title, '雨夜追踪');
  assert.equal(story.plannedDurationSeconds, 90);
  assert.ok(story.body.includes('第一稿正文'));
  assert.ok(story.body.includes('## 世界观'));

  // Sequences & beats
  assert.equal(listSequences(ctx).length, 1);
  const beats = listBeats(ctx);
  assert.equal(beats.length, 2);
  const chenmoId = ctx.db.get<{ id: string }>("SELECT id FROM entities WHERE name = '陈默'")!.id;
  assert.deepEqual(beats[0]!.characters, [chenmoId]);
  assert.equal(beats[0]!.sequenceId, listSequences(ctx)[0]!.id);
  assert.equal(beats[1]!.sequenceId, null);

  // Entities / states / media
  assert.equal(listEntities(ctx).length, 2); // 陈默 + 老城巷道(scene)
  const scene = listEntities(ctx).find((e) => e.kind === 'scene')!;
  assert.equal(scene.name, '老城巷道');
  assert.notEqual(listEntities(ctx).find((e) => e.name === '陈默')!.imageAssetId, null);
  assert.equal(listCharacterStates(ctx, chenmoId).length, 1);
  const media = listMedia(ctx);
  assert.equal(media.length, 2); // 两张主图（目录导入失败不计）
  assert.ok(media.every((m) => m.kind === 'image'));

  // Stats & warnings
  assert.deepEqual(result.stats, { entities: 2, states: 1, sequences: 1, beats: 2, media: 2 });
  assert.ok(result.warnings.some((w) => w.includes('幽灵')));
  assert.ok(result.warnings.some((w) => w.includes('重复')));
  assert.ok(result.warnings.some((w) => w.includes('未知实体类型')));
  assert.ok(result.warnings.some((w) => w.includes('素材导入失败')));
});

test('minimal bible and format validation', async () => {
  const { store } = await makeStore('bible-min');
  const ffmpeg = new (await import('../src/ffmpeg.js')).Ffmpeg();

  await assert.rejects(() => importBible(store, ffmpeg, { format: 'nope' }), BibleFormatError);
  await assert.rejects(() => importBible(store, ffmpeg, { format: BIBLE_FORMAT, story: {} }), BibleFormatError);

  const ok = await importBible(store, ffmpeg, {
    format: BIBLE_FORMAT,
    story: { title: 'Min' },
  });
  assert.equal(ok.title, 'Min');
  assert.deepEqual(ok.stats.entities, 0);
  assert.deepEqual(ok.warnings, []);
});

test('deduplicates scenes across entities and worldview locations and validates visual defaults', async () => {
  const { store } = await makeStore('bible-dedup');
  const ffmpeg = new (await import('../src/ffmpeg.js')).Ffmpeg();
  const result = await importBible(store, ffmpeg, {
    format: BIBLE_FORMAT,
    story: { title: 'Dedup' },
    visualDirection: { aspectRatio: 'wide', defaultDurationSeconds: 99 },
    entities: [{ kind: 'scene', name: '同一场景' }],
    worldview: { locations: [{ name: '同一场景' }] },
  });
  const ctx = store.current!;
  assert.equal(listEntities(ctx).filter((entity) => entity.kind === 'scene' && entity.name === '同一场景').length, 1);
  assert.equal(result.stats.entities, 1);
  assert.equal(ctx.config.default_aspect_ratio, '16:9');
  assert.equal(ctx.config.default_duration_seconds, 5);
  assert.ok(result.warnings.some((warning) => warning.includes('重复')));
  assert.ok(result.warnings.some((warning) => warning.includes('aspectRatio')));
  assert.ok(result.warnings.some((warning) => warning.includes('1–60')));
});
