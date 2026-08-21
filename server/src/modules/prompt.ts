// Prompt module — PRD §18-21. PromptVersions are immutable; the compiler
// never overwrites history. Raw Prompt path bypasses DirectorPlan entirely.

import type { H3Mode, PromptSource, PromptVersion } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { nextId } from '../db/ids.js';
import { compileDeterministic, type CompileContext } from './prompt-templates.js';
import { latestPlan } from './director.js';
import { getShot } from './shots.js';
import { ensureShotEntityImageBindings, listBindings } from './assets.js';

interface PvRow {
  id: string;
  shot_id: string;
  source: string;
  director_plan_version_id: string | null;
  h3_mode: string;
  text: string;
  created_at: string;
}

function pvFromRow(r: PvRow): PromptVersion {
  return {
    id: r.id,
    shotId: r.shot_id,
    source: r.source as PromptSource,
    directorPlanVersionId: r.director_plan_version_id,
    h3Mode: r.h3_mode as H3Mode,
    text: r.text,
    createdAt: r.created_at,
  };
}

export function listPrompts(p: ProjectContext, shotId: string): PromptVersion[] {
  return p.db.all<PvRow>('SELECT * FROM prompt_versions WHERE shot_id = ? ORDER BY created_at', [shotId]).map(pvFromRow);
}

export function getPrompt(p: ProjectContext, id: string): PromptVersion {
  const r = p.db.get<PvRow>('SELECT * FROM prompt_versions WHERE id = ?', [id]);
  if (!r) throw new Error('prompt version not found');
  return pvFromRow(r);
}

export function createPrompt(
  p: ProjectContext,
  input: { shotId: string; source: PromptSource; h3Mode: H3Mode; text: string; directorPlanVersionId?: string | null },
): PromptVersion {
  const id = nextId(p.db, 'prompt');
  const now = new Date().toISOString();
  p.db.run(
    'INSERT INTO prompt_versions (id, shot_id, source, director_plan_version_id, h3_mode, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, input.shotId, input.source, input.directorPlanVersionId ?? null, input.h3Mode, input.text, now],
  );
  return getPrompt(p, id);
}

/**
 * Deterministic compile — DirectorPlan → H3 Prompt (PRD §19).
 * If the shot has no plan content yet, returns a prompt built purely from
 * the shot's minimal fields (still deterministic, no invention).
 */
export function compilePrompt(p: ProjectContext, shotId: string, mode: H3Mode, durationSeconds?: number): PromptVersion {
  const shot = getShot(p, shotId);
  const plan = latestPlan(p, shotId);
  const refs = ensureShotEntityImageBindings(p, shot, mode).bindings;
  const ctx: CompileContext = {
    shot,
    plan: plan?.plan ?? {
      version: 0,
      intent: { shotFunction: shot.shotFunction, visualThesis: shot.purpose, dramaticGoal: '', peak: '', endState: '' },
      subject: { primarySubject: '', action: '', primaryMotionOwner: '' },
      blocking: { startPosition: '', endPosition: '', facing: '', movementAxis: '', travelPath: '', spatialRelationships: '' },
      camera: { shotSizeStart: '', shotSizePeak: '', shotSizeEnd: '', geometry: '', lensIntent: '', dominantBehavior: '', trigger: '', speedRelation: '', stopCondition: '' },
      performance: { objective: '', obstacle: '', tactic: '', performanceTurn: '', movementQuality: { weight: '', time: '', space: '', flow: '' }, anticipation: '', primaryAction: '', followThrough: '', recovery: '', gaze: '', endPose: '' },
      environment: { location: '', weather: '', medium: '', wind: '', lighting: '', foreground: '', midground: '', background: '' },
      reality: { mode: 'strict_realism', constraints: [] },
      continuity: { plannedStartState: '', plannedEndState: '' },
      generation: {
        requestedMode: mode,
        durationSeconds: durationSeconds ?? shot.durationSeconds,
        aspectRatio: shot.aspectRatio,
        audioIntent: '',
      },
    },
    references: refs,
  };
  const text = compileDeterministic(ctx, mode);
  return createPrompt(p, {
    shotId,
    source: 'deterministic_compiler',
    h3Mode: mode,
    text,
    directorPlanVersionId: plan?.id ?? null,
  });
}

/** Store a user-authored or AI-optimized prompt as an immutable version. */
export function importRawPrompt(
  p: ProjectContext,
  shotId: string,
  text: string,
  mode: H3Mode,
  source: Extract<PromptSource, 'manual' | 'ai_compiler'> = 'manual',
): PromptVersion {
  return createPrompt(p, { shotId, source, h3Mode: mode, text });
}

/** Copy Context Package for external AI (PRD §21/§39). */
export function buildContextPackage(
  p: ProjectContext,
  shotId: string,
  task: string,
  profile?: { capabilities: { supportedModes?: string[]; maxDuration?: number; audioSupported?: boolean }; verification: { status: string } } | null,
): Record<string, unknown> {
  const shot = getShot(p, shotId);
  const plan = latestPlan(p, shotId);
  const prompts = listPrompts(p, shotId);
  const refs = listBindings(p, shotId);
  const assets = refs.map((r) => {
    const a = p.db.get<{ label: string; kind: string }>('SELECT label, kind FROM media_assets WHERE id = ?', [r.assetId]);
    return { bindingId: r.id, assetLabel: r.label, assetKind: r.type, roles: r.roles, preserve: r.preserve, ignore: r.ignore, mediaLabel: a?.label };
  });
  const continuity = p.db.all<{ scope: string; kind: string; source_take_id: string | null; state_json: string | null; narrative_json: string | null; committed_at: string }>(
    'SELECT * FROM continuity_entries WHERE shot_id = ? ORDER BY created_at DESC LIMIT 2',
    [shotId],
  );
  const project = p.config;
  const story = p.db.get<{ title: string; synopsis: string }>('SELECT title, synopsis FROM story LIMIT 1');
  return {
    project,
    story_context: story,
    previous_selected_take: (() => {
      // P1: predecessor by shot order, not by created_at across the project.
      const prev = p.db.get<{ id: string }>(
        'SELECT id FROM shots WHERE ord < (SELECT ord FROM shots WHERE id = ?) ORDER BY ord DESC LIMIT 1',
        [shotId],
      );
      if (!prev) return null;
      return (
        p.db.get<{ id: string; shot_id: string }>(
          "SELECT id, shot_id FROM takes WHERE shot_id = ? AND status = 'selected' ORDER BY created_at DESC LIMIT 1",
          [prev.id],
        ) ?? null
      );
    })(),
    continuity,
    assets,
    shot,
    director_plan: plan?.plan ?? null,
    prompt_versions: prompts,
    provider_constraints: {
      // P1: executable capability comes from the CURRENT provider profile,
      // never from a hardcoded theoretical list; unverified = nothing claimed.
      modes: profile?.verification.status === 'verified' ? (profile.capabilities.supportedModes ?? []) : [],
      max_duration_seconds: profile?.verification.status === 'verified' ? (profile.capabilities.maxDuration ?? null) : null,
      audio_supported: profile?.verification.status === 'verified' ? (profile.capabilities.audioSupported ?? null) : null,
    },
    task,
    output_schema: 'director_plan_yaml_or_json',
  };
}
