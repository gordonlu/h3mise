import { deriveProjectAttention, deriveShotGuideState, deriveNextAction } from '@h3mise/shared';
import type { GuideShotSnapshot, Shot } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { shotAssetRequirements } from './assets.js';
import { latestPreflight } from './preflight.js';
import { listShots } from './shots.js';

export function shotGuideSnapshot(p: ProjectContext, shot: Shot): GuideShotSnapshot {
  const prompt = p.db.get<{ id: string }>('SELECT id FROM prompt_versions WHERE shot_id = ? ORDER BY created_at DESC LIMIT 1', [shot.id]);
  const preflight = latestPreflight(p, shot.id);
  const active = p.db.get<{ id: string }>(
    "SELECT id FROM render_jobs WHERE shot_id = ? AND status IN ('UPLOADING','SUBMITTING','QUEUED','RUNNING','DOWNLOADING') ORDER BY created_at DESC LIMIT 1",
    [shot.id],
  );
  const selected = p.db.get<{ id: string }>("SELECT id FROM takes WHERE shot_id = ? AND status = 'selected' ORDER BY created_at DESC LIMIT 1", [shot.id]);
  const takeCount = p.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM takes WHERE shot_id = ? AND status IN ('candidate','selected')", [shot.id])?.n ?? 0;
  const missingReferences = shotAssetRequirements(p, shot)
    .filter((requirement) => requirement.level === 'required')
    .map((requirement) => requirement.label.replace(/ missing$/i, ''));

  return {
    id: shot.id,
    order: shot.order,
    title: shot.title || shot.id,
    hasDirectorPlan: Boolean(p.db.get<{ id: string }>('SELECT id FROM director_plan_versions WHERE shot_id = ? LIMIT 1', [shot.id])),
    missingReferences,
    hasPrompt: Boolean(prompt),
    preflightBlocked: preflight && preflight.promptVersionId === prompt?.id ? preflight.blocked : null,
    activeRenderJobId: active?.id ?? null,
    takeCount,
    selectedTakeId: selected?.id ?? null,
  };
}

export function projectGuideSummary(p: ProjectContext) {
  const snapshots = listShots(p).map((shot) => shotGuideSnapshot(p, shot));
  const timelineClipCount = p.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM timeline_clips')?.n ?? 0;
  return deriveProjectAttention(snapshots, timelineClipCount);
}

export function shotGuidePayload(p: ProjectContext, shot: Shot) {
  const snapshots = listShots(p).map((item) => shotGuideSnapshot(p, item));
  const snapshot = snapshots.find((item) => item.id === shot.id)!;
  const nextShot = snapshots.find((item) => item.order > snapshot.order && !item.selectedTakeId);
  return {
    state: deriveShotGuideState(snapshot),
    nextAction: deriveNextAction(snapshot, nextShot?.id ?? null),
  };
}
