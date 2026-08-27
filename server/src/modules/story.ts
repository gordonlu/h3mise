// Story module — PRD §7. Story phase saves FACTS (characters, locations,
// beats, state changes), never compiled-to-prompt wholesale.

import type { Sequence, StoryBeat, StoryDoc } from '@h3mise/shared';
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

export function getStory(p: ProjectContext): StoryDoc {
  const r = p.db.get<{ id: string; title: string; synopsis: string; body: string; planned_duration_seconds: number; created_at: string; updated_at: string }>(
    'SELECT * FROM story LIMIT 1',
  );
  if (!r) throw new Error('story missing');
  return {
    id: r.id,
    // Older projects were initialized with an empty story title. Preserve an
    // explicitly edited story title, otherwise inherit the project title so
    // users never have to type the same title twice.
    title: r.title.trim() || p.config.title,
    synopsis: r.synopsis,
    body: r.body,
    plannedDurationSeconds: r.planned_duration_seconds,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
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
  p.db.run(`UPDATE story SET ${cols.join(', ')}, updated_at = ? WHERE id = (SELECT id FROM story LIMIT 1)`, vals);
  return getStory(p);
}

// --- Sequences -------------------------------------------------------------

export function listSequences(p: ProjectContext): Sequence[] {
  return p.db.all<Sequence>(
    'SELECT id, title, ord as "order", summary, created_at as createdAt, updated_at as updatedAt FROM sequences ORDER BY ord',
  );
}

export function createSequence(p: ProjectContext, input: { title: string; summary?: string }): Sequence {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('sequence title is required');
  const id = nextId(p.db, 'seq');
  const now = new Date().toISOString();
  const ord = p.db.get<{ m: number }>('SELECT COALESCE(MAX(ord), 0) + 1 as m FROM sequences')!.m;
  p.db.run('INSERT INTO sequences (id, title, ord, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
    id,
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
  return p.db.all<BeatRow>('SELECT * FROM story_beats ORDER BY ord').map(beatFromRow);
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
  if (input.durationSeconds !== undefined && (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0)) throw new Error('beat durationSeconds must be positive');
  if (input.category !== undefined && !BEAT_CATEGORIES.has(input.category)) throw new Error('invalid beat category');
  const id = nextId(p.db, 'beat');
  const now = new Date().toISOString();
  const ord = p.db.get<{ m: number }>('SELECT COALESCE(MAX(ord), 0) + 1 as m FROM story_beats')!.m;
  p.db.run(
    `INSERT INTO story_beats (id, sequence_id, ord, title, category, summary, location, time_of_day, weather, characters_json, state_change, notes, duration_seconds, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
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
      input.durationSeconds ?? 5,
      now,
      now,
    ],
  );
  return getBeat(p, id);
}

export function updateBeat(p: ProjectContext, id: string, patch: Partial<Omit<StoryBeat, 'id' | 'createdAt' | 'updatedAt'>>): StoryBeat {
  if (patch.durationSeconds !== undefined && (!Number.isFinite(patch.durationSeconds) || patch.durationSeconds <= 0)) throw new Error('beat durationSeconds must be positive');
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
