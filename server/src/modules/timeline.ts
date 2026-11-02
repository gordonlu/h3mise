// Timeline module — PRD §33. Timeline accepts ONLY selected takes.
// Clips reference shot+take; export trims and concats via ffmpeg.

import { join, relative, sep } from 'node:path';
import { readdir, rm, stat } from 'node:fs/promises';
import { effectiveTransitionDuration, effectiveTransitions, isHardTransition, isTimelineLook, timelineClipDuration, timelineDurationSeconds } from '@h3mise/shared';
import type { TimelineClip, TimelineDoc, TimelineLookId } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { j, jget } from '../db/sqlite.js';
import { nextId } from '../db/ids.js';
import type { Ffmpeg } from '../ffmpeg.js';
import { getShot } from './shots.js';
import { getMedia } from './assets.js';
import { timelineLookFilters } from './timeline-looks.js';
import { getTake } from './takes.js';
import { activeEpisodeId } from './story.js';

interface ClipRow {
  id: string;
  ord: number;
  shot_id: string;
  take_id: string;
  trim_in: number;
  trim_out: number | null;
  transition: string;
  transition_duration: number;
  look: string;
  audio_json: string;
  created_at: string;
  updated_at: string;
}

function clipFromRow(r: ClipRow): TimelineClip {
  const storedAudio = jget<Partial<TimelineClip['audio']>>(r.audio_json, {});
  return {
    id: r.id,
    order: r.ord,
    shotId: r.shot_id,
    takeId: r.take_id,
    trimIn: r.trim_in,
    trimOut: r.trim_out,
    transition: r.transition as TimelineClip['transition'],
    transitionDuration: r.transition_duration,
    look: isTimelineLook(r.look) ? r.look : 'none',
    audio: {
      volume: typeof storedAudio.volume === 'number' && Number.isFinite(storedAudio.volume) ? storedAudio.volume : 1,
      mute: storedAudio.mute === true,
      // Backward compatible: timelines created before this field existed get
      // the safe dialogue-oriented export default.
      normalize: storedAudio.normalize !== false,
    },
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getTimeline(p: ProjectContext): TimelineDoc {
  const row = p.db.get<{ id: string; title: string; updated_at: string; master_audio_line_id: string | null }>('SELECT * FROM timeline LIMIT 1');
  if (!row) throw new Error('timeline missing');
  const clips = p.db.all<ClipRow>(
    'SELECT tc.* FROM timeline_clips tc JOIN shots s ON s.id = tc.shot_id WHERE s.story_id = ? ORDER BY tc.ord',
    [activeEpisodeId(p)],
  ).map(clipFromRow);
  return { id: row.id, title: row.title, clips, masterAudioLineId: row.master_audio_line_id ?? null, updatedAt: row.updated_at };
}

/** Choose a project master audio line for the final mix; null restores Take audio. */
export function setTimelineMasterAudio(p: ProjectContext, lineId: string | null): TimelineDoc {
  if (lineId !== null) {
    const exists = p.db.get<{ id: string }>('SELECT id FROM audio_lines WHERE id = ?', [lineId]);
    if (!exists) throw new Error('audio line not found');
  }
  p.db.run('UPDATE timeline SET master_audio_line_id = ?, updated_at = ?', [lineId, new Date().toISOString()]);
  return getTimeline(p);
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
  const ord = p.db.get<{ m: number }>('SELECT COALESCE(MAX(tc.ord), 0) + 1 as m FROM timeline_clips tc JOIN shots s ON s.id = tc.shot_id WHERE s.story_id = ?', [activeEpisodeId(p)])!.m;
  const trimOut = input.trimOut ?? null;
  p.db.run(
    'INSERT INTO timeline_clips (id, ord, shot_id, take_id, trim_in, trim_out, transition, transition_duration, look, audio_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, ord, input.shotId, input.takeId, input.trimIn ?? 0, trimOut, 'cut', 0, 'none', j({ volume: 1, mute: false, normalize: true }), now, now],
  );
  p.db.run('UPDATE timeline SET updated_at = ?', [now]);
  return getTimeline(p).clips.find((c) => c.id === id)!;
}

/** Beginner-path helper: append selected takes that are not on the timeline.
 * Existing clips, order, trims, transitions and audio settings are untouched,
 * so switching between Quick Edit and the professional Timeline is lossless. */
export function addMissingSelectedTakes(p: ProjectContext): { clips: TimelineClip[]; added: number } {
  const selected = p.db.all<{ shot_id: string; take_id: string }>(`
    SELECT s.id AS shot_id, t.id AS take_id
    FROM shots s
    JOIN takes t ON t.shot_id = s.id AND t.status = 'selected'
    WHERE s.story_id = ?
    ORDER BY s.ord
  `, [activeEpisodeId(p)]);
  const existingShotIds = new Set(getTimeline(p).clips.map((clip) => clip.shotId));
  let added = 0;
  for (const item of selected) {
    if (existingShotIds.has(item.shot_id)) continue;
    addClip(p, { shotId: item.shot_id, takeId: item.take_id });
    existingShotIds.add(item.shot_id);
    added++;
  }
  return { clips: getTimeline(p).clips, added };
}

export function updateClip(p: ProjectContext, id: string, patch: Partial<Pick<TimelineClip, 'trimIn' | 'trimOut' | 'transition' | 'transitionDuration' | 'look' | 'audio'>>): TimelineClip {
  const clips = getTimeline(p).clips;
  const index = clips.findIndex((c) => c.id === id);
  const current = clips[index];
  if (!current) throw new Error('timeline clip not found');
  const take = getTake(p, current.takeId);
  const nextTrimIn = patch.trimIn ?? current.trimIn;
  const nextTrimOut = patch.trimOut === undefined ? current.trimOut : patch.trimOut;
  validateTrim(nextTrimIn, nextTrimOut, take.duration);
  if (patch.transition !== undefined && !['cut', 'fade', 'dissolve', 'none'].includes(patch.transition)) throw new Error('invalid transition');
  if (patch.transitionDuration !== undefined && (!Number.isFinite(patch.transitionDuration) || patch.transitionDuration < 0)) throw new Error('invalid transitionDuration');
  if (patch.look !== undefined && !isTimelineLook(patch.look)) throw new Error('invalid look');
  if (patch.audio !== undefined) {
    if (!Number.isFinite(patch.audio.volume) || patch.audio.volume < 0 || patch.audio.volume > 2) throw new Error('invalid audio volume');
    if (typeof patch.audio.mute !== 'boolean' || typeof patch.audio.normalize !== 'boolean') throw new Error('invalid audio settings');
  }
  // Keep the stored transition within what both neighbours can absorb. This
  // also re-clamps an existing transition when a trim shortens its clip, so
  // the UI and every duration calculation agree with the exported film.
  const previous = index > 0 ? clips[index - 1] : null;
  const previousDuration = previous
    ? timelineClipDuration(previous, getTake(p, previous.takeId).duration)
    : 0;
  const currentDuration = timelineClipDuration({
    ...current,
    trimIn: nextTrimIn,
    trimOut: nextTrimOut,
  }, take.duration);
  const nextTransition = patch.transition ?? current.transition;
  const requestedTransitionDuration = patch.transitionDuration
    ?? (patch.transition !== undefined && !isHardTransition(patch.transition) && isHardTransition(current.transition)
      ? 0.5
      : current.transitionDuration);
  const effectiveDuration = effectiveTransitionDuration(
    nextTransition,
    requestedTransitionDuration,
    previousDuration,
    currentDuration,
  );
  const effectivePatch: typeof patch = {
    ...patch,
    ...(patch.transition !== undefined || patch.transitionDuration !== undefined || patch.trimIn !== undefined || patch.trimOut !== undefined
      ? { transitionDuration: effectiveDuration }
      : {}),
  };
  const colMap: Record<string, string> = {
    trimIn: 'trim_in',
    trimOut: 'trim_out',
    transition: 'transition',
    transitionDuration: 'transition_duration',
    look: 'look',
    audio: 'audio_json',
  };
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(effectivePatch)) {
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

/** Apply one look to every clip in the active episode. */
export function setTimelineLook(p: ProjectContext, raw: unknown): TimelineClip[] {
  if (!isTimelineLook(raw)) throw new Error('invalid look');
  const now = new Date().toISOString();
  p.db.run(
    'UPDATE timeline_clips SET look = ?, updated_at = ? WHERE shot_id IN (SELECT id FROM shots WHERE story_id = ?)',
    [raw, now, activeEpisodeId(p)],
  );
  p.db.run('UPDATE timeline SET updated_at = ?', [now]);
  return getTimeline(p).clips;
}

export interface TimelineLookPreview {
  clipId: string;
  look: TimelineLookId;
  timeSeconds: number;
  relPath: string;
}

/** Local still-frame preview of a look. No provider call and no new Take. */
export async function renderLookPreview(
  p: ProjectContext,
  ffmpeg: Ffmpeg,
  clipId: string,
  lookRaw?: unknown,
  timeRaw?: unknown,
): Promise<TimelineLookPreview> {
  const clip = getTimeline(p).clips.find((item) => item.id === clipId);
  if (!clip) throw new Error('timeline clip not found');
  if (lookRaw !== undefined && !isTimelineLook(lookRaw)) throw new Error('invalid look');
  const look = lookRaw === undefined ? clip.look : lookRaw;
  const take = getTake(p, clip.takeId);
  const abs = p.resolveProjectPath(take.localVideoPath);
  const start = clip.trimIn;
  const end = clip.trimOut ?? take.duration;
  const requested = Number(timeRaw);
  const timeSeconds = Number.isFinite(requested)
    ? Math.min(Math.max(start, requested), Math.max(start, end - 0.05))
    : (start + end) / 2;
  const outPath = join(
    p.paths.cache,
    'look-previews',
    `${clip.id}-${look}-${timeSeconds.toFixed(1).replace('.', '_')}.jpg`,
  );
  await ffmpeg.previewFrame(abs, outPath, timeSeconds, timelineLookFilters(look));
  return {
    clipId,
    look,
    timeSeconds,
    relPath: relative(p.root, outPath).split(sep).join('/'),
  };
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
    // Forward slashes: stored rel paths must be OS-independent.
    const relPath = `exports/${name}`;
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
  // Milliseconds prevent rapid repeat exports (for example one-click reruns)
  // from colliding with the UNIQUE persisted rel_path in the same second.
  const outName = `${sanitize(title ?? tl.title ?? 'timeline')}-${new Date().toISOString().slice(0, 23).replace(/[:T.]/g, '-')}.mp4`;
  const outPath = join(p.paths.exports, outName);
  const clips: string[] = [];
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
    await ffmpeg.trim(abs, tmp, clip.trimIn, trimOut, {
      audio: clip.audio,
      ensureAudio: true,
      videoFilters: timelineLookFilters(clip.look),
    });
    clips.push(tmp);
    onProgress?.(clips.length, tl.clips.length);
  }
  const transitions = effectiveTransitions(tl.clips, (clip) => getTake(p, clip.takeId).duration).map((transition) => ({
    type: transition.type,
    duration: transition.duration,
  }));
  const masterLineId = tl.masterAudioLineId;
  const concatPath = masterLineId ? `${outPath}.video.mp4` : outPath;
  await ffmpeg.concat(clips, concatPath, { transitions });
  const durationSeconds = timelineDurationSeconds(tl.clips, (clip) => getTake(p, clip.takeId).duration);
  if (masterLineId) {
    try {
      const line = p.db.get<{ asset_id: string; offset_seconds: number }>('SELECT asset_id, offset_seconds FROM audio_lines WHERE id = ?', [masterLineId]);
      if (!line) throw new Error('timeline master audio line no longer exists');
      const asset = getMedia(p, line.asset_id);
      await ffmpeg.replaceAudio(
        concatPath,
        p.resolveProjectPath(asset.fileName),
        outPath,
        durationSeconds,
        Math.max(0, line.offset_seconds),
      );
    } finally {
      await rm(concatPath, { force: true });
    }
  }
  // Forward slashes: stored rel paths must be OS-independent.
  const relPath = relative(p.root, outPath).split(sep).join('/');
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
