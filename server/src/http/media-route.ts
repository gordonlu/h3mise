// GET /api/media/:id — PRD §47. Resolves ONLY via MediaAsset id, serves the
// file with HTTP Range / 206 support for video seek and A/B compare.

import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { Context } from 'hono';
import type { ProjectContext } from '../project-store.js';
import { getMedia } from '../modules/assets.js';
import { parseByteRange } from './range.js';

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
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

export function serveMedia(p: ProjectContext, c: Context): Response {
  const id = c.req.param('id')!;
  let asset;
  try {
    asset = getMedia(p, id);
  } catch {
    return c.json({ error: 'media not found' }, 404);
  }
  let abs: string;
  try {
    abs = p.resolveProjectPath(asset.fileName);
  } catch {
    return c.json({ error: 'invalid media path' }, 400);
  }
  let st;
  try {
    st = statSync(abs);
  } catch {
    return c.json({ error: 'file missing on disk' }, 404);
  }
  const ext = asset.fileName.split('.').pop()?.toLowerCase() ?? '';
  const mime = asset.mimeType || MIME[ext] || 'application/octet-stream';
  const range = c.req.header('range');
  const total = st.size;
  const baseHeaders = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
  };

  if (range) {
    const parsed = parseByteRange(range, total);
    if (parsed === 'unsatisfiable') {
      return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${total}` } });
    }
    if (parsed) {
      const { start, end } = parsed;
      return new Response(Readable.toWeb(createReadStream(abs, { start, end })), {
        status: 206,
        headers: { ...baseHeaders, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': String(end - start + 1) },
      });
    }
  }
  return new Response(Readable.toWeb(createReadStream(abs)), { status: 200, headers: { ...baseHeaders, 'Content-Length': String(total) } });
}
