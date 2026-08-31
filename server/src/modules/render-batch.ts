// Project-level render preparation. This module never submits a Provider task:
// it classifies Shot dependencies, creates missing deterministic Prompts, and
// runs local Preflight. Paid submission remains an explicit UI confirmation
// followed by the normal single-shot render gate.

import type {
  H3Mode,
  RenderBatchPlan,
  RenderBatchPrepareResult,
  RenderBatchShot,
  RenderBatchShotStage,
} from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { jget } from '../db/sqlite.js';
import { listShots, renderReadiness, updateShot } from './shots.js';
import { shotAssetRequirements } from './assets.js';
import { compilePrompt, listPrompts } from './prompt.js';
import { latestPlan } from './director.js';
import { runBasicPreflight } from './preflight.js';

const ACTIVE = ['LOCAL_QUEUED', 'UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING'];
const STAGES: RenderBatchShotStage[] = ['ready', 'active', 'done', 'needs_selection', 'waiting_dependency', 'needs_assets', 'needs_prompt', 'needs_preflight', 'blocked'];

interface PreflightRow {
  id: string;
  prompt_version_id: string | null;
  provider_id: string | null;
  basic_json: string;
  blocked: number;
  created_at: string;
}

function firstPreflightError(row: PreflightRow): string {
  const sections = jget<Array<{ checks?: Array<{ severity?: string; message?: string }> }>>(row.basic_json, []);
  return sections.flatMap((section) => section.checks ?? []).find((check) => check.severity === 'error')?.message ?? '最近一次 Preflight 未通过';
}

function latestPreflight(p: ProjectContext, shotId: string, promptVersionId: string, providerId: string): PreflightRow | null {
  return p.db.get<PreflightRow>(
    'SELECT id, prompt_version_id, provider_id, basic_json, blocked, created_at FROM preflight_reports WHERE shot_id = ? AND prompt_version_id = ? AND provider_id = ? ORDER BY created_at DESC LIMIT 1',
    [shotId, promptVersionId, providerId],
  ) ?? null;
}

function promptIsStale(p: ProjectContext, shotId: string, prompt: ReturnType<typeof listPrompts>[number]): boolean {
  if (prompt.source !== 'deterministic_compiler') return false;
  const currentPlanId = latestPlan(p, shotId)?.id ?? null;
  if (prompt.directorPlanVersionId !== currentPlanId) return true;
  const newerBinding = p.db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM reference_bindings WHERE shot_id = ? AND created_at > ?',
    [shotId, prompt.createdAt],
  )?.n ?? 0;
  return newerBinding > 0;
}

export async function planRenderBatch(
  p: ProjectContext,
  registry: ProviderRegistry,
  input: { providerId: string; megapixels?: number },
): Promise<RenderBatchPlan> {
  const provider = registry.get(input.providerId);
  const shots: RenderBatchShot[] = [];
  for (const shot of listShots(p)) {
    const dependency = renderReadiness(p, shot);
    const prompt = listPrompts(p, shot.id).at(-1) ?? null;
    const mode = (shot.h3Mode ?? prompt?.h3Mode ?? 't2va') as H3Mode;
    const selected = p.db.get<{ id: string; created_at: string }>("SELECT id, created_at FROM takes WHERE shot_id = ? AND status = 'selected' LIMIT 1", [shot.id]);
    const candidates = p.db.get<{ n: number; newest: string | null }>("SELECT COUNT(*) AS n, MAX(created_at) AS newest FROM takes WHERE shot_id = ? AND status = 'candidate'", [shot.id]);
    const candidateCount = candidates?.n ?? 0;
    const active = p.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM render_jobs WHERE shot_id = ? AND status IN (${ACTIVE.map(() => '?').join(',')})`,
      [shot.id, ...ACTIVE],
    )?.n ?? 0;
    const missing = shotAssetRequirements(p, shot).filter((item) => item.level === 'required').map((item) => item.label);
    const newestBindingAt = p.db.get<{ created_at: string }>('SELECT created_at FROM reference_bindings WHERE shot_id = ? ORDER BY created_at DESC LIMIT 1', [shot.id])?.created_at ?? null;
    const selectedFresh = Boolean(selected && (!newestBindingAt || selected.created_at >= newestBindingAt));
    const candidatesFresh = candidateCount > 0 && (!newestBindingAt || (candidates?.newest ?? '') >= newestBindingAt);

    let stage: RenderBatchShotStage;
    let reason: string;
    let preflightId: string | null = null;
    if (active > 0) {
      stage = 'active'; reason = '已在全局渲染队列中';
    } else if (!dependency.ready) {
      stage = dependency.effectiveMode === 'previous_take' ? 'waiting_dependency' : 'needs_assets';
      reason = dependency.reason;
    } else if (selectedFresh) {
      stage = 'done'; reason = '已有与当前输入一致的 Selected Take';
    } else if (candidatesFresh) {
      stage = 'needs_selection'; reason = `已有 ${candidateCount} 个候选 Take，请先选片或拒绝后再重新生成`;
    } else if (missing.length > 0) {
      stage = 'needs_assets'; reason = `缺少：${missing.join('、')}`;
    } else if (!provider || !provider.configured) {
      stage = 'blocked'; reason = `生成服务 ${input.providerId} 尚未配置`;
    } else if (!prompt) {
      stage = 'needs_prompt'; reason = '缺少 Prompt，可批量生成确定性 Prompt';
    } else if (prompt.h3Mode !== mode && prompt.source !== 'deterministic_compiler') {
      stage = 'blocked'; reason = `手工 Prompt 使用 ${prompt.h3Mode.toUpperCase()}，与 Shot 的 ${mode.toUpperCase()} 不一致`;
    } else if (promptIsStale(p, shot.id, prompt)) {
      stage = 'needs_prompt'; reason = '镜头设计或参考素材已变化，需要重新生成 Prompt';
    } else {
      const report = latestPreflight(p, shot.id, prompt.id, input.providerId);
      const newestBinding = p.db.get<{ created_at: string }>('SELECT created_at FROM reference_bindings WHERE shot_id = ? ORDER BY created_at DESC LIMIT 1', [shot.id]);
      if (!report || (newestBinding && newestBinding.created_at > report.created_at)) {
        stage = 'needs_preflight'; reason = '需要运行生成前检查';
      } else if (report.blocked) {
        stage = 'blocked'; reason = firstPreflightError(report);
        preflightId = report.id;
      } else {
        stage = 'ready'; reason = 'Prompt、素材、依赖和 Preflight 均已就绪';
        preflightId = report.id;
      }
    }
    shots.push({ shotId: shot.id, title: shot.title, order: shot.order, mode, stage, reason, promptVersionId: prompt?.id ?? null, preflightId, dependency });
  }

  const counts = Object.fromEntries(STAGES.map((stage) => [stage, shots.filter((shot) => shot.stage === stage).length])) as RenderBatchPlan['counts'];
  return {
    projectId: p.meta.id,
    providerId: input.providerId,
    providerConcurrency: registry.concurrencyLimit(input.providerId),
    ...(input.megapixels !== undefined ? { megapixels: input.megapixels } : {}),
    shots,
    counts,
  };
}

export async function prepareRenderBatch(
  p: ProjectContext,
  registry: ProviderRegistry,
  input: { providerId: string; megapixels?: number },
): Promise<RenderBatchPrepareResult> {
  const before = await planRenderBatch(p, registry, input);
  const prepared: RenderBatchPrepareResult['prepared'] = [];
  const skipped: RenderBatchPrepareResult['skipped'] = [];
  for (const item of before.shots) {
    if (!['needs_prompt', 'needs_preflight', 'blocked'].includes(item.stage)) {
      if (item.stage !== 'ready') skipped.push({ shotId: item.shotId, reason: item.reason });
      continue;
    }
    const shot = listShots(p).find((candidate) => candidate.id === item.shotId)!;
    const dependency = renderReadiness(p, shot);
    const missing = shotAssetRequirements(p, shot).some((requirement) => requirement.level === 'required');
    const provider = registry.get(input.providerId);
    if (!dependency.ready || missing || !provider?.configured) {
      skipped.push({ shotId: shot.id, reason: item.reason });
      continue;
    }
    let prompt = listPrompts(p, shot.id).at(-1) ?? null;
    const mode = (shot.h3Mode ?? prompt?.h3Mode ?? 't2va') as H3Mode;
    if (prompt && prompt.h3Mode !== mode && prompt.source !== 'deterministic_compiler') {
      skipped.push({ shotId: shot.id, reason: item.reason });
      continue;
    }
    if (!prompt || promptIsStale(p, shot.id, prompt) || prompt.h3Mode !== mode) {
      if (!shot.h3Mode) updateShot(p, shot.id, { h3Mode: mode });
      prompt = compilePrompt(p, shot.id, mode, shot.durationSeconds);
    }
    try {
      const report = await runBasicPreflight(p, registry, {
        shotId: shot.id,
        promptVersionId: prompt.id,
        providerId: input.providerId,
        megapixels: input.megapixels,
      });
      prepared.push({ shotId: shot.id, promptVersionId: prompt.id, preflightId: report.id, blocked: report.blocked });
    } catch (error) {
      skipped.push({ shotId: shot.id, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { prepared, skipped, plan: await planRenderBatch(p, registry, input) };
}
