// Timeline module — PRD §33. Timeline accepts ONLY selected takes.
// Clips reference shot+take; export trims and concats via ffmpeg.

import { join } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import type { TimelineClip, TimelineDoc } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { j, jget } from '../db/sqlite.js';
import { nextId } from '../db/ids.js';
import type { Ffmpeg } from '../ffmpeg.js';
import { getShot } from './shots.js';
import { getTake } from './takes.js';

interface ClipRow {
  id: string;
  ord: number;
  shot_id: string;
  take_id: string;
  trim_in: number;
  trim_out: number | null;
  transition: string;
  transition_duration: number;
  audio_json: string;
  created_at: string;
  updated_at: string;
}

function clipFromRow(r: ClipRow): TimelineClip {
  return {
    id: r.id,
    order: r.ord,
    shotId: r.shot_id,
    takeId: r.take_id,
    trimIn: r.trim_in,
    trimOut: r.trim_out,
    transition: r.transition as TimelineClip['transition'],
    transitionDuration: r.transition_duration,
    audio: jget<TimelineClip['audio']>(r.audio_json, { volume: 1, mute: false }),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getTimeline(p: ProjectContext): TimelineDoc {
  const row = p.db.get<{ id: string; title: string; updated_at: string }>('SELECT * FROM timeline LIMIT 1');
  if (!row) throw new Error('timeline missing');
  const clips = p.db.all<ClipRow>('SELECT * FROM timeline_clips ORDER BY ord').map(clipFromRow);
  return { id: row.id, title: row.title, clips, updatedAt: row.updated_at };
}

export function addClip(p: ProjectContext, input: { shotId: string; takeId: string; trimIn?: number; trimOut?: number | null }): TimelineClip {
  const take = getTake(p, input.takeId);
  if (take.status !== 'selected') {
    throw new Error('timeline accepts only selected takes');
  }
  if (take.shotId !== input.shotId) throw new Error('take does not belong to shot');
  validateTrim(input.trimIn ?? 0, input.trimOut ?? null, take.duration);
  const id = nextId(p.db, 'clip');
  const now = new Date().toISOString();
  const ord = p.db.get<{ m: number }>('SELECT COALESCE(MAX(ord), 0) + 1 as m FROM timeline_clips')!.m;
  const trimOut = input.trimOut ?? null;
  p.db.run(
    'INSERT INTO timeline_clips (id, ord, shot_id, take_id, trim_in, trim_out, transition, transition_duration, audio_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, ord, input.shotId, input.takeId, input.trimIn ?? 0, trimOut, 'cut', 0, j({ volume: 1, mute: false }), now, now],
  );
  p.db.run('UPDATE timeline SET updated_at = ?', [now]);
  return getTimeline(p).clips.find((c) => c.id === id)!;
}

export function updateClip(p: ProjectContext, id: string, patch: Partial<Pick<TimelineClip, 'trimIn' | 'trimOut' | 'transition' | 'transitionDuration' | 'audio'>>): TimelineClip {
  const current = getTimeline(p).clips.find((c) => c.id === id);
  if (!current) throw new Error('timeline clip not found');
  const take = getTake(p, current.takeId);
  validateTrim(patch.trimIn ?? current.trimIn, patch.trimOut === undefined ? current.trimOut : patch.trimOut, take.duration);
  if (patch.transition !== undefined && !['cut', 'fade', 'dissolve', 'none'].includes(patch.transition)) throw new Error('invalid transition');
  if (patch.transitionDuration !== undefined && (!Number.isFinite(patch.transitionDuration) || patch.transitionDuration < 0)) throw new Error('invalid transitionDuration');
  const colMap: Record<string, string> = {
    trimIn: 'trim_in',
    trimOut: 'trim_out',
    transition: 'transition',
    transitionDuration: 'transition_duration',
    audio: 'audio_json',
  };
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const col = colMap[k];
    if (!col) continue;
    cols.push(`${col} = ?`);
    vals.push(k === 'audio' ? j(v) : v);
  }
  if (cols.length) {
    const now = new Date().toISOString();
    vals.push(now, id);
    p.db.run(`UPDATE timeline_clips SET ${cols.join(', ')}, updated_at = ? WHERE id = ?`, vals);
    p.db.run('UPDATE timeline SET updated_at = ?', [now]);
  }
  return getTimeline(p).clips.find((c) => c.id === id)!;
}

export function removeClip(p: ProjectContext, id: string): void {
  p.db.run('DELETE FROM timeline_clips WHERE id = ?', [id]);
  p.db.run('UPDATE timeline SET updated_at = ?', [new Date().toISOString()]);
}

export function reorderClips(p: ProjectContext, ids: string[]): TimelineClip[] {
  p.db.tx(() => {
    ids.forEach((id, i) => p.db.run('UPDATE timeline_clips SET ord = ? WHERE id = ?', [i, id]));
  });
  p.db.run('UPDATE timeline SET updated_at = ?', [new Date().toISOString()]);
  return getTimeline(p).clips;
}

/** P1: reselecting a take invalidates the shot's old clips (their take is no
 * longer selected, so the timeline must never export them). */
export function invalidateShotClips(p: ProjectContext, shotId: string): number {
  const r = p.db.run('DELETE FROM timeline_clips WHERE shot_id = ?', [shotId]);
  if (Number(r.changes ?? 0) > 0) p.db.run('UPDATE timeline SET updated_at = ?', [new Date().toISOString()]);
  return Number(r.changes ?? 0);
}

export interface TimelineExportResult {
  id: string;
  path: string; // absolute
  relPath: string;
  durationSeconds: number;
  createdAt: string;
}

export interface TimelineExportRecord {
  id: string;
  relPath: string;
  durationSeconds: number;
  createdAt: string;
}

interface TimelineExportRow {
  id: string;
  rel_path: string;
  duration_seconds: number;
  created_at: string;
}

function exportFromRow(row: TimelineExportRow): TimelineExportRecord {
  return { id: row.id, relPath: row.rel_path, durationSeconds: row.duration_seconds, createdAt: row.created_at };
}

export function listTimelineExports(p: ProjectContext): TimelineExportRecord[] {
  return p.db.all<TimelineExportRow>('SELECT * FROM timeline_exports ORDER BY created_at DESC').map(exportFromRow);
}

/** Recover exports created before persistent export records existed. */
export async function recoverTimelineExports(p: ProjectContext): Promise<number> {
  let names: string[];
  try {
    names = (await readdir(p.paths.exports)).filter((name) => name.toLowerCase().endsWith('.mp4'));
  } catch {
    return 0;
  }
  let recovered = 0;
  for (const name of names) {
    const relPath = join('exports', name);
    if (p.db.get<{ id: string }>('SELECT id FROM timeline_exports WHERE rel_path = ?', [relPath])) continue;
    const info = await stat(join(p.paths.exports, name));
    p.db.run(
      'INSERT OR IGNORE INTO timeline_exports (id, rel_path, duration_seconds, created_at) VALUES (?, ?, ?, ?)',
      [nextId(p.db, 'export'), relPath, 0, info.mtime.toISOString()],
    );
    recovered++;
  }
  return recovered;
}

/** Trim + concat selected-take clips into one export. */
export async function exportTimeline(p: ProjectContext, ffmpeg: Ffmpeg, title?: string, onProgress?: (done: number, total: number) => void): Promise<TimelineExportResult> {
  const tl = getTimeline(p);
  if (tl.clips.length === 0) throw new Error('timeline is empty');
  const outName = `${sanitize(title ?? tl.title ?? 'timeline')}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.mp4`;
  const outPath = join(p.paths.exports, outName);
  const clips: string[] = [];
  let total = 0;
  for (const clip of tl.clips) {
    const take = getTake(p, clip.takeId);
    // P1: the timeline only ever exports SELECTED takes. A reselect removes
    // old clips (invalidateShotClips); this assert is the second net.
    if (take.status !== 'selected') {
      throw new Error(`clip ${clip.id}: take ${clip.takeId} is no longer selected — reselect the shot and re-add the clip`);
    }
    const abs = p.resolveProjectPath(take.localVideoPath);
    const trimOut = clip.trimOut ?? take.duration;
    if (trimOut - clip.trimIn < 0.1) throw new Error(`clip ${clip.id}: invalid trim`);
    const tmp = join(p.paths.cache, `clip-${clip.id}.mp4`);
    await ffmpeg.trim(abs, tmp, clip.trimIn, trimOut, { audio: clip.audio, ensureAudio: true });
    clips.push(tmp);
    total += trimOut - clip.trimIn;
    onProgress?.(clips.length, tl.clips.length);
  }
  const transitions = tl.clips.slice(1).map((clip, index) => {
    const previousDuration = (tl.clips[index]!.trimOut ?? getTake(p, tl.clips[index]!.takeId).duration) - tl.clips[index]!.trimIn;
    const nextDuration = (clip.trimOut ?? getTake(p, clip.takeId).duration) - clip.trimIn;
    const duration = clip.transition === 'cut' || clip.transition === 'none'
      ? 0
      : Math.min(Math.max(0, clip.transitionDuration), previousDuration / 2, nextDuration / 2);
    return { type: clip.transition, duration };
  });
  await ffmpeg.concat(clips, outPath, { transitions });
  const overlap = transitions.reduce((sum, transition) => sum + transition.duration, 0);
  const relPath = outPath.slice(p.root.length + 1);
  const durationSeconds = Math.max(0, total - overlap);
  const id = nextId(p.db, 'export');
  const createdAt = new Date().toISOString();
  p.db.run(
    'INSERT INTO timeline_exports (id, rel_path, duration_seconds, created_at) VALUES (?, ?, ?, ?)',
    [id, relPath, durationSeconds, createdAt],
  );
  return { id, path: outPath, relPath, durationSeconds, createdAt };
}

function validateTrim(trimIn: number, trimOut: number | null, duration: number): void {
  if (!Number.isFinite(trimIn) || trimIn < 0 || trimIn >= duration) throw new Error('invalid trimIn');
  if (trimOut !== null && (!Number.isFinite(trimOut) || trimOut > duration || trimOut - trimIn < 0.1)) throw new Error('invalid trimOut');
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, '-').slice(0, 60) || 'timeline';
}

export function shotSelectedTake(p: ProjectContext, shotId: string) {
  const t = p.db.get<{ id: string }>("SELECT id FROM takes WHERE shot_id = ? AND status = 'selected' ORDER BY created_at DESC LIMIT 1", [shotId]);
  return t ? getTake(p, t.id) : null;
}
