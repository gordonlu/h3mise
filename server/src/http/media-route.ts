// GET /api/media/:id — PRD §47. Resolves ONLY via MediaAsset id, serves the
// file with HTTP Range / 206 support for video seek and A/B compare.

import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { Context } from 'hono';
import type { ProjectContext } from '../project-store.js';
import { getMedia } from '../modules/assets.js';

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
  c.header('Content-Type', mime);
  c.header('Accept-Ranges', 'bytes');
  c.header('Cache-Control', 'private, max-age=3600');

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (isNaN(start)) {
        const n = parseInt(m[2] ?? '0', 10);
        start = Math.max(0, total - n);
        end = total - 1;
      }
      if (start > end || start >= total) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
      }
      end = Math.min(end, total - 1);
      c.status(206);
      c.header('Content-Range', `bytes ${start}-${end}/${total}`);
      c.header('Content-Length', String(end - start + 1));
      return new Response(Readable.toWeb(createReadStream(abs, { start, end })), { status: 206 });
    }
  }
  c.header('Content-Length', String(total));
  return new Response(Readable.toWeb(createReadStream(abs)), { status: 200 });
}
