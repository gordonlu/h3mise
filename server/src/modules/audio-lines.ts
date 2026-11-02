// Project-level audio lines (master/vocal) with sentence-level segments.
// Text is user/AI supplied; silence detection only proposes boundaries. The
// prompt compiler and preflight use the bound segments as the authoritative
// words, so a Take is never asked to invent half a line.
import { join, relative, sep } from 'node:path';
import type { AudioLine, AudioLineKind, AudioSegment } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { nextId } from '../db/ids.js';
import { getMedia } from './assets.js';
import { listShots } from './shots.js';
import { transcribeAudio } from './transcription.js';
import type { Ffmpeg } from '../ffmpeg.js';

interface LineRow {
  id: string;
  asset_id: string;
  kind: string;
  label: string;
  offset_seconds: number;
  silences_json: string;
  created_at: string;
  updated_at: string;
}

interface SegmentRow {
  id: string;
  line_id: string;
  ord: number;
  start_seconds: number;
  end_seconds: number;
  text: string;
  speaker: string;
  created_at: string;
  updated_at: string;
}

function lineFromRow(row: LineRow): AudioLine {
  return {
    id: row.id,
    assetId: row.asset_id,
    kind: row.kind === 'vocal' ? 'vocal' : 'master',
    label: row.label,
    offsetSeconds: row.offset_seconds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function segmentFromRow(row: SegmentRow): AudioSegment {
  return {
    id: row.id,
    lineId: row.line_id,
    order: row.ord,
    startSeconds: row.start_seconds,
    endSeconds: row.end_seconds,
    text: row.text,
    speaker: row.speaker,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listAudioLines(p: ProjectContext): AudioLine[] {
  return p.db.all<LineRow>('SELECT * FROM audio_lines ORDER BY created_at').map(lineFromRow);
}

export function getAudioLine(p: ProjectContext, id: string): AudioLine {
  const row = p.db.get<LineRow>('SELECT * FROM audio_lines WHERE id = ?', [id]);
  if (!row) throw new Error('audio line not found');
  return lineFromRow(row);
}

export function getAudioLineSilences(p: ProjectContext, lineId: string): Array<{ start: number; end: number }> {
  const row = p.db.get<{ silences_json: string }>('SELECT silences_json FROM audio_lines WHERE id = ?', [lineId]);
  if (!row) return [];
  try {
    const value = JSON.parse(row.silences_json);
    return Array.isArray(value) ? value.filter((item): item is { start: number; end: number } => Boolean(item && typeof item.start === 'number' && typeof item.end === 'number')) : [];
  } catch {
    return [];
  }
}

export function listAudioSegments(p: ProjectContext, lineId?: string): AudioSegment[] {
  const rows = lineId
    ? p.db.all<SegmentRow>('SELECT * FROM audio_segments WHERE line_id = ? ORDER BY ord, start_seconds', [lineId])
    : p.db.all<SegmentRow>('SELECT * FROM audio_segments ORDER BY line_id, ord, start_seconds');
  return rows.map(segmentFromRow);
}

export function createAudioLine(p: ProjectContext, input: { assetId: string; kind?: AudioLineKind; label?: string; offsetSeconds?: number }): AudioLine {
  const asset = getMedia(p, input.assetId);
  if (asset.kind !== 'audio') throw new Error('audio line requires an audio asset');
  const id = nextId(p.db, 'audio_line');
  const now = new Date().toISOString();
  const kind: AudioLineKind = input.kind === 'vocal' ? 'vocal' : 'master';
  p.db.run(
    'INSERT INTO audio_lines (id, asset_id, kind, label, offset_seconds, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, input.assetId, kind, input.label?.trim() || asset.label || kind, Number(input.offsetSeconds ?? 0), now, now],
  );
  return getAudioLine(p, id);
}

export function updateAudioLine(p: ProjectContext, id: string, patch: { kind?: AudioLineKind; label?: string; offsetSeconds?: number }): AudioLine {
  getAudioLine(p, id);
  const cols: string[] = [];
  const vals: unknown[] = [];
  if (patch.kind !== undefined) {
    if (patch.kind !== 'master' && patch.kind !== 'vocal') throw new Error('invalid audio line kind');
    cols.push('kind = ?');
    vals.push(patch.kind);
  }
  if (patch.label !== undefined) {
    cols.push('label = ?');
    vals.push(patch.label.trim());
  }
  if (patch.offsetSeconds !== undefined) {
    if (!Number.isFinite(patch.offsetSeconds)) throw new Error('invalid audio offset');
    cols.push('offset_seconds = ?');
    vals.push(patch.offsetSeconds);
  }
  if (cols.length) {
    vals.push(new Date().toISOString(), id);
    p.db.run(`UPDATE audio_lines SET ${cols.join(', ')}, updated_at = ? WHERE id = ?`, vals);
  }
  return getAudioLine(p, id);
}

export function deleteAudioLine(p: ProjectContext, id: string): void {
  getAudioLine(p, id);
  p.db.run('DELETE FROM audio_lines WHERE id = ?', [id]);
}

export function createAudioSegment(p: ProjectContext, lineId: string, input: { startSeconds: number; endSeconds: number; text?: string; speaker?: string }): AudioSegment {
  getAudioLine(p, lineId);
  const start = Number(input.startSeconds);
  const end = Number(input.endSeconds);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('invalid audio segment range');
  const id = nextId(p.db, 'audio_segment');
  const ord = p.db.get<{ m: number }>('SELECT COALESCE(MAX(ord), 0) + 1 AS m FROM audio_segments WHERE line_id = ?', [lineId])!.m;
  const now = new Date().toISOString();
  p.db.run(
    'INSERT INTO audio_segments (id, line_id, ord, start_seconds, end_seconds, text, speaker, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, lineId, ord, start, end, input.text?.trim() ?? '', input.speaker?.trim() ?? '', now, now],
  );
  return segmentFromRow(p.db.get<SegmentRow>('SELECT * FROM audio_segments WHERE id = ?', [id])!);
}

export function updateAudioSegment(p: ProjectContext, id: string, patch: { startSeconds?: number; endSeconds?: number; text?: string; speaker?: string; order?: number }): AudioSegment {
  const row = p.db.get<SegmentRow>('SELECT * FROM audio_segments WHERE id = ?', [id]);
  if (!row) throw new Error('audio segment not found');
  const start = patch.startSeconds ?? row.start_seconds;
  const end = patch.endSeconds ?? row.end_seconds;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('invalid audio segment range');
  const siblings = p.db.all<{ id: string; start_seconds: number; end_seconds: number }>(
    'SELECT id, start_seconds, end_seconds FROM audio_segments WHERE line_id = ? AND id != ?',
    [row.line_id, id],
  );
  if (siblings.some((item) => start < item.end_seconds - 0.01 && end > item.start_seconds + 0.01)) {
    throw new Error('audio segment overlaps a neighbouring segment');
  }
  const cols: string[] = [];
  const vals: unknown[] = [];
  if (patch.startSeconds !== undefined) { cols.push('start_seconds = ?'); vals.push(start); }
  if (patch.endSeconds !== undefined) { cols.push('end_seconds = ?'); vals.push(end); }
  if (patch.text !== undefined) { cols.push('text = ?'); vals.push(patch.text.trim()); }
  if (patch.speaker !== undefined) { cols.push('speaker = ?'); vals.push(patch.speaker.trim()); }
  if (patch.order !== undefined) {
    if (!Number.isInteger(patch.order)) throw new Error('invalid audio segment order');
    cols.push('ord = ?'); vals.push(patch.order);
  }
  if (cols.length) {
    vals.push(new Date().toISOString(), id);
    p.db.run(`UPDATE audio_segments SET ${cols.join(', ')}, updated_at = ? WHERE id = ?`, vals);
  }
  return segmentFromRow(p.db.get<SegmentRow>('SELECT * FROM audio_segments WHERE id = ?', [id])!);
}

export function deleteAudioSegment(p: ProjectContext, id: string): void {
  p.db.run('DELETE FROM audio_segments WHERE id = ?', [id]);
}

/** Suggest sentence boundaries from silence. Existing segments are preserved
 * unless replace=true is explicit. */
export async function detectAudioSegments(
  p: ProjectContext,
  ffmpeg: Ffmpeg,
  lineId: string,
  options: { replace?: boolean; noiseDb?: number; minSilenceSeconds?: number } = {},
): Promise<{ created: AudioSegment[]; preserved: boolean }> {
  const line = getAudioLine(p, lineId);
  const asset = getMedia(p, line.assetId);
  const source = p.resolveProjectPath(asset.fileName);
  const silences = await ffmpeg.detectSilences(source, {
    noiseDb: options.noiseDb,
    minDurationSeconds: options.minSilenceSeconds,
  });
  const duration = asset.durationSeconds ?? (await ffmpeg.probe(source)).durationSeconds ?? 0;
  if (!(duration > 0)) throw new Error('audio asset duration is unknown');
  const existing = listAudioSegments(p, lineId);
  if (existing.length && !options.replace) return { created: [], preserved: true };

  p.db.run('UPDATE audio_lines SET silences_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify(silences), new Date().toISOString(), lineId]);
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const silence of silences) {
    if (silence.start - cursor >= 0.2) ranges.push({ start: cursor, end: silence.start });
    cursor = Math.max(cursor, silence.end);
  }
  if (duration - cursor >= 0.2) ranges.push({ start: cursor, end: duration });
  if (!ranges.length) ranges.push({ start: 0, end: duration });

  const created = p.db.tx(() => {
    if (options.replace) p.db.run('DELETE FROM audio_segments WHERE line_id = ?', [lineId]);
    return ranges.map((range) => createAudioSegment(p, lineId, { startSeconds: range.start, endSeconds: range.end, text: '' }));
  });
  return { created, preserved: false };
}

export function getShotAudioSegments(p: ProjectContext, shotId: string): AudioSegment[] {
  return p.db.all<SegmentRow>(
    `SELECT seg.* FROM shot_audio_segments bind
     JOIN audio_segments seg ON seg.id = bind.segment_id
     WHERE bind.shot_id = ?
     ORDER BY bind.ord, seg.ord, seg.start_seconds`,
    [shotId],
  ).map(segmentFromRow);
}

/** Replace the shot's bound segments atomically; every segment must exist. */
export function setShotAudioSegments(p: ProjectContext, shotId: string, segmentIds: string[]): AudioSegment[] {
  const unique = [...new Set(segmentIds)];
  const lineIds = new Set<string>();
  for (const id of unique) {
    const row = p.db.get<{ id: string; line_id: string }>('SELECT id, line_id FROM audio_segments WHERE id = ?', [id]);
    if (!row) throw new Error(`audio segment not found: ${id}`);
    lineIds.add(row.line_id);
  }
  if (lineIds.size > 1) throw new Error('one shot can only bind segments from a single audio line');
  p.db.tx(() => {
    p.db.run('DELETE FROM shot_audio_segments WHERE shot_id = ?', [shotId]);
    unique.forEach((segmentId, index) => {
      p.db.run('INSERT INTO shot_audio_segments (shot_id, segment_id, ord) VALUES (?, ?, ?)', [shotId, segmentId, index]);
    });
  });
  return getShotAudioSegments(p, shotId);
}

export interface ShotAudioLineContext {
  line: AudioLine;
  segments: AudioSegment[];
  text: string;
}

export function shotAudioLineContext(p: ProjectContext, shotId: string): ShotAudioLineContext | null {
  const segments = getShotAudioSegments(p, shotId);
  if (!segments.length) return null;
  const line = getAudioLine(p, segments[0]!.lineId);
  const text = [
    'audio_line (authoritative words; do not paraphrase, translate, omit or split):',
    ...segments.map((segment, index) => {
      const speaker = segment.speaker ? ` [${segment.speaker}]` : '';
      return `${index + 1}. ${segment.startSeconds.toFixed(2)}–${segment.endSeconds.toFixed(2)}s${speaker}: ${segment.text}`;
    }),
    'Sing/speak exactly these words in order. Cut only at a complete phrase or silence boundary. Do not invent additional lyrics or dialogue.',
  ].join('\n');
  return { line, segments, text };
}

export async function transcribeAudioLine(
  p: ProjectContext,
  lineId: string,
  options: { replace?: boolean; language?: string } = {},
): Promise<{ provider: string; segments: AudioSegment[]; filled: number }> {
  const line = getAudioLine(p, lineId);
  const asset = getMedia(p, line.assetId);
  const result = await transcribeAudio(p.resolveProjectPath(asset.fileName), { language: options.language });
  const existing = listAudioSegments(p, lineId);
  const duration = asset.durationSeconds ?? 0;
  const transcript = result.segments.map((segment, index) => ({
    ...segment,
    end: segment.end > segment.start ? segment.end : Math.min(duration || segment.start + 2, segment.start + 2),
    order: index,
  }));
  if (!existing.length || options.replace) {
    const segments = p.db.tx(() => {
      p.db.run('DELETE FROM audio_segments WHERE line_id = ?', [lineId]);
      return transcript.map((segment) => createAudioSegment(p, lineId, {
        startSeconds: segment.start,
        endSeconds: segment.end,
        text: segment.text,
      }));
    });
    return { provider: result.provider, segments, filled: segments.length };
  }
  let filled = 0;
  for (const segment of existing) {
    const best = transcript
      .map((candidate) => ({
        candidate,
        overlap: Math.max(0, Math.min(segment.endSeconds, candidate.end) - Math.max(segment.startSeconds, candidate.start)),
      }))
      .sort((a, b) => b.overlap - a.overlap)[0];
    if (best && best.overlap > 0 && best.candidate.text && best.candidate.text !== segment.text) {
      updateAudioSegment(p, segment.id, { text: best.candidate.text });
      filled += 1;
    }
  }
  return { provider: result.provider, segments: listAudioSegments(p, lineId), filled };
}

export function autoBindAudioLine(p: ProjectContext, lineId: string): { bound: number; shots: Array<{ shotId: string; segmentIds: string[] }> } {
  const segments = listAudioSegments(p, lineId);
  const shots = listShots(p);
  if (!segments.length) throw new Error('audio line has no segments');
  if (!shots.length) throw new Error('project has no shots to bind');
  const groups: string[][] = shots.map(() => []);
  if (segments.length === shots.length) {
    segments.forEach((segment, index) => groups[index]!.push(segment.id));
  } else {
    const audioTotal = segments.reduce((sum, segment) => sum + (segment.endSeconds - segment.startSeconds), 0) || segments.length;
    const shotTotal = shots.reduce((sum, shot) => sum + Math.max(0.1, shot.durationSeconds), 0) || shots.length;
    let audioCursor = 0;
    for (const segment of segments) {
      const mid = ((audioCursor + (segment.endSeconds - segment.startSeconds) / 2) / audioTotal) * shotTotal;
      let shotIndex = 0;
      let cursor = 0;
      for (let index = 0; index < shots.length; index += 1) {
        cursor += Math.max(0.1, shots[index]!.durationSeconds);
        if (mid <= cursor) { shotIndex = index; break; }
        shotIndex = index;
      }
      groups[shotIndex]!.push(segment.id);
      audioCursor += segment.endSeconds - segment.startSeconds;
    }
  }
  const output: Array<{ shotId: string; segmentIds: string[] }> = [];
  for (let index = 0; index < shots.length; index += 1) {
    const shot = shots[index]!;
    const segmentIds = groups[index] ?? [];
    setShotAudioSegments(p, shot.id, segmentIds);
    output.push({ shotId: shot.id, segmentIds });
  }
  return { bound: output.reduce((sum, item) => sum + item.segmentIds.length, 0), shots: output };
}

export async function audioLineWaveform(p: ProjectContext, ffmpeg: Ffmpeg, lineId: string): Promise<{ relPath: string; url: string }> {
  const line = getAudioLine(p, lineId);
  const asset = getMedia(p, line.assetId);
  const outPath = join(p.paths.cache, 'audio-lines', `${line.id}.png`);
  await ffmpeg.waveformImage(p.resolveProjectPath(asset.fileName), outPath);
  const relPath = relative(p.root, outPath).split(sep).join('/');
  return { relPath, url: `/api/file/${encodeURIComponent(relPath)}` };
}

