// Local FFmpeg service — PRD §34. All video operations stay on the local
// machine via child_process.spawn; no bundling, no remote transcode.

import { spawn } from 'node:child_process';
import { access, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface FfprobeInfo {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  audioDurationSeconds: number | null;
  format: string | null;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

function runResult(bin: 'ffmpeg' | 'ffprobe', args: string[], inputLabel?: string, timeoutMs = 600_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new FfmpegError(`${bin} timed out after ${Math.round(timeoutMs / 1000)}s`, stderr));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new FfmpegError(`${bin} failed to start: ${err.message}`, stderr));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new FfmpegError(`${bin} ${inputLabel ? `(${inputLabel}) ` : ''}exited with code ${code}`, stderr));
    });
  });
}

async function run(bin: 'ffmpeg' | 'ffprobe', args: string[], inputLabel?: string, timeoutMs = 600_000): Promise<string> {
  return (await runResult(bin, args, inputLabel, timeoutMs)).stdout;
}

export interface LoudnessMeasurement {
  integratedLufs: number;
  truePeakDb: number;
  rangeLu: number;
  thresholdDb: number;
  targetOffset: number;
}

/** Parse only the loudnorm measurement object. FFmpeg may print arbitrary
 * media metadata before it; RunningHub videos, for example, carry a truncated
 * `AIGC={...` tag in stderr. Starting at any `{` would swallow that tag and
 * produce invalid JSON with raw log newlines inside a string. */
export function parseLoudnessMeasurement(stderr: string): LoudnessMeasurement | null {
  const matches = stderr.match(/\{\s*"input_i"\s*:\s*"[^"]+"[\s\S]*?"target_offset"\s*:\s*"[^"]+"\s*\}/g);
  if (!matches?.length) return null;
  const raw = JSON.parse(matches[matches.length - 1]!) as Record<string, string>;
  const values = {
    integratedLufs: Number(raw.input_i),
    truePeakDb: Number(raw.input_tp),
    rangeLu: Number(raw.input_lra),
    thresholdDb: Number(raw.input_thresh),
    targetOffset: Number(raw.target_offset),
  };
  return Object.values(values).every(Number.isFinite) ? values : null;
}

export function parseSceneCutTimestamps(stderr: string): number[] {
  const cuts = [...stderr.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0.02);
  return [...new Set(cuts.map((value) => Number(value.toFixed(3))))].sort((a, b) => a - b);
}

export interface FfmpegCapabilities {
  available: boolean;
  ffmpegVersion: string | null;
  ffprobeVersion: string | null;
}

export class Ffmpeg {
  constructor() {}

  /** Generic raw invocation with our spawn/timeout/error semantics. */
  async runRaw(args: string[], inputLabel?: string, timeoutMs = 600_000): Promise<void> {
    await run('ffmpeg', args, inputLabel, timeoutMs);
  }

  async capabilityCheck(): Promise<FfmpegCapabilities> {
    try {
      const [ffmpegOut, ffprobeOut] = await Promise.all([
        run('ffmpeg', ['-version']),
        run('ffprobe', ['-version']),
      ]);
      return {
        available: true,
        ffmpegVersion: ffmpegOut.split('\n')[0] ?? null,
        ffprobeVersion: ffprobeOut.split('\n')[0] ?? null,
      };
    } catch {
      return { available: false, ffmpegVersion: null, ffprobeVersion: null };
    }
  }

  async probe(path: string): Promise<FfprobeInfo> {
    const out = await run(
      'ffprobe',
      [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        path,
      ],
      path,
    );
    const json = JSON.parse(out) as {
      format?: { duration?: string; format_name?: string };
      streams?: Array<{
        codec_type?: string;
        width?: number;
        height?: number;
        duration?: string;
      }>;
    };
    const video = json.streams?.find((s) => s.codec_type === 'video');
    const audio = json.streams?.find((s) => s.codec_type === 'audio');
    return {
      durationSeconds: json.format?.duration ? Number(json.format.duration) : video?.duration ? Number(video.duration) : null,
      width: video?.width ?? null,
      height: video?.height ?? null,
      hasAudio: Boolean(audio),
      audioDurationSeconds: audio?.duration ? Number(audio.duration) : json.format?.duration && audio ? Number(json.format.duration) : null,
      format: json.format?.format_name ?? null,
    };
  }

  /** Measure a file or trimmed region for a second-pass EBU R128 loudnorm. */
  async measureLoudness(path: string, start = 0, durationSeconds?: number): Promise<LoudnessMeasurement | null> {
    const args = ['-hide_banner', '-nostats'];
    if (start > 0) args.push('-ss', String(start));
    args.push('-i', path);
    if (durationSeconds !== undefined) args.push('-t', String(Math.max(0.1, durationSeconds)));
    args.push('-map', '0:a:0', '-af', 'loudnorm=I=-16:LRA=11:TP=-1.5:print_format=json', '-f', 'null', '-');
    const { stderr } = await runResult('ffmpeg', args, path);
    return parseLoudnessMeasurement(stderr);
  }

  /** Extract one frame at `at` seconds into `outPath` (jpg). */
  async extractFrame(input: string, outPath: string, at = 0, size?: string): Promise<void> {
    await mkdir(dirname(outPath), { recursive: true });
    const args = ['-y', '-ss', String(at), '-i', input, '-frames:v', '1', '-q:v', '2'];
    if (size) args.push('-vf', `scale=${size}:force_original_aspect_ratio=decrease`);
    args.push(outPath);
    await run('ffmpeg', args, input);
  }

  /** 1-second scale-safe frame suitable for posters/thumbnails. */
  async poster(input: string, outPath: string, at = 0): Promise<void> {
    await this.extractFrame(input, outPath, at, '640:-2');
  }

  /** First frame (at 0) and last frame (duration - 0.05). */
  async firstLastFrames(input: string, firstPath: string, lastPath: string, durationSeconds: number): Promise<void> {
    await Promise.all([
      this.extractFrame(input, firstPath, 0, '1280:-2'),
      this.extractFrame(input, lastPath, Math.max(0, durationSeconds - 0.05), '1280:-2'),
    ]);
  }

  /** Create a deterministic black-border storyboard layout reference. */
  async storyboardGridTemplate(outPath: string, panelCount: 3 | 6 | 9): Promise<void> {
    const columns = 3;
    const rows = panelCount / columns;
    const cell = 512;
    await mkdir(dirname(outPath), { recursive: true });
    await run('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', `color=c=white:s=${columns * cell}x${rows * cell}`,
      '-vf', `drawgrid=w=${cell}:h=${cell}:t=8:c=black`,
      '-frames:v', '1', '-update', '1', outPath,
    ], outPath);
  }

  /** One black-framed panel used when regenerating only one grid cell. */
  async storyboardPanelTemplate(outPath: string): Promise<void> {
    await mkdir(dirname(outPath), { recursive: true });
    await run('ffmpeg', [
      '-y', '-f', 'lavfi', '-i', 'color=c=white:s=1536x1024',
      '-vf', 'drawbox=x=0:y=0:w=iw:h=ih:t=10:c=black',
      '-frames:v', '1', '-update', '1', outPath,
    ], outPath);
  }

  /** Split an AI-generated grid by fixed geometry; no image AI involved. */
  async splitStoryboardGrid(input: string, outputPaths: string[], panelCount: 3 | 6 | 9): Promise<void> {
    if (outputPaths.length !== panelCount) throw new Error('storyboard output count does not match panel count');
    const info = await this.probe(input);
    if (!info.width || !info.height) throw new Error('cannot read storyboard image dimensions');
    const columns = 3;
    const rows = panelCount / columns;
    const cellWidth = Math.floor(info.width / columns);
    const cellHeight = Math.floor(info.height / rows);
    const inset = Math.max(2, Math.round(Math.min(cellWidth, cellHeight) * 0.004));
    await Promise.all(outputPaths.map(async (outPath, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = column * cellWidth + inset;
      const y = row * cellHeight + inset;
      const width = Math.max(2, cellWidth - inset * 2);
      const height = Math.max(2, cellHeight - inset * 2);
      await mkdir(dirname(outPath), { recursive: true });
      await run('ffmpeg', [
        '-y', '-i', input, '-vf', `crop=${width}:${height}:${x}:${y}`,
        '-frames:v', '1', '-update', '1', outPath,
      ], input);
    }));
  }

  /** Rebuild a black-border sheet from selected panel versions locally. */
  async composeStoryboardGrid(inputs: string[], outPath: string, panelCount: 3 | 6 | 9): Promise<void> {
    if (inputs.length !== panelCount) throw new Error('storyboard input count does not match panel count');
    const cell = 512;
    const columns = 3;
    const rows = panelCount / columns;
    const inputArgs = inputs.flatMap((path) => ['-i', path]);
    const filters = inputs.map((_, index) =>
      `[${index}:v]scale=${cell - 12}:${cell - 12}:force_original_aspect_ratio=decrease,pad=${cell}:${cell}:(ow-iw)/2:(oh-ih)/2:color=black[p${index}]`,
    );
    const layout = inputs.map((_, index) => `${(index % columns) * cell}_${Math.floor(index / columns) * cell}`).join('|');
    filters.push(`${inputs.map((_, index) => `[p${index}]`).join('')}xstack=inputs=${panelCount}:layout=${layout}:fill=black,drawgrid=w=${cell}:h=${cell}:t=8:c=black[out]`);
    await mkdir(dirname(outPath), { recursive: true });
    await run('ffmpeg', [
      '-y', ...inputArgs, '-filter_complex', filters.join(';'), '-map', '[out]',
      '-frames:v', '1', '-update', '1', outPath,
    ], outPath);
  }

  /** Detect obvious edit points using FFmpeg's deterministic scene score. */
  async detectSceneCuts(input: string, threshold = 0.35): Promise<number[]> {
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1) throw new Error('scene threshold must be between 0 and 1');
    const { stderr } = await runResult('ffmpeg', [
      '-hide_banner', '-nostats', '-i', input,
      '-filter:v', `select='gt(scene,${threshold})',showinfo`,
      '-an', '-f', 'null', '-',
    ], input);
    return parseSceneCutTimestamps(stderr);
  }

  /** Extract a compact, evenly sampled WebP strip in one FFmpeg process. */
  async filmstrip(input: string, outDir: string, durationSeconds: number, frameCount = 12): Promise<Array<{ path: string; timeSeconds: number }>> {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('filmstrip duration must be positive');
    const count = Math.min(24, Math.max(2, Math.round(frameCount)));
    await mkdir(outDir, { recursive: true });
    const fps = count / Math.max(0.1, durationSeconds);
    await run('ffmpeg', [
      '-y', '-hide_banner', '-nostats', '-i', input,
      '-vf', `fps=${fps.toFixed(6)},scale=240:-2:force_original_aspect_ratio=decrease`,
      '-frames:v', String(count), '-c:v', 'libwebp', '-q:v', '70',
      join(outDir, 'frame-%04d.webp'),
    ], input);
    const files = (await readdir(outDir)).filter((name) => /^frame-\d+\.webp$/i.test(name)).sort();
    return files.map((name, index) => ({
      path: join(outDir, name),
      timeSeconds: Number(Math.min(Math.max(0, durationSeconds - 0.05), index * durationSeconds / count).toFixed(3)),
    }));
  }

  /** Trim input to [start, end] into outPath (mp4, h264+aac). */
  async trim(
    input: string,
    outPath: string,
    start: number,
    end: number,
    options?: { audio?: { volume?: number; mute?: boolean; normalize?: boolean }; ensureAudio?: boolean },
  ): Promise<void> {
    await mkdir(dirname(outPath), { recursive: true });
    const audio = options?.audio;
    const clipDuration = Math.max(0.1, end - start);
    const args = ['-y', '-ss', String(start), '-i', input];
    const keepSourceAudio = !audio?.mute;
    // P0 fix: anullsrc is a FILL-IN for silent sources, never a replacement.
    // Mapping it unconditionally (-map 1:a) discarded the source audio on
    // every timeline export. Only inject when a track must exist but the
    // source has none.
    let sourceHasAudio = false;
    if (keepSourceAudio || options?.ensureAudio) {
      try {
        sourceHasAudio = (await this.probe(input)).hasAudio;
      } catch {
        sourceHasAudio = false;
      }
      if (!keepSourceAudio || !sourceHasAudio) {
        // Guarantee a mono/stereo audio track for later amix/xfade (P1): a clip
        // without any audio stream would otherwise break the export graph.
        args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
      }
    }
    args.push('-t', String(clipDuration));
    const audioFilters: string[] = [];
    if (keepSourceAudio && sourceHasAudio && audio?.normalize !== false) {
      const measured = await this.measureLoudness(input, start, clipDuration);
      if (measured) {
        audioFilters.push(
          `loudnorm=I=-16:LRA=11:TP=-1.5:measured_I=${measured.integratedLufs}:measured_LRA=${measured.rangeLu}:measured_TP=${measured.truePeakDb}:measured_thresh=${measured.thresholdDb}:offset=${measured.targetOffset}:linear=true:print_format=summary`,
        );
      }
    }
    if (keepSourceAudio && audio?.volume !== undefined && audio.volume !== 1) {
      audioFilters.push(`volume=${Number(audio.volume).toFixed(3)}`);
    }
    if (audioFilters.length) {
      args.push('-af', audioFilters.join(','));
    }
    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '18');
    if (keepSourceAudio && sourceHasAudio) {
      // Keep the ORIGINAL audio: default stream selection picks 0:a.
      args.push('-c:a', 'aac');
    } else if (options?.ensureAudio) {
      // A muted clip still needs a silent stream because concat/acrossfade
      // require every timeline segment to expose audio.
      args.push('-map', '0:v', '-map', '1:a', '-c:a', 'aac');
    } else {
      args.push('-an');
    }
    args.push('-shortest', '-movflags', '+faststart', outPath);
    await run('ffmpeg', args, input);
  }

  /**
   * Concat clips (each already trimmed, same codec/params) with optional
   * crossfade between segments. `xfade` requires matching resolutions.
   */
  async concat(
    clips: string[],
    outPath: string,
    options?: { transitions?: Array<{ type: 'cut' | 'fade' | 'dissolve' | 'none'; duration: number }> },
  ): Promise<void> {
    await mkdir(dirname(outPath), { recursive: true });
    if (clips.length === 0) throw new Error('concat: no clips');
    if (clips.length === 1) {
      await run('ffmpeg', ['-y', '-i', clips[0]!, '-c', 'copy', outPath], outPath);
      return;
    }
    const firstInfo = await this.probe(clips[0]!);
    const targetWidth = Math.max(2, Math.floor((firstInfo.width ?? 1920) / 2) * 2);
    const targetHeight = Math.max(2, Math.floor((firstInfo.height ?? 1080) / 2) * 2);
    const transitions = clips.slice(1).map((_, i) => options?.transitions?.[i] ?? { type: 'cut' as const, duration: 0 });
    const hasTransition = transitions.some((transition) => transition.duration > 0 && transition.type !== 'cut' && transition.type !== 'none');
    if (!hasTransition) {
      // Normalize both streams before concatenation. Codec-copy concatenation
      // silently loses or corrupts audio when clips differ in resolution,
      // sample rate, channel layout, or time base.
      const inputs: string[] = [];
      let filter = '';
      clips.forEach((c, i) => {
        inputs.push('-i', c);
        filter += `[${i}:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,settb=AVTB,setpts=PTS-STARTPTS[v${i}];`;
        filter += `[${i}:a]aresample=44100,asetpts=PTS-STARTPTS[a${i}];`;
      });
      filter += clips.map((_, i) => `[v${i}][a${i}]`).join('') + `concat=n=${clips.length}:v=1:a=1[vout][aout]`;
      await run(
        'ffmpeg',
        ['-y', ...inputs, '-filter_complex', filter, '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-movflags', '+faststart', outPath],
        outPath,
      );
      return;
    }
    // Mixed transition chain: scale video and normalize audio timestamps first,
    // then use concat for cuts and xfade/acrossfade for visual transitions.
    let filter = '';
    const inputs: string[] = [];
    clips.forEach((c, i) => {
      inputs.push('-i', c);
      // concat emits AVTB (1/1,000,000), while a raw input commonly keeps its
      // container time base (for example 1/12,288). A later xfade requires
      // both inputs to match, so normalize every branch before chaining cuts
      // and transitions.
      filter += `[${i}:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,settb=AVTB,setpts=PTS-STARTPTS[v${i}];`;
      filter += `[${i}:a]aresample=44100,asetpts=PTS-STARTPTS[a${i}];`;
    });
    let prevV = 'v0';
    let prevA = 'a0';
    const durations: number[] = [];
    for (const c of clips) {
      const info = await this.probe(c);
      durations.push(info.durationSeconds ?? 5);
    }
    let accumulated = durations[0] ?? 0;
    for (let i = 1; i < clips.length; i++) {
      const transition = transitions[i - 1]!;
      const d = Math.min(Math.max(0, transition.duration), accumulated / 2, (durations[i] ?? 0) / 2);
      const nextV = `vx${i}`;
      const nextA = `ax${i}`;
      if (d > 0 && transition.type !== 'cut' && transition.type !== 'none') {
        const effect = transition.type === 'fade' ? 'fadeblack' : 'fade';
        const offset = Math.max(0, accumulated - d);
        filter += `[${prevV}][v${i}]xfade=transition=${effect}:duration=${d}:offset=${offset}[${nextV}];`;
        filter += `[${prevA}][a${i}]acrossfade=d=${d}:c1=tri:c2=tri[${nextA}];`;
        accumulated += (durations[i] ?? 0) - d;
      } else {
        filter += `[${prevV}][v${i}]concat=n=2:v=1:a=0[${nextV}];`;
        filter += `[${prevA}][a${i}]concat=n=2:v=0:a=1[${nextA}];`;
        accumulated += durations[i] ?? 0;
      }
      prevV = nextV;
      prevA = nextA;
    }
    await run(
      'ffmpeg',
      ['-y', ...inputs, '-filter_complex', filter.replace(/;+$/, ''), '-map', `[${prevV}]`, '-map', `[${prevA}]`, '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-movflags', '+faststart', outPath],
      outPath,
    );
  }

  /**
   * Synthetic render (mock provider): testsrc clip with optional burned-in
   * label. Lets the whole Take pipeline run offline.
   */
  async syntheticVideo(outPath: string, durationSeconds: number, label: string, size = '1280x720'): Promise<void> {
    await mkdir(dirname(outPath), { recursive: true });
    // drawtext is filter-graph hostile: keep only safe chars and escape rest.
    const safe = label
      .replace(/[^\x20-\x7E]/g, ' ')
      .replace(/[\\':,%]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    const drawtext = safe
      ? `,drawtext=text='${safe}':x=(w-text_w)/2:y=(h-text_h)/2:fontsize=48:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=16`
      : '';
    await run(
      'ffmpeg',
      [
        '-y',
        '-f', 'lavfi',
        '-i', `testsrc2=duration=${durationSeconds}:size=${size}:rate=24`,
        '-f', 'lavfi',
        '-i', 'sine=frequency=440:duration=' + durationSeconds,
        '-vf', `format=yuv420p${drawtext}`,
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
        '-c:a', 'aac', '-shortest',
        '-movflags', '+faststart',
        outPath,
      ],
      outPath,
    );
  }
}

export async function pathReadable(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
