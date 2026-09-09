// Story module — PRD §7. Story phase saves FACTS (characters, locations,
// beats, state changes), never compiled-to-prompt wholesale.

import type { Sequence, StoryBeat, StoryDoc, StoryEpisode, StoryEpisodeList } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { j, jget } from '../db/sqlite.js';
import { nextId } from '../db/ids.js';

const BEAT_CATEGORIES = new Set(['setup', 'inciting_incident', 'rising_action', 'climax', 'falling_action', 'resolution', 'transition', 'other']);

interface BeatRow {
  id: string;
  sequence_id: string | null;
  ord: number;
  title: string;
  category: string;
  summary: string;
  location: string | null;
  time_of_day: string | null;
  weather: string | null;
  characters_json: string;
  state_change: string;
  notes: string;
  duration_seconds: number;
  created_at: string;
  updated_at: string;
}

function beatFromRow(r: BeatRow): StoryBeat {
  return {
    id: r.id,
    sequenceId: r.sequence_id,
    order: r.ord,
    title: r.title,
    category: r.category as StoryBeat['category'],
    summary: r.summary,
    location: r.location ?? undefined,
    timeOfDay: r.time_of_day ?? undefined,
    weather: r.weather ?? undefined,
    characters: jget<string[]>(r.characters_json, []),
    stateChange: r.state_change,
    notes: r.notes,
    durationSeconds: r.duration_seconds,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const ACTIVE_EPISODE_KEY = 'active_story_id';

export function activeEpisodeId(p: ProjectContext): string {
  const saved = p.db.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', [ACTIVE_EPISODE_KEY])?.value;
  if (saved && p.db.get('SELECT id FROM story WHERE id = ?', [saved])) return saved;
  const first = p.db.get<{ id: string }>('SELECT id FROM story ORDER BY ord, created_at LIMIT 1');
  if (!first) throw new Error('story missing');
  return first.id;
}

function storyFromRow(p: ProjectContext, r: { id: string; title: string; synopsis: string; body: string; planned_duration_seconds: number; created_at: string; updated_at: string }): StoryDoc {
  return {
    id: r.id,
    title: r.title.trim() || p.config.title,
    synopsis: r.synopsis,
    body: r.body,
    plannedDurationSeconds: r.planned_duration_seconds,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listEpisodes(p: ProjectContext): StoryEpisodeList {
  const active = activeEpisodeId(p);
  const rows = p.db.all<{ id: string; title: string; synopsis: string; body: string; planned_duration_seconds: number; ord: number; created_at: string; updated_at: string; beat_count: number; shot_count: number }>(`
    SELECT st.*,
      (SELECT COUNT(*) FROM story_beats b WHERE b.story_id = st.id) AS beat_count,
      (SELECT COUNT(*) FROM shots s WHERE s.story_id = st.id) AS shot_count
    FROM story st ORDER BY st.ord, st.created_at
  `);
  return {
    activeEpisodeId: active,
    episodes: rows.map((row) => ({ ...storyFromRow(p, row), order: row.ord, beatCount: row.beat_count, shotCount: row.shot_count })),
  };
}

export function createEpisode(p: ProjectContext, input: { title?: string } = {}): StoryEpisodeList {
  const order = p.db.get<{ n: number }>('SELECT COALESCE(MAX(ord), 0) + 1 AS n FROM story')!.n;
  const id = nextId(p.db, 'episode');
  const now = new Date().toISOString();
  const title = input.title?.trim() || `第 ${order} 集`;
  p.db.run('INSERT INTO story (id, title, synopsis, body, planned_duration_seconds, ord, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, title, '', '', 0, order, now, now]);
  activateEpisode(p, id);
  return listEpisodes(p);
}

export function activateEpisode(p: ProjectContext, id: string): StoryEpisodeList {
  if (!p.db.get('SELECT id FROM story WHERE id = ?', [id])) throw new Error('episode not found');
  p.db.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [ACTIVE_EPISODE_KEY, id]);
  return listEpisodes(p);
}

export function getStory(p: ProjectContext): StoryDoc {
  const r = p.db.get<{ id: string; title: string; synopsis: string; body: string; planned_duration_seconds: number; created_at: string; updated_at: string }>(
    'SELECT * FROM story WHERE id = ?', [activeEpisodeId(p)],
  );
  if (!r) throw new Error('story missing');
  return storyFromRow(p, r);
}

export function updateStory(p: ProjectContext, patch: Partial<Pick<StoryDoc, 'title' | 'synopsis' | 'body' | 'plannedDurationSeconds'>>): StoryDoc {
  if (patch.plannedDurationSeconds !== undefined && (!Number.isFinite(patch.plannedDurationSeconds) || patch.plannedDurationSeconds < 0)) {
    throw new Error('plannedDurationSeconds must be a non-negative number');
  }
  const now = new Date().toISOString();
  const map: Record<string, string> = {
    title: 'title',
    synopsis: 'synopsis',
    body: 'body',
    plannedDurationSeconds: 'planned_duration_seconds',
  };
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const col = map[k];
    if (!col) continue;
    cols.push(`${col} = ?`);
    vals.push(v);
  }
  if (cols.length === 0) return getStory(p);
  vals.push(now);
  vals.push(activeEpisodeId(p));
  p.db.run(`UPDATE story SET ${cols.join(', ')}, updated_at = ? WHERE id = ?`, vals);
  return getStory(p);
}

// --- Sequences -------------------------------------------------------------

export function listSequences(p: ProjectContext): Sequence[] {
  return p.db.all<Sequence>(
    'SELECT id, title, ord as "order", summary, created_at as createdAt, updated_at as updatedAt FROM sequences WHERE story_id = ? ORDER BY ord', [activeEpisodeId(p)],
  );
}

export function createSequence(p: ProjectContext, input: { title: string; summary?: string }): Sequence {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('sequence title is required');
  const id = nextId(p.db, 'seq');
  const now = new Date().toISOString();
  const storyId = activeEpisodeId(p);
  const ord = p.db.get<{ m: number }>('SELECT COALESCE(MAX(ord), 0) + 1 as m FROM sequences WHERE story_id = ?', [storyId])!.m;
  p.db.run('INSERT INTO sequences (id, story_id, title, ord, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    id,
    storyId,
    input.title,
    ord,
    input.summary ?? '',
    now,
    now,
  ]);
  return listSequences(p).find((s) => s.id === id)!;
}

export function updateSequence(p: ProjectContext, id: string, patch: Partial<Pick<Sequence, 'title' | 'summary' | 'order'>>): Sequence {
  if (patch.title !== undefined && !patch.title.trim()) throw new Error('sequence title is required');
  const now = new Date().toISOString();
  const cols: string[] = [];
  const vals: unknown[] = [];
  const map: Record<string, string> = { title: 'title', summary: 'summary', order: 'ord' };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const col = map[k];
    if (!col) continue;
    cols.push(`${col} = ?`);
    vals.push(v);
  }
  if (cols.length === 0) {
    const current = listSequences(p).find((s) => s.id === id);
    if (!current) throw new Error('sequence not found');
    return current;
  }
  vals.push(now, id);
  p.db.run(`UPDATE sequences SET ${cols.join(', ')}, updated_at = ? WHERE id = ?`, vals);
  return listSequences(p).find((s) => s.id === id)!;
}

export function deleteSequence(p: ProjectContext, id: string): void {
  p.db.run('DELETE FROM sequences WHERE id = ?', [id]);
}

// --- StoryBeats ------------------------------------------------------------

export function listBeats(p: ProjectContext): StoryBeat[] {
  return p.db.all<BeatRow>('SELECT * FROM story_beats WHERE story_id = ? ORDER BY ord', [activeEpisodeId(p)]).map(beatFromRow);
}

export function getBeat(p: ProjectContext, id: string): StoryBeat {
  const r = p.db.get<BeatRow>('SELECT * FROM story_beats WHERE id = ?', [id]);
  if (!r) throw new Error('beat not found');
  return beatFromRow(r);
}

export function createBeat(
  p: ProjectContext,
  input: Partial<Pick<StoryBeat, 'title' | 'category' | 'summary' | 'location' | 'timeOfDay' | 'weather' | 'characters' | 'stateChange' | 'notes' | 'durationSeconds' | 'sequenceId'>>,
): StoryBeat {
  if (input.durationSeconds !== undefined && (!Number.isFinite(input.durationSeconds) || input.durationSeconds < 1 || input.durationSeconds > 15)) throw new Error('beat durationSeconds must be between 1 and 15');
  if (input.category !== undefined && !BEAT_CATEGORIES.has(input.category)) throw new Error('invalid beat category');
  const id = nextId(p.db, 'beat');
  const now = new Date().toISOString();
  const storyId = activeEpisodeId(p);
  const ord = p.db.get<{ m: number }>('SELECT COALESCE(MAX(ord), 0) + 1 as m FROM story_beats WHERE story_id = ?', [storyId])!.m;
  p.db.run(
    `INSERT INTO story_beats (id, story_id, sequence_id, ord, title, category, summary, location, time_of_day, weather, characters_json, state_change, notes, duration_seconds, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      storyId,
      input.sequenceId ?? null,
      ord,
      input.title ?? 'New Beat',
      input.category ?? 'other',
      input.summary ?? '',
      input.location ?? null,
      input.timeOfDay ?? null,
      input.weather ?? null,
      j(input.characters ?? []),
      input.stateChange ?? '',
      input.notes ?? '',
      input.durationSeconds ?? 12,
      now,
      now,
    ],
  );
  return getBeat(p, id);
}

export function updateBeat(p: ProjectContext, id: string, patch: Partial<Omit<StoryBeat, 'id' | 'createdAt' | 'updatedAt'>>): StoryBeat {
  if (patch.durationSeconds !== undefined && (!Number.isFinite(patch.durationSeconds) || patch.durationSeconds < 1 || patch.durationSeconds > 15)) throw new Error('beat durationSeconds must be between 1 and 15');
  if (patch.category !== undefined && !BEAT_CATEGORIES.has(patch.category)) throw new Error('invalid beat category');
  const now = new Date().toISOString();
  const map: Record<string, string> = {
    sequenceId: 'sequence_id',
    order: 'ord',
    title: 'title',
    category: 'category',
    summary: 'summary',
    location: 'location',
    timeOfDay: 'time_of_day',
    weather: 'weather',
    characters: 'characters_json',
    stateChange: 'state_change',
    notes: 'notes',
    durationSeconds: 'duration_seconds',
  };
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const col = map[k];
    if (!col) continue;
    cols.push(`${col} = ?`);
    vals.push(k === 'characters' ? j(v) : v);
  }
  if (cols.length === 0) return getBeat(p, id);
  vals.push(now, id);
  p.db.run(`UPDATE story_beats SET ${cols.join(', ')}, updated_at = ? WHERE id = ?`, vals);
  return getBeat(p, id);
}

export function deleteBeat(p: ProjectContext, id: string): void {
  p.db.run('DELETE FROM story_beats WHERE id = ?', [id]);
}

/** Reorder beats by id list (full reorder). */
export function reorderBeats(p: ProjectContext, ids: string[]): StoryBeat[] {
  p.db.tx(() => {
    ids.forEach((id, i) => p.db.run('UPDATE story_beats SET ord = ? WHERE id = ?', [i, id]));
  });
  return listBeats(p);
}
