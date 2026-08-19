// Preflight — PRD §24. Basic checks run locally with zero AI; semantic checks
// are an optional AI extension point. Never blocks on AI; risk + blocked flag
// from basic checks only.

import type { PreflightCheck, PreflightReport, PreflightSection } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { j, jget } from '../db/sqlite.js';
import { nextId } from '../db/ids.js';
import { getShot, advanceShotStatus, advanceTo } from './shots.js';
import { getPrompt } from './prompt.js';
import { getMedia, listBindings } from './assets.js';
import { pathReadable } from '../ffmpeg.js';
import type { ProviderRegistry } from '../providers/registry.js';

export interface BasicPreflightInput {
  shotId: string;
  promptVersionId: string;
  providerId: string;
}

export async function runBasicPreflight(p: ProjectContext, registry: ProviderRegistry, input: BasicPreflightInput): Promise<PreflightReport> {
  const shot = getShot(p, input.shotId);
  const prompt = getPrompt(p, input.promptVersionId);
  const checks: PreflightSection[] = [];
  const sections: { key: string; label: string; checks: PreflightCheck[] }[] = [
    { key: 'prompt', label: 'Prompt', checks: [] },
    { key: 'duration', label: 'Duration', checks: [] },
    { key: 'provider', label: 'Provider', checks: [] },
    { key: 'references', label: 'References', checks: [] },
    { key: 'integrity', label: 'Integrity', checks: [] },
    { key: 'credential', label: 'Credential', checks: [] },
    { key: 'duplicate', label: 'Duplicate', checks: [] },
  ];

  // Prompt
  if (prompt.text.trim() === '') {
    sections[0]!.checks.push({ key: 'prompt.empty', severity: 'error', message: 'Prompt is empty' });
  } else {
    sections[0]!.checks.push({ key: 'prompt.ok', severity: 'info', message: `Prompt OK (${prompt.h3Mode}, ${prompt.text.length} chars)` });
  }

  // Duration
  const caps = await registry.capabilities(input.providerId);
  if (!(shot.durationSeconds > 0)) {
    sections[1]!.checks.push({ key: 'duration.invalid', severity: 'error', message: `Duration ${shot.durationSeconds}s is not positive` });
  } else if (caps && caps.maxDuration && shot.durationSeconds > caps.maxDuration) {
    sections[1]!.checks.push({ key: 'duration.max', severity: 'error', message: `Duration ${shot.durationSeconds}s exceeds provider max ${caps.maxDuration}s` });
  } else if (caps && caps.minDuration && shot.durationSeconds < caps.minDuration) {
    sections[1]!.checks.push({ key: 'duration.min', severity: 'error', message: `Duration ${shot.durationSeconds}s below provider min ${caps.minDuration}s` });
  } else {
    sections[1]!.checks.push({ key: 'duration.ok', severity: 'info', message: `Duration ${shot.durationSeconds}s valid` });
  }

  // Provider + mode
  const capsForMode = await registry.capabilities(input.providerId);
  const provider = registry.get(input.providerId);
  if (!provider) {
    sections[2]!.checks.push({ key: 'provider.missing', severity: 'error', message: `Provider "${input.providerId}" not found` });
  } else {
    if (!capsForMode?.supportedModes.includes(prompt.h3Mode)) {
      sections[2]!.checks.push({
        key: 'provider.mode',
        severity: 'error',
        message: `Provider does not support mode ${prompt.h3Mode.toUpperCase()}`,
      });
    } else {
      sections[2]!.checks.push({ key: 'provider.mode.ok', severity: 'info', message: `Provider supports ${prompt.h3Mode.toUpperCase()}` });
    }
    if (!capsForMode?.supportedAspectRatios?.includes(shot.aspectRatio)) {
      sections[2]!.checks.push({
        key: 'provider.aspect',
        severity: 'warning',
        message: `Provider may not support aspect ratio ${shot.aspectRatio} (${capsForMode?.supportedAspectRatios?.join(', ') ?? 'unknown'})`,
      });
    }
    if (provider.configured === false) {
      sections[2]!.checks.push({ key: 'provider.not_configured', severity: 'error', message: 'Provider credential not configured (RUNNINGHUB_API_KEY)' });
    }
  }

  // References
  const bindings = listBindings(p, shot.id);
  const requiredRoles = new Set<string>();
  if (prompt.h3Mode === 'i2va' || prompt.h3Mode === 'fl2va') requiredRoles.add('first_frame');
  if (prompt.h3Mode === 'l2va' || prompt.h3Mode === 'fl2va') requiredRoles.add('last_frame');
  const haveRoles = new Set(bindings.flatMap((b) => b.roles));
  for (const role of requiredRoles) {
    if (!haveRoles.has(role as never)) {
      sections[3]!.checks.push({ key: `ref.${role}`, severity: 'error', message: `Missing required reference role: ${role}` });
    }
  }
  for (const b of bindings) {
    try {
      const asset = getMedia(p, b.assetId);
      const abs = p.resolveProjectPath(asset.fileName);
      if (!(await pathReadable(abs))) {
        sections[3]!.checks.push({ key: `ref.file.${b.id}`, severity: 'error', message: `Reference file missing on disk: ${asset.fileName}` });
      }
    } catch (e) {
      sections[3]!.checks.push({ key: `ref.asset.${b.id}`, severity: 'error', message: `Invalid reference: ${e instanceof Error ? e.message : e}` });
    }
  }
  if (sections[3]!.checks.length === 0) {
    sections[3]!.checks.push({ key: 'ref.ok', severity: 'info', message: bindings.length ? `${bindings.length} reference(s) present` : 'No references (mode-appropriate)' });
  }

  // Integrity
  if (prompt.directorPlanVersionId) {
    const dpv = p.db.get<{ id: string }>('SELECT id FROM director_plan_versions WHERE id = ?', [prompt.directorPlanVersionId]);
    if (!dpv) sections[4]!.checks.push({ key: 'integrity.dpv', severity: 'error', message: 'DirectorPlan version reference is broken' });
  }
  sections[4]!.checks.push({ key: 'integrity.shot', severity: 'info', message: `Shot ${shot.id} / ${shot.status}` });

  // Credential
  if (provider?.configured === false) {
    sections[5]!.checks.push({ key: 'credential.key', severity: 'error', message: 'RUNNINGHUB_API_KEY missing — set it in the environment before rendering' });
  } else {
    sections[5]!.checks.push({ key: 'credential.ok', severity: 'info', message: 'Credential available' });
  }

  // Duplicate
  const active = p.db.get<{ id: string }>(
    "SELECT id FROM render_jobs WHERE shot_id = ? AND status IN ('UPLOADING','SUBMITTING','QUEUED','RUNNING','DOWNLOADING') LIMIT 1",
    [shot.id],
  );
  if (active) {
    sections[6]!.checks.push({ key: 'duplicate.active', severity: 'warning', message: `Shot already has an active render job (${active.id})` });
  } else {
    sections[6]!.checks.push({ key: 'duplicate.ok', severity: 'info', message: 'No duplicate render in flight' });
  }

  const report = finalizePreflight(p, sections, input.shotId, input.promptVersionId, null, false);
  return report;
}

export function finalizePreflight(
  p: ProjectContext,
  sections: Array<{ key: string; label: string; checks: PreflightCheck[] }>,
  shotId: string,
  promptVersionId: string | null,
  semantic: PreflightSection[] | null,
  aiSemanticRun: boolean,
): PreflightReport {
  const statusFor = (s: { key: string; label: string; checks: PreflightCheck[] }): PreflightSection['status'] => {
    if (s.checks.some((c) => c.severity === 'error')) return 'fail';
    if (s.checks.some((c) => c.severity === 'warning')) return 'warn';
    return 'ok';
  };
  const normalized: PreflightSection[] = sections.map((s) => ({ ...s, status: statusFor(s) }));
  const errors = normalized.flatMap((s) => s.checks).filter((c) => c.severity === 'error');
  const warnings = normalized.flatMap((s) => s.checks).filter((c) => c.severity === 'warning');
  const risk: PreflightReport['risk'] = errors.length > 0 ? 'HIGH' : warnings.length > 2 ? 'MEDIUM' : warnings.length > 0 ? 'MEDIUM' : 'LOW';
  const blocked = errors.length > 0;
  const id = nextId(p.db, 'preflight');
  const now = new Date().toISOString();
  p.db.run(
    'INSERT INTO preflight_reports (id, shot_id, prompt_version_id, basic_json, semantic_json, risk, blocked, ai_semantic_run, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, shotId, promptVersionId, j(normalized), semantic ? j(semantic) : null, risk, blocked ? 1 : 0, aiSemanticRun ? 1 : 0, now],
  );
  const shot = getShot(p, shotId);
  if (!blocked) {
    advanceTo(p, shotId, 'PREFLIGHT_READY');
  }
  return {
    id,
    shotId,
    promptVersionId,
    basic: normalized,
    semantic,
    risk,
    blocked,
    aiSemanticRun,
    createdAt: now,
  };
}

export function listPreflightReports(p: ProjectContext, shotId: string): PreflightReport[] {
  return p.db
    .all<{ id: string; shot_id: string; prompt_version_id: string | null; basic_json: string; semantic_json: string | null; risk: string; blocked: number; ai_semantic_run: number; created_at: string }>(
      'SELECT * FROM preflight_reports WHERE shot_id = ? ORDER BY created_at DESC',
      [shotId],
    )
    .map((r) => ({
      id: r.id,
      shotId: r.shot_id,
      promptVersionId: r.prompt_version_id,
      basic: jget<PreflightSection[]>(r.basic_json, []),
      semantic: r.semantic_json ? jget<PreflightSection[]>(r.semantic_json, []) : null,
      risk: r.risk as PreflightReport['risk'],
      blocked: Boolean(r.blocked),
      aiSemanticRun: Boolean(r.ai_semantic_run),
      createdAt: r.created_at,
    }));
}

export function latestPreflight(p: ProjectContext, shotId: string): PreflightReport | null {
  return listPreflightReports(p, shotId)[0] ?? null;
}
