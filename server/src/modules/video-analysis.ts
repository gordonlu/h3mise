import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { VideoAnalysis } from '@h3mise/shared';
import type { Ffmpeg } from '../ffmpeg.js';
import type { ProjectContext } from '../project-store.js';
import { getTake } from './takes.js';

interface CachedManifest extends VideoAnalysis {
  cacheVersion: number;
  sourceSize: number;
  sourceMtimeMs: number;
}

const CACHE_VERSION = 1;

function portableRel(p: ProjectContext, abs: string): string {
  return relative(p.root, abs).split(sep).join('/');
}

function suitability(input: { duration: number; width: number | null; height: number | null; cutCount: number }): VideoAnalysis['suitability'] {
  const reasons: string[] = [];
  let level: VideoAnalysis['suitability']['level'] = 'good';
  if (input.cutCount >= 2) {
    level = 'poor';
    reasons.push(`检测到 ${input.cutCount} 个明显镜头切换，不建议整段作为单一动作参考`);
  } else if (input.cutCount === 1) {
    level = 'warning';
    reasons.push('检测到 1 个明显镜头切换，建议先裁成单镜头片段');
  }
  if (input.duration > 15) {
    if (level === 'good') level = 'warning';
    reasons.push(`片段长 ${input.duration.toFixed(1)} 秒，建议截取最相关的动作区间`);
  }
  if ((input.width ?? 0) < 512 || (input.height ?? 0) < 288) {
    if (level === 'good') level = 'warning';
    reasons.push('分辨率偏低，动作与主体细节可能不足');
  }
  if (reasons.length === 0) reasons.push('时长、分辨率和镜头切换数量未发现明显风险');
  return { level, reasons };
}

export async function analyzeTakeVideo(p: ProjectContext, ffmpeg: Ffmpeg, takeId: string, force = false): Promise<VideoAnalysis> {
  const take = getTake(p, takeId);
  const source = p.resolveProjectPath(take.localVideoPath);
  const sourceStat = await stat(source);
  const cacheDir = join(p.paths.cache, 'video-analysis', take.id);
  const manifestPath = join(cacheDir, 'manifest.json');
  if (!force) {
    try {
      const cached = JSON.parse(await readFile(manifestPath, 'utf8')) as CachedManifest;
      if (cached.cacheVersion === CACHE_VERSION && cached.sourceSize === sourceStat.size && cached.sourceMtimeMs === sourceStat.mtimeMs) {
        await Promise.all(cached.frames.map((frame) => stat(p.resolveProjectPath(frame.relPath))));
        const { cacheVersion: _version, sourceSize: _size, sourceMtimeMs: _mtime, ...analysis } = cached;
        return analysis;
      }
    } catch {
      // Missing or stale cache is rebuilt below.
    }
  }
  await rm(cacheDir, { recursive: true, force: true });
  await mkdir(cacheDir, { recursive: true });
  const info = await ffmpeg.probe(source);
  const duration = info.durationSeconds ?? take.duration;
  const frameCount = Math.min(16, Math.max(4, Math.ceil(duration / 0.8)));
  const [rawFrames, detectedCuts] = await Promise.all([
    ffmpeg.filmstrip(source, cacheDir, duration, frameCount),
    ffmpeg.detectSceneCuts(source),
  ]);
  const sceneCuts = [0, ...detectedCuts.filter((cut) => cut < duration - 0.05)];
  const analysis: VideoAnalysis = {
    sourceTakeId: take.id,
    durationSeconds: duration,
    width: info.width,
    height: info.height,
    frames: rawFrames.map((frame) => ({ relPath: portableRel(p, frame.path), timeSeconds: frame.timeSeconds })),
    sceneCuts,
    suitability: suitability({ duration, width: info.width, height: info.height, cutCount: sceneCuts.length - 1 }),
    generatedAt: new Date().toISOString(),
  };
  const manifest: CachedManifest = { ...analysis, cacheVersion: CACHE_VERSION, sourceSize: sourceStat.size, sourceMtimeMs: sourceStat.mtimeMs };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return analysis;
}
