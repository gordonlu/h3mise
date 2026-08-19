// Continuity Ledger — PRD §31. Planned vs Actual; only a Selected Take can
// commit Actual Visual Continuity. NarrativeState is story/user fact and is
// never derived from generated video.

import type { ContinuityEntry, NarrativeState, VisualContinuityState } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { j, jgetOrNull } from '../db/sqlite.js';
import { nextId } from '../db/ids.js';
import type { EventBus } from '../events.js';
import { getTake, selectTake } from './takes.js';
import { advanceShotStatus, getShot } from './shots.js';

export function emptyVisualState(): VisualContinuityState {
  return {
    characterStates: {},
    costume: {},
    hair: {},
    injury: {},
    heldItems: {},
    location: '',
    timeOfDay: '',
    weather: '',
    wind: '',
    screenDirection: '',
    facing: '',
    vehicleState: {},
    notes: '',
  };
}

export function emptyNarrativeState(): NarrativeState {
  return { knowledge: [], relationships: [], dramaticState: '', goals: [], knownEvents: [] };
}

interface ContRow {
  id: string;
  shot_id: string;
  scope: string;
  kind: string;
  source_take_id: string | null;
  state_json: string | null;
  narrative_json: string | null;
  committed_at: string;
  created_at: string;
}

export function contFromRow(r: ContRow): ContinuityEntry {
  return {
    id: r.id,
    shotId: r.shot_id,
    scope: r.scope as ContinuityEntry['scope'],
    kind: r.kind as ContinuityEntry['kind'],
    sourceTakeId: r.source_take_id,
    state: r.scope === 'visual' ? jgetOrNull<VisualContinuityState>(r.state_json) : null,
    narrative: r.scope === 'narrative' ? jgetOrNull<NarrativeState>(r.narrative_json) : null,
    committedAt: r.committed_at,
    createdAt: r.created_at,
  };
}

/** Latest committed state per scope/kind (the effective ledger row). */
export function latestContinuity(p: ProjectContext, scope: 'visual' | 'narrative', kind: 'planned' | 'actual'): ContinuityEntry | null {
  const r = p.db.get<ContRow>(
    'SELECT * FROM continuity_entries WHERE scope = ? AND kind = ? ORDER BY committed_at DESC, created_at DESC LIMIT 1',
    [scope, kind],
  );
  return r ? contFromRow(r) : null;
}

export function listContinuity(p: ProjectContext, shotId?: string): ContinuityEntry[] {
  const rows = shotId
    ? p.db.all<ContRow>('SELECT * FROM continuity_entries WHERE shot_id = ? ORDER BY committed_at', [shotId])
    : p.db.all<ContRow>('SELECT * FROM continuity_entries ORDER BY committed_at');
  return rows.map(contFromRow);
}

export function commitContinuity(
  p: ProjectContext,
  input: {
    shotId: string;
    scope: 'visual' | 'narrative';
    kind: 'planned' | 'actual';
    state?: VisualContinuityState;
    narrative?: NarrativeState;
    sourceTakeId?: string | null;
  },
  bus?: EventBus,
): ContinuityEntry {
  if (input.kind === 'actual' && input.scope === 'visual' && input.sourceTakeId) {
    const take = getTake(p, input.sourceTakeId);
    if (take.status !== 'selected') {
      throw new Error('actual visual continuity requires a selected take');
    }
  }
  const id = nextId(p.db, 'cont');
  const now = new Date().toISOString();
  p.db.run(
    'INSERT INTO continuity_entries (id, shot_id, scope, kind, source_take_id, state_json, narrative_json, committed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      input.shotId,
      input.scope,
      input.kind,
      input.sourceTakeId ?? null,
      input.scope === 'visual' ? j(input.state ?? emptyVisualState()) : null,
      input.scope === 'narrative' ? j(input.narrative ?? emptyNarrativeState()) : null,
      now,
      now,
    ],
  );
  bus?.emit({ type: 'continuity.committed', shotId: input.shotId, scope: input.scope });
  if (input.scope === 'visual' && input.kind === 'actual') {
    const shot = getShot(p, input.shotId);
    if (shot.status === 'SELECTED') advanceShotStatus(p, input.shotId, 'CONTINUITY_COMMITTED');
  }
  return contFromRow(p.db.get<ContRow>('SELECT * FROM continuity_entries WHERE id = ?', [id])!);
}

/** Convenience: select take + commit actual visual continuity in one user action. */
export function selectTakeAndCommit(
  p: ProjectContext,
  takeId: string,
  state: VisualContinuityState,
  bus?: EventBus,
): { take: ReturnType<typeof getTake>; entry: ContinuityEntry } {
  const take = selectTake(p, takeId, bus);
  const entry = commitContinuity(
    p,
    { shotId: take.shotId, scope: 'visual', kind: 'actual', state, sourceTakeId: takeId },
    bus,
  );
  return { take, entry };
}
