import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { makeTempRoot, cleanupTempRoot } from './helpers.js';
import { Ffmpeg } from '../src/ffmpeg.js';

const roots: string[] = [];
after(() => roots.forEach((root) => cleanupTempRoot(root)));

test('concat preserves audio when source resolutions differ', async () => {
  const root = makeTempRoot('ffmpeg-cut');
  roots.push(root);
  await mkdir(root, { recursive: true });
  const ffmpeg = new Ffmpeg();
  const a = join(root, 'a.mp4');
  const b = join(root, 'b.mp4');
  const out = join(root, 'out.mp4');
  await ffmpeg.syntheticVideo(a, 0.8, 'A', '640x360');
  await ffmpeg.syntheticVideo(b, 0.8, 'B', '720x720');
  await ffmpeg.concat([a, b], out, { transitions: [{ type: 'cut', duration: 0 }] });
  const info = await ffmpeg.probe(out);
  assert.equal(info.hasAudio, true);
  assert.equal(info.width, 640);
  assert.equal(info.height, 360);
  assert.ok((info.durationSeconds ?? 0) > 1.4);
  assert.ok((info.audioDurationSeconds ?? 0) > 1.4);
});

test('crossfade keeps video and audio timelines aligned', async () => {
  const root = makeTempRoot('ffmpeg-xfade');
  roots.push(root);
  const ffmpeg = new Ffmpeg();
  const a = join(root, 'a.mp4');
  const b = join(root, 'b.mp4');
  const out = join(root, 'out.mp4');
  await ffmpeg.syntheticVideo(a, 1, 'A', '640x360');
  await ffmpeg.syntheticVideo(b, 1, 'B', '720x720');
  await ffmpeg.concat([a, b], out, { transitions: [{ type: 'dissolve', duration: 0.2 }] });
  const info = await ffmpeg.probe(out);
  assert.equal(info.hasAudio, true);
  assert.ok(Math.abs((info.durationSeconds ?? 0) - 1.8) < 0.25);
  assert.ok(Math.abs((info.audioDurationSeconds ?? 0) - (info.durationSeconds ?? 0)) < 0.25);
});

test('mixed cut then crossfade uses one video time base', async () => {
  const root = makeTempRoot('ffmpeg-mixed-transitions');
  roots.push(root);
  const ffmpeg = new Ffmpeg();
  const a = join(root, 'a.mp4');
  const b = join(root, 'b.mp4');
  const c = join(root, 'c.mp4');
  const out = join(root, 'out.mp4');
  await ffmpeg.syntheticVideo(a, 0.8, 'A', '640x360');
  await ffmpeg.syntheticVideo(b, 0.8, 'B', '640x360');
  await ffmpeg.syntheticVideo(c, 0.8, 'C', '640x360');
  await ffmpeg.concat([a, b, c], out, {
    transitions: [
      { type: 'cut', duration: 0 },
      { type: 'fade', duration: 0.2 },
    ],
  });
  const info = await ffmpeg.probe(out);
  assert.equal(info.hasAudio, true);
  assert.ok(Math.abs((info.durationSeconds ?? 0) - 2.2) < 0.25);
  assert.ok(Math.abs((info.audioDurationSeconds ?? 0) - (info.durationSeconds ?? 0)) < 0.25);
});
