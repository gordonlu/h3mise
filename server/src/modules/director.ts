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

const SHOT_FUNCTIONS = new Set(['establishing', 'wide', 'medium', 'closeup', 'insert', 'reaction', 'action', 'transition', 'montage', 'pov', 'aerial', 'dialogue', 'other']);
const REALITY_MODES = new Set(['strict_realism', 'plausible_stylized', 'deliberate_fantasy']);
const GENERATION_MODES = new Set(['', 't2va', 'i2va', 'fl2va', 'l2va', 'ref2va']);

/** Normalize untrusted AI/user JSON into the known DirectorPlan structure.
 * Unknown keys and invalid value types are discarded; common response wrappers
 * and snake_case keys are accepted. */
export function normalizeDirectorPlan(
  raw: unknown,
  base: DirectorPlan = emptyDirectorPlan(),
): { ok: boolean; plan?: DirectorPlan; error?: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '返回内容不是导演计划对象' };
  }

  const root = raw as Record<string, unknown>;
  const knownSections = ['intent', 'subject', 'blocking', 'camera', 'performance', 'environment', 'reality', 'continuity', 'generation'];
  const hasKnownSection = knownSections.some((key) => key in root);
  const wrapped = root.plan ?? root.directorPlan ?? root.director_plan ?? root.result ?? root.data;
  const source = !hasKnownSection && wrapped && typeof wrapped === 'object' && !Array.isArray(wrapped)
    ? wrapped
    : raw;
  const plan = structuredClone(base);

  const mergeKnown = (src: unknown, dst: Record<string, unknown>) => {
    if (typeof src !== 'object' || src === null || Array.isArray(src)) return;
    for (const [rawKey, value] of Object.entries(src as Record<string, unknown>)) {
      const key = rawKey.replace(/[_-]([a-z])/g, (_, c: string) => c.toUpperCase());
      if (!(key in dst) || value === null || value === undefined) continue;
      const expected = dst[key];
      if (Array.isArray(expected)) {
        if (Array.isArray(value)) dst[key] = value.filter((item): item is string => typeof item === 'string');
      } else if (typeof expected === 'object' && expected !== null) {
        mergeKnown(value, expected as Record<string, unknown>);
      } else if (typeof expected === 'number') {
        if (typeof value === 'number' && Number.isFinite(value)) dst[key] = value;
      } else if (typeof expected === 'string' && typeof value === 'string') {
        dst[key] = value.trim();
      }
    }
  };

  mergeKnown(source, plan as unknown as Record<string, unknown>);
  if (!SHOT_FUNCTIONS.has(plan.intent.shotFunction)) plan.intent.shotFunction = base.intent.shotFunction;
  if (!REALITY_MODES.has(plan.reality.mode)) plan.reality.mode = base.reality.mode;
  if (!GENERATION_MODES.has(plan.generation.requestedMode)) plan.generation.requestedMode = base.generation.requestedMode;
  if (plan.generation.durationSeconds < 1 || plan.generation.durationSeconds > 60) {
    plan.generation.durationSeconds = base.generation.durationSeconds;
  }
  return { ok: true, plan };
}

/** Raw plan text parsing (YAML/JSON from external AI) — PRD §21. */
export function parseDirectorPlanText(text: string): { ok: boolean; plan?: DirectorPlan; error?: string } {
  const trimmed = text.trim()
    .replace(/^```(?:ya?ml|json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    if (trimmed.startsWith('{')) return normalizeDirectorPlan(JSON.parse(trimmed));
    const parsed = YAML.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object') {
      return { ok: false, error: 'unrecognized format' };
    }
    return normalizeDirectorPlan(parsed);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
