// Shot module — PRD §8-10. Shot is the first-class citizen; state machine with
// limited rollback. Status advances only through allowed transitions.

import type { H3Mode, Shot, ShotStatus } from '@h3mise/shared';
import { SHOT_STATUS_ORDER } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { nextId } from '../db/ids.js';
import { unlink } from 'node:fs/promises';

const SHOT_FUNCTIONS = new Set(['establishing', 'wide', 'medium', 'closeup', 'insert', 'reaction', 'action', 'transition', 'montage', 'pov', 'aerial', 'dialogue', 'other']);
const H3_MODES = new Set(['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va']);

function validateShotPatch(input: CreateShotInput): void {
  if (input.durationSeconds !== undefined && (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0)) {
    throw new Error('shot durationSeconds must be a positive number');
  }
  if (input.shotFunction !== undefined && !SHOT_FUNCTIONS.has(input.shotFunction)) throw new Error('invalid shotFunction');
  if (input.h3Mode !== undefined && input.h3Mode !== null && !H3_MODES.has(input.h3Mode)) throw new Error('invalid h3Mode');
  if (input.aspectRatio !== undefined && !/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(input.aspectRatio)) throw new Error('invalid aspectRatio');
}

interface ShotRow {
  id: string;
  sequence_id: string | null;
  ord: number;
  title: string;
  story_beat_id: string | null;
  purpose: string;
  shot_function: string;
  duration_seconds: number;
  status: string;
  aspect_ratio: string;
  h3_mode: string | null;
  primary_character_id: string | null;
  scene_id: string | null;
  created_at: string;
  updated_at: string;
}

function shotFromRow(r: ShotRow): Shot {
  return {
    id: r.id,
    sequenceId: r.sequence_id,
    order: r.ord,
    title: r.title,
    storyBeatId: r.story_beat_id,
    purpose: r.purpose,
    shotFunction: r.shot_function as Shot['shotFunction'],
    durationSeconds: r.duration_seconds,
    status: r.status as ShotStatus,
    aspectRatio: r.aspect_ratio,
    h3Mode: (r.h3_mode as H3Mode | null) ?? null,
    primaryCharacterId: r.primary_character_id,
    sceneId: r.scene_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listShots(p: ProjectContext): Shot[] {
  return p.db.all<ShotRow>('SELECT * FROM shots ORDER BY ord').map(shotFromRow);
}

export function getShot(p: ProjectContext, id: string): Shot {
  const r = p.db.get<ShotRow>('SELECT * FROM shots WHERE id = ?', [id]);
  if (!r) throw new Error('shot not found');
  return shotFromRow(r);
}

export interface CreateShotInput {
  title?: string;
  sequenceId?: string | null;
  storyBeatId?: string | null;
  purpose?: string;
  shotFunction?: Shot['shotFunction'];
  durationSeconds?: number;
  aspectRatio?: string;
  h3Mode?: H3Mode | null;
  primaryCharacterId?: string | null;
  sceneId?: string | null;
  order?: number;
}

export function createShot(p: ProjectContext, input: CreateShotInput = {}): Shot {
  validateShotPatch(input);
  const id = nextId(p.db, 'shot');
  const now = new Date().toISOString();
  const ord = input.order ?? p.db.get<{ m: number }>('SELECT COALESCE(MAX(ord), 0) + 1 as m FROM shots')!.m;
  p.db.run(
    `INSERT INTO shots (id, sequence_id, ord, title, story_beat_id, purpose, shot_function, duration_seconds, status, aspect_ratio, h3_mode, primary_character_id, scene_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.sequenceId ?? null,
      ord,
      input.title ?? `Shot ${String(ord).padStart(3, '0')}`,
      input.storyBeatId ?? null,
      input.purpose ?? '',
      input.shotFunction ?? 'other',
      input.durationSeconds ?? p.config.default_duration_seconds,
      input.aspectRatio ?? p.config.default_aspect_ratio,
      input.h3Mode ?? null,
      input.primaryCharacterId ?? null,
      input.sceneId ?? null,
      now,
      now,
    ],
  );
  return getShot(p, id);
}

/** Status machine per PRD §10, with limited rollback. */
const FORWARD: Record<ShotStatus, ShotStatus[]> = {
  DRAFT: ['PLANNED'],
  PLANNED: ['ASSETS_READY', 'DIRECTED', 'PREFLIGHT_READY', 'DRAFT'],
  ASSETS_READY: ['DIRECTED', 'PREFLIGHT_READY', 'PLANNED'],
  DIRECTED: ['PREFLIGHT_READY', 'PLANNED'],
  PREFLIGHT_READY: ['RENDERING', 'DIRECTED'],
  RENDERING: ['HAS_TAKES', 'PREFLIGHT_READY'],
  HAS_TAKES: ['SELECTED', 'PREFLIGHT_READY', 'RENDERING'],
  SELECTED: ['CONTINUITY_COMMITTED', 'HAS_TAKES', 'RENDERING'],
  CONTINUITY_COMMITTED: ['LOCKED', 'SELECTED', 'RENDERING'],
  LOCKED: ['CONTINUITY_COMMITTED', 'SELECTED', 'RENDERING'],
};

const CAN_GO_BACK: Record<ShotStatus, ShotStatus[]> = {
  DRAFT: [],
  PLANNED: ['DRAFT'],
  ASSETS_READY: ['PLANNED', 'DRAFT'],
  DIRECTED: ['ASSETS_READY', 'PLANNED', 'DRAFT'],
  PREFLIGHT_READY: ['DIRECTED', 'ASSETS_READY', 'PLANNED', 'DRAFT'],
  RENDERING: ['PREFLIGHT_READY', 'DIRECTED', 'PLANNED', 'DRAFT'],
  HAS_TAKES: ['RENDERING', 'PREFLIGHT_READY'],
  SELECTED: ['HAS_TAKES', 'RENDERING'],
  CONTINUITY_COMMITTED: ['SELECTED', 'HAS_TAKES'],
  LOCKED: ['CONTINUITY_COMMITTED', 'SELECTED'],
};

export function advanceShotStatus(p: ProjectContext, id: string, target: ShotStatus): Shot {
  const shot = getShot(p, id);
  const allowed = FORWARD[shot.status] ?? [];
  const back = CAN_GO_BACK[shot.status] ?? [];
  const current = SHOT_STATUS_ORDER[shot.status];
  const t = SHOT_STATUS_ORDER[target];
  if (!(allowed.includes(target) || back.includes(target) || t === current)) {
    throw new Error(`invalid status transition ${shot.status} -> ${target}`);
  }
  const now = new Date().toISOString();
  p.db.run('UPDATE shots SET status = ?, updated_at = ? WHERE id = ?', [target, now, id]);
  return getShot(p, id);
}

/** Find a path to `target` over forward edges (falling back to the allowed
 * limited rollback edges), then walk it step by step. */
export function advanceTo(p: ProjectContext, id: string, target: ShotStatus): Shot {
  let shot = getShot(p, id);
  if (shot.status === target) return shot;
  // BFS over forward+rollback edges.
  const queue: ShotStatus[] = [shot.status];
  const prev = new Map<ShotStatus, ShotStatus>();
  const seen = new Set<ShotStatus>([shot.status]);
  let found = false;
  while (queue.length) {
    const cur = queue.shift()!;
    const nexts = [...(FORWARD[cur] ?? []), ...(CAN_GO_BACK[cur] ?? [])];
    for (const n of nexts) {
      if (seen.has(n)) continue;
      seen.add(n);
      prev.set(n, cur);
      if (n === target) {
        found = true;
        queue.length = 0;
        break;
      }
      queue.push(n);
    }
  }
  if (!found) throw new Error(`no path ${shot.status} -> ${target}`);
  const path: ShotStatus[] = [target];
  let cur = target;
  while (prev.get(cur) !== undefined && prev.get(cur) !== shot.status) {
    cur = prev.get(cur)!;
    path.unshift(cur);
  }
  for (const step of path) {
    shot = advanceShotStatus(p, id, step);
  }
  return shot;
}

export function updateShot(p: ProjectContext, id: string, patch: Partial<Omit<Shot, 'id' | 'createdAt' | 'updatedAt' | 'status'>>): Shot {
  validateShotPatch(patch);
  const now = new Date().toISOString();
  const map: Record<string, string> = {
    sequenceId: 'sequence_id',
    order: 'ord',
    title: 'title',
    storyBeatId: 'story_beat_id',
    purpose: 'purpose',
    shotFunction: 'shot_function',
    durationSeconds: 'duration_seconds',
    aspectRatio: 'aspect_ratio',
    h3Mode: 'h3_mode',
    primaryCharacterId: 'primary_character_id',
    sceneId: 'scene_id',
  };
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const col = map[k];
    if (!col) continue;
    cols.push(`${col} = ?`);
    vals.push(v === null ? null : v);
  }
  if (cols.length === 0) return getShot(p, id);
  vals.push(now, id);
  p.db.run(`UPDATE shots SET ${cols.join(', ')}, updated_at = ? WHERE id = ?`, vals);
  return getShot(p, id);
}

export function deleteShot(p: ProjectContext, id: string): void {
  p.db.run('DELETE FROM shots WHERE id = ?', [id]);
}

/** Delete a shot and clean files that are owned only by its Takes. Frame assets
 * referenced by another shot are deliberately retained for Frame Bridge. */
export async function deleteShotAndFiles(p: ProjectContext, id: string): Promise<void> {
  getShot(p, id);
  const takes = p.db.all<{ local_video_path: string; poster_path: string | null; first_frame_path: string | null; last_frame_path: string | null }>(
    'SELECT local_video_path, poster_path, first_frame_path, last_frame_path FROM takes WHERE shot_id = ?',
    [id],
  );
  const paths = new Set<string>();
  for (const take of takes) {
    paths.add(take.local_video_path);
    if (take.poster_path) paths.add(take.poster_path);
    for (const framePath of [take.first_frame_path, take.last_frame_path]) {
      if (!framePath) continue;
      const media = p.db.get<{ id: string }>('SELECT id FROM media_assets WHERE file_name = ?', [framePath]);
      const externalRefs = media
        ? (p.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reference_bindings WHERE asset_id = ? AND shot_id IS NOT ?', [media.id, id])?.n ?? 0)
        : 0;
      if (externalRefs === 0) {
        paths.add(framePath);
        if (media) p.db.run('DELETE FROM media_assets WHERE id = ?', [media.id]);
      }
    }
  }
  deleteShot(p, id);
  await Promise.all([...paths].map(async (path) => {
    try {
      await unlink(p.resolveProjectPath(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[shots] failed to remove ${path}:`, error);
    }
  }));
}

export function reorderShots(p: ProjectContext, ids: string[]): Shot[] {
  p.db.tx(() => {
    ids.forEach((id, i) => p.db.run('UPDATE shots SET ord = ? WHERE id = ?', [i, id]));
  });
  return listShots(p);
}

/** Create N shots from a shot list (paste from external AI / manual). */
export function bulkCreateShots(
  p: ProjectContext,
  items: Array<{
    title?: string;
    purpose?: string;
    shotFunction?: Shot['shotFunction'];
    durationSeconds?: number;
    h3Mode?: H3Mode | null;
  }>,
): Shot[] {
  const out: Shot[] = [];
  p.db.tx(() => {
    for (const item of items) out.push(createShot(p, item));
  });
  return out;
}
