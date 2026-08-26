// Local FFmpeg service — PRD §34. All video operations stay on the local
// machine via child_process.spawn; no bundling, no remote transcode.

import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

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

function run(bin: 'ffmpeg' | 'ffprobe', args: string[], inputLabel?: string, timeoutMs = 600_000): Promise<string> {
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
      if (code === 0) resolve(stdout);
      else reject(new FfmpegError(`${bin} ${inputLabel ? `(${inputLabel}) ` : ''}exited with code ${code}`, stderr));
    });
  });
}

export interface FfmpegCapabilities {
  available: boolean;
  ffmpegVersion: string | null;
  ffprobeVersion: string | null;
}

export class Ffmpeg {
  constructor() {}

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

  /** Trim input to [start, end] into outPath (mp4, h264+aac). */
  async trim(
    input: string,
    outPath: string,
    start: number,
    end: number,
    options?: { audio?: { volume?: number; mute?: boolean }; ensureAudio?: boolean },
  ): Promise<void> {
    await mkdir(dirname(outPath), { recursive: true });
    const audio = options?.audio;
    const args = ['-y', '-ss', String(start), '-i', input];
    const mapAudio = !audio?.mute;
    if (audio?.mute) {
      args.push('-an');
    }
    // P0 fix: anullsrc is a FILL-IN for silent sources, never a replacement.
    // Mapping it unconditionally (-map 1:a) discarded the source audio on
    // every timeline export. Only inject when a track must exist but the
    // source has none.
    let sourceHasAudio = false;
    if (mapAudio && options?.ensureAudio) {
      try {
        sourceHasAudio = (await this.probe(input)).hasAudio;
      } catch {
        sourceHasAudio = false;
      }
      if (!sourceHasAudio) {
        // Guarantee a mono/stereo audio track for later amix/xfade (P1): a clip
        // without any audio stream would otherwise break the export graph.
        args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100');
      }
    }
    args.push('-t', String(Math.max(0.1, end - start)));
    const volumeFilter =
      audio?.volume !== undefined && audio.volume !== 1 ? `volume=${Number(audio.volume).toFixed(3)}` : null;
    if (volumeFilter && mapAudio) {
      args.push('-af', volumeFilter);
    }
    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '18');
    if (mapAudio) {
      if (sourceHasAudio) {
        // Keep the ORIGINAL audio: default stream selection picks 0:a.
        args.push('-c:a', 'aac');
      } else if (options?.ensureAudio) {
        args.push('-map', '0:v', '-map', '1:a', '-c:a', 'aac');
      } else {
        args.push('-an');
      }
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
        filter += `[${i}:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS[v${i}];`;
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
      filter += `[${i}:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS[v${i}];`;
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
