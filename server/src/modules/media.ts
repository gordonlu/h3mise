// Media module — PRD §47 media APIs. Import via upload or local path, frame
// extraction, and Range-serving of media by asset id (in http/media route).

import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { MediaAsset, MediaKind } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { nextId } from '../db/ids.js';
import type { Ffmpeg } from '../ffmpeg.js';
import { getMedia, insertMedia, listMedia } from './assets.js';

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
  return insertMedia(p, {
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
}

/** Save an uploaded buffer into the project assets dir and register it. */
export async function importUpload(
  p: ProjectContext,
  ffmpeg: Ffmpeg,
  input: { fileName: string; mimeType: string; data: Buffer; label?: string },
): Promise<MediaAsset> {
  const safe = basename(input.fileName).replace(/[^\w.\- ]+/g, '_');
  const id = nextId(p.db, 'media');
  const relPath = join('assets', `${id}-${safe}`);
  const abs = p.resolveProjectPath(relPath);
  await mkdir(join(p.root, 'assets'), { recursive: true });
  await writeFile(abs, input.data);
  const { size } = await stat(abs);
  return probeAndInsert(p, ffmpeg, { relPath, mimeType: input.mimeType, sizeBytes: size, source: 'import', label: input.label });
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
  const id = nextId(p.db, 'media');
  const safeName = basename(abs).replace(/[^\w.\- ]+/g, '_');
  const relPath = join('assets', `${id}-${safeName}`);
  await mkdir(join(p.root, 'assets'), { recursive: true });
  await copyFile(abs, p.resolveProjectPath(relPath));
  return probeAndInsert(p, ffmpeg, { relPath, mimeType: mime, sizeBytes: st.size, source: 'import', label: input.label });
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
