import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { makeTempRoot, cleanupTempRoot } from './helpers.js';
import { Ffmpeg, parseLoudnessMeasurement } from '../src/ffmpeg.js';

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

test('two-pass loudness normalization aligns quiet and loud clips', async () => {
  const root = makeTempRoot('ffmpeg-loudness');
  roots.push(root);
  const ffmpeg = new Ffmpeg();
  const source = join(root, 'source.mp4');
  const loud = join(root, 'loud.mp4');
  const quiet = join(root, 'quiet.mp4');
  const loudNormalized = join(root, 'loud-normalized.mp4');
  const quietNormalized = join(root, 'quiet-normalized.mp4');
  await ffmpeg.syntheticVideo(source, 2, 'Audio', '640x360');
  await ffmpeg.trim(source, loud, 0, 2, { audio: { volume: 1, normalize: false }, ensureAudio: true });
  await ffmpeg.trim(source, quiet, 0, 2, { audio: { volume: 0.1, normalize: false }, ensureAudio: true });
  const loudBefore = await ffmpeg.measureLoudness(loud);
  const quietBefore = await ffmpeg.measureLoudness(quiet);
  assert.ok(loudBefore && quietBefore);
  assert.ok(Math.abs(loudBefore.integratedLufs - quietBefore.integratedLufs) > 8);

  await ffmpeg.trim(loud, loudNormalized, 0, 2, { audio: { volume: 1, normalize: true }, ensureAudio: true });
  await ffmpeg.trim(quiet, quietNormalized, 0, 2, { audio: { volume: 1, normalize: true }, ensureAudio: true });
  const loudAfter = await ffmpeg.measureLoudness(loudNormalized);
  const quietAfter = await ffmpeg.measureLoudness(quietNormalized);
  assert.ok(loudAfter && quietAfter);
  assert.ok(Math.abs(loudAfter.integratedLufs - quietAfter.integratedLufs) < 1);
  assert.ok(Math.abs(loudAfter.integratedLufs - -16) < 1);
  assert.ok(Math.abs(quietAfter.integratedLufs - -16) < 1);
});

test('loudness parser ignores truncated JSON-like AIGC metadata from imported videos', () => {
  const stderr = `
    AIGC            : {"Label": "1", "ProduceID": "RH_2093231239
    encoder         : Lavf62.13.102
  Duration: 00:00:15.08
  [Parsed_loudnorm_0 @ 0x1234]
  {
    "input_i" : "-10.30",
    "input_tp" : "-1.70",
    "input_lra" : "3.90",
    "input_thresh" : "-21.31",
    "output_i" : "-16.32",
    "output_tp" : "-7.24",
    "output_lra" : "4.00",
    "output_thresh" : "-27.26",
    "normalization_type" : "dynamic",
    "target_offset" : "0.32"
  }`;
  assert.deepEqual(parseLoudnessMeasurement(stderr), {
    integratedLufs: -10.3,
    truePeakDb: -1.7,
    rangeLu: 3.9,
    thresholdDb: -21.31,
    targetOffset: 0.32,
  });
});

test('muted timeline clips keep a silent audio stream for concat', async () => {
  const root = makeTempRoot('ffmpeg-muted');
  roots.push(root);
  const ffmpeg = new Ffmpeg();
  const source = join(root, 'source.mp4');
  const muted = join(root, 'muted.mp4');
  const out = join(root, 'out.mp4');
  await ffmpeg.syntheticVideo(source, 0.8, 'Muted', '640x360');
  await ffmpeg.trim(source, muted, 0, 0.8, { audio: { mute: true, normalize: true }, ensureAudio: true });
  assert.equal((await ffmpeg.probe(muted)).hasAudio, true);
  await ffmpeg.concat([muted, source], out, { transitions: [{ type: 'cut', duration: 0 }] });
  assert.equal((await ffmpeg.probe(out)).hasAudio, true);
});
