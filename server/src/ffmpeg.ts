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

function run(bin: 'ffmpeg' | 'ffprobe', args: string[], inputLabel?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => reject(new FfmpegError(`${bin} failed to start: ${err.message}`, stderr)));
    child.on('close', (code) => {
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
    const audio = json.streams?.some((s) => s.codec_type === 'audio');
    return {
      durationSeconds: json.format?.duration ? Number(json.format.duration) : video?.duration ? Number(video.duration) : null,
      width: video?.width ?? null,
      height: video?.height ?? null,
      hasAudio: audio ?? false,
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
  async trim(input: string, outPath: string, start: number, end: number): Promise<void> {
    await mkdir(dirname(outPath), { recursive: true });
    await run(
      'ffmpeg',
      ['-y', '-ss', String(start), '-i', input, '-t', String(Math.max(0.1, end - start)), '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-movflags', '+faststart', outPath],
      input,
    );
  }

  /**
   * Concat clips (each already trimmed, same codec/params) with optional
   * crossfade between segments. `xfade` requires matching resolutions.
   */
  async concat(clips: string[], outPath: string, options?: { crossfade?: number }): Promise<void> {
    await mkdir(dirname(outPath), { recursive: true });
    if (clips.length === 0) throw new Error('concat: no clips');
    if (clips.length === 1) {
      await run('ffmpeg', ['-y', '-i', clips[0]!, '-c', 'copy', outPath], outPath);
      return;
    }
    const xfade = options?.crossfade ?? 0;
    if (xfade <= 0) {
      const list = clips.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join('\n');
      const listPath = outPath + '.concat.txt';
      await import('node:fs/promises').then((fs) => fs.writeFile(listPath, list + '\n'));
      await run(
        'ffmpeg',
        ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath],
        outPath,
      );
      return;
    }
    // xfade chain: scale all to same size first
    let filter = '';
    const inputs: string[] = [];
    clips.forEach((c, i) => {
      inputs.push('-i', c);
      filter += `[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}];`;
    });
    let prev = '[v0]';
    let offset = 0;
    const durations: number[] = [];
    for (const c of clips) {
      const info = await this.probe(c);
      durations.push(info.durationSeconds ?? 5);
    }
    for (let i = 1; i < clips.length; i++) {
      offset += Math.max(0, durations[i - 1]! - xfade);
      filter += `[${prev}][v${i}]xfade=transition=fade:duration=${xfade}:offset=${offset}[x${i}];`;
      prev = `[x${i}]`;
    }
    filter += `${prev}[vout]`;
    const audioInputs = clips.map((_, i) => `[${i}:a]`).join('');
    const amix = clips.length > 0 ? `;${audioInputs}amix=inputs=${clips.length}:normalize=0[aout]` : '';
    await run(
      'ffmpeg',
      ['-y', ...inputs, '-filter_complex', filter + amix, '-map', '[vout]', ...(clips.length > 0 ? ['-map', '[aout]'] : []), '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-movflags', '+faststart', outPath],
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
