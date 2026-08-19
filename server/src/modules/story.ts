// Story module — PRD §7. Story phase saves FACTS (characters, locations,
// beats, state changes), never compiled-to-prompt wholesale.

import type { Sequence, StoryBeat, StoryDoc } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { j, jget } from '../db/sqlite.js';
import { nextId } from '../db/ids.js';

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
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function getStory(p: ProjectContext): StoryDoc {
  const r = p.db.get<{ id: string; title: string; logline: string; synopsis: string; body: string; created_at: string; updated_at: string }>(
    'SELECT * FROM story LIMIT 1',
  );
  if (!r) throw new Error('story missing');
  return {
    id: r.id,
    title: r.title,
    logline: r.logline,
    synopsis: r.synopsis,
    body: r.body,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function updateStory(p: ProjectContext, patch: Partial<Pick<StoryDoc, 'title' | 'logline' | 'synopsis' | 'body'>>): StoryDoc {
  const now = new Date().toISOString();
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    cols.push(`${k} = ?`);
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
  const now = new Date().toISOString();
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    cols.push(k === 'order' ? 'ord = ?' : `${k} = ?`);
    vals.push(v);
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
  input: Partial<Pick<StoryBeat, 'title' | 'category' | 'summary' | 'location' | 'timeOfDay' | 'weather' | 'characters' | 'stateChange' | 'notes' | 'sequenceId'>>,
): StoryBeat {
  const id = nextId(p.db, 'beat');
  const now = new Date().toISOString();
  const ord = p.db.get<{ m: number }>('SELECT COALESCE(MAX(ord), 0) + 1 as m FROM story_beats')!.m;
  p.db.run(
    `INSERT INTO story_beats (id, sequence_id, ord, title, category, summary, location, time_of_day, weather, characters_json, state_change, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      now,
      now,
    ],
  );
  return getBeat(p, id);
}

export function updateBeat(p: ProjectContext, id: string, patch: Partial<Omit<StoryBeat, 'id' | 'createdAt' | 'updatedAt'>>): StoryBeat {
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
