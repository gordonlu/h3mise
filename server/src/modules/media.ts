// Media module — PRD §47 media APIs. Import via upload or local path, frame
// extraction, and Range-serving of media by asset id (in http/media route).

import { copyFile, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { MediaAsset, MediaKind } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { nextId } from '../db/ids.js';
import type { Ffmpeg } from '../ffmpeg.js';
import { getMedia, insertMedia, listMedia, setMediaPoster } from './assets.js';

export type { MediaAsset, MediaKind };

const MIME: Record<string, MediaKind> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/jpg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/quicktime': 'video',
  'audio/mpeg': 'audio',
  'audio/wav': 'audio',
  'audio/mp3': 'audio',
  'audio/aac': 'audio',
  'audio/flac': 'audio',
};

function kindForMime(mime: string): MediaKind | null {
  return MIME[mime] ?? (mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : null);
}

export function importableKindForMime(mime: string): 'image' | 'audio' {
  const kind = kindForMime(mime);
  if (!kind) throw new Error(`unsupported media type: ${mime}`);
  if (kind === 'video') throw new Error('视频请从 Shot 的 Takes 区导入；资产库只接受图片和参考音频');
  return kind;
}

async function probeAndInsert(
  p: ProjectContext,
  ffmpeg: Ffmpeg,
  input: { relPath: string; mimeType: string; sizeBytes: number; source: MediaAsset['source']; label?: string; kind?: MediaKind },
): Promise<MediaAsset> {
  const kind = input.kind ?? kindForMime(input.mimeType);
  if (!kind) throw new Error(`unsupported media type: ${input.mimeType}`);
  let width: number | undefined;
  let height: number | undefined;
  let duration: number | undefined;
  if (kind !== 'audio') {
    try {
      const info = await ffmpeg.probe(p.resolveProjectPath(input.relPath));
      if (info.width) width = info.width;
      if (info.height) height = info.height;
      if (info.durationSeconds) duration = info.durationSeconds;
    } catch {
      // image without ffprobe support — dimensions unknown is fine
    }
  } else {
    try {
      const info = await ffmpeg.probe(p.resolveProjectPath(input.relPath));
      if (info.durationSeconds) duration = info.durationSeconds;
    } catch {
      /* ignore */
    }
  }
  const asset = insertMedia(p, {
    kind,
    fileName: input.relPath,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    width,
    height,
    durationSeconds: duration,
    source: input.source,
    label: input.label ?? basename(input.relPath),
  });
  // Auto-generate a poster frame for video assets so the library has thumbnails.
  if (kind === 'video') {
    try {
      const posterRel = join('assets', `${asset.id}-poster.jpg`);
      await ffmpeg.poster(p.resolveProjectPath(input.relPath), p.resolveProjectPath(posterRel), Math.min(0.1, (duration ?? 1) / 2));
      return setMediaPoster(p, asset.id, posterRel);
    } catch {
      // poster is best-effort; the asset is already registered
    }
  }
  return asset;
}

/** Save an uploaded buffer into the project assets dir and register it. */
export async function importUpload(
  p: ProjectContext,
  ffmpeg: Ffmpeg,
  input: { fileName: string; mimeType: string; data: Buffer; label?: string },
): Promise<MediaAsset> {
  const kind = importableKindForMime(input.mimeType);
  const safe = basename(input.fileName).replace(/[^\w.\- ]+/g, '_');
  const id = nextId(p.db, 'media');
  const relPath = join('assets', `${id}-${safe}`);
  const abs = p.resolveProjectPath(relPath);
  await mkdir(join(p.root, 'assets'), { recursive: true });
  await writeFile(abs, input.data);
  const { size } = await stat(abs);
  return probeAndInsert(p, ffmpeg, { relPath, mimeType: input.mimeType, sizeBytes: size, source: 'import', label: input.label, kind });
}

/** Import an existing local file by absolute path (local-first feature). */
export async function importPath(
  p: ProjectContext,
  ffmpeg: Ffmpeg,
  input: { path: string; label?: string },
): Promise<MediaAsset> {
  const abs = input.path.trim();
  if (!abs.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(abs)) throw new Error('absolute path required');
  let st;
  try {
    st = await stat(abs);
  } catch {
    throw new Error('file not found or unreadable: ' + abs);
  }
  if (st.isDirectory()) throw new Error('path is a directory');
  const mime = mimeFromExt(abs);
  const kind = importableKindForMime(mime);
  const id = nextId(p.db, 'media');
  const safeName = basename(abs).replace(/[^\w.\- ]+/g, '_');
  const relPath = join('assets', `${id}-${safeName}`);
  await mkdir(join(p.root, 'assets'), { recursive: true });
  await copyFile(abs, p.resolveProjectPath(relPath));
  return probeAndInsert(p, ffmpeg, { relPath, mimeType: mime, sizeBytes: st.size, source: 'import', label: input.label, kind });
}

/** Remove the project-owned files behind a media row. Database references are
 * handled separately through foreign keys so callers can present usage first. */
export async function removeStoredMediaFiles(p: ProjectContext, asset: MediaAsset): Promise<void> {
  const paths = [asset.fileName, asset.posterPath].filter((path): path is string => Boolean(path));
  await Promise.all(paths.map(async (path) => {
    try {
      await unlink(p.resolveProjectPath(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }));
}

function mimeFromExt(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    flac: 'audio/flac',
  };
  return map[ext] ?? 'application/octet-stream';
}

/** Extract a frame from any media asset (image/video) at time t. */
export async function extractFrameAsset(
  p: ProjectContext,
  ffmpeg: Ffmpeg,
  input: { assetId: string; atSeconds: number; label?: string },
): Promise<MediaAsset> {
  const src = getMedia(p, input.assetId);
  const srcAbs = p.resolveProjectPath(src.fileName);
  const id = nextId(p.db, 'media');
  const relPath = join('assets', `${id}-frame.jpg`);
  await mkdir(join(p.root, 'assets'), { recursive: true });
  await ffmpeg.extractFrame(srcAbs, p.resolveProjectPath(relPath), Math.max(0, input.atSeconds), '1280:-2');
  const { size } = await stat(p.resolveProjectPath(relPath));
  return insertMedia(p, {
    kind: 'image',
    fileName: relPath,
    mimeType: 'image/jpeg',
    sizeBytes: size,
    source: 'frame_extract',
    label: input.label ?? `Frame @${input.atSeconds}s from ${src.label || src.id}`,
  });
}

export { listMedia, getMedia };
