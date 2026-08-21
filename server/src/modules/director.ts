// Director module — PRD §12-13. DirectorPlan versions are immutable:
// editing always creates a new version (never overwrites history).

import type { DirectorPlan, DirectorPlanVersion } from '@h3mise/shared';
import { emptyDirectorPlan } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { j, jget } from '../db/sqlite.js';
import { nextId } from '../db/ids.js';
import YAML from 'yaml';

interface DpvRow {
  id: string;
  shot_id: string;
  version: number;
  plan_json: string;
  source: string;
  created_at: string;
}

function dpvFromRow(r: DpvRow): DirectorPlanVersion {
  return {
    id: r.id,
    shotId: r.shot_id,
    version: r.version,
    plan: jget<DirectorPlan>(r.plan_json, emptyDirectorPlan()),
    source: r.source as DirectorPlanVersion['source'],
    createdAt: r.created_at,
  };
}

export function listPlanVersions(p: ProjectContext, shotId: string): DirectorPlanVersion[] {
  return p.db.all<DpvRow>('SELECT * FROM director_plan_versions WHERE shot_id = ? ORDER BY version', [shotId]).map(dpvFromRow);
}

export function latestPlan(p: ProjectContext, shotId: string): DirectorPlanVersion | null {
  const r = p.db.get<DpvRow>('SELECT * FROM director_plan_versions WHERE shot_id = ? ORDER BY version DESC LIMIT 1', [shotId]);
  return r ? dpvFromRow(r) : null;
}

export function getPlanVersion(p: ProjectContext, id: string): DirectorPlanVersion {
  const r = p.db.get<DpvRow>('SELECT * FROM director_plan_versions WHERE id = ?', [id]);
  if (!r) throw new Error('director plan version not found');
  return dpvFromRow(r);
}

export function createPlanVersion(
  p: ProjectContext,
  input: { shotId: string; plan: DirectorPlan; source: DirectorPlanVersion['source'] },
): DirectorPlanVersion {
  const latest = latestPlan(p, input.shotId);
  const version = (latest?.version ?? 0) + 1;
  const id = nextId(p.db, 'dpv');
  const now = new Date().toISOString();
  const plan = { ...input.plan, version };
  p.db.run('INSERT INTO director_plan_versions (id, shot_id, version, plan_json, source, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    id,
    input.shotId,
    version,
    j(plan),
    input.source,
    now,
  ]);
  // Keep the shot's directed status when a real plan exists.
  const shot = p.db.get<{ status: string }>('SELECT status FROM shots WHERE id = ?', [input.shotId]);
  if (shot && shot.status === 'DRAFT' && planHasContent(plan)) {
    p.db.run("UPDATE shots SET status = 'PLANNED', updated_at = ? WHERE id = ?", [now, input.shotId]);
  }
  return getPlanVersion(p, id);
}

export function planHasContent(plan: DirectorPlan): boolean {
  return Boolean(
    plan.intent.visualThesis ||
      plan.intent.dramaticGoal ||
      plan.subject.primarySubject ||
      plan.subject.action ||
      plan.camera.dominantBehavior ||
      plan.environment.location,
  );
}

/** The four facts the Guided View requires before it considers shot design
 * complete. Advanced DirectorPlan fields remain optional. */
export function planIsGuideReady(plan: DirectorPlan): boolean {
  return [
    plan.intent.visualThesis,
    plan.subject.action,
    plan.camera.dominantBehavior,
    plan.intent.endState,
  ].every((value) => value.trim().length > 0);
}

/** Raw plan text parsing (YAML/JSON from external AI) — PRD §21. */
export function parseDirectorPlanText(text: string): { ok: boolean; plan?: DirectorPlan; error?: string } {
  const trimmed = text.trim();
  const parse = (obj: unknown): { ok: boolean; plan?: DirectorPlan; error?: string } => {
    if (typeof obj !== 'object' || obj === null) return { ok: false, error: 'not an object' };
    const base = emptyDirectorPlan();
    // P1: recursive snake_case → camelCase conversion. Previously only
    // reality/movementQuality/generation/continuity were normalized; other
    // sections (camera/performance/environment/…) kept snake_case keys, so
    // applied plans silently lost data the compiler reads as camelCase.
    const deep = <T>(src: unknown, dst: T): T => {
      if (typeof src !== 'object' || src === null) return dst;
      for (const k of Object.keys(src as Record<string, unknown>)) {
        const v = (src as Record<string, unknown>)[k];
        if (v === null || v === undefined) continue;
        const key = k.replace(/[_-]([a-z])/g, (_, c: string) => c.toUpperCase());
        if (typeof v === 'object' && !Array.isArray(v)) {
          const target = (dst as Record<string, unknown>)[key];
          if (target !== undefined && typeof target === 'object' && target !== null) {
            // Merge into the known default structure (recursive normalize).
            deep(v, target as never);
          } else {
            // Arbitrary nested section: normalize keys recursively.
            (dst as Record<string, unknown>)[key] = deep(v, {} as never);
          }
        } else if (Array.isArray(v)) {
          (dst as Record<string, unknown>)[key] = v.map((item) =>
            typeof item === 'object' && item !== null ? deep(item, {} as never) : item,
          );
        } else {
          (dst as Record<string, unknown>)[key] = v;
        }
      }
      return dst;
    };
    const plan = deep(obj, base);
    return { ok: true, plan };
  };
  try {
    if (trimmed.startsWith('{')) return parse(JSON.parse(trimmed));
    const parsed = YAML.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object') {
      return { ok: false, error: 'unrecognized format' };
    }
    return parse(parsed);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
