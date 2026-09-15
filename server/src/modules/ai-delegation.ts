// Inference delegation — request lifecycle for external-agent inference.
//
// An agent driving H3Mise already brings its own model, so the server never
// calls its own AI for delegated requests: prepare builds the exact inference
// payload, the agent runs it, and apply validates + atomically applies the
// answer with the same code path as the built-in driver. The request row
// stores the continuation state so multi-round actions (repair / retry /
// auto_director) resume across HTTP calls.

import { createHash } from 'node:crypto';
import type { AiAgentStatus, AiInferenceMessage, AiInferenceStep, AiRequestDetail, AiRequestSource, AiRequestStatus, AiRequestSummary } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import type { AIService, VisionStatus } from './ai.js';
import { extractJsonValue } from './ai.js';
import { advanceAction, decorateResult, prepareAction, stepHasImages, type AdvanceState, type InferenceStep } from './ai-actions.js';
import { createKeyedMutex } from './mutex.js';
import { nextId } from '../db/ids.js';

const MAX_STATE_BYTES = 2_000_000;
const AGENT_TTL_MS = 10 * 60_000;
const mutex = createKeyedMutex();

// --- agent presence (in-memory; the server is a single local process) ------

let agentModel: string | null = null;
let agentLastSeenAt = 0;

/** Record agent activity. Called on every delegated prepare/apply and by the
 * explicit attach endpoint; keeps the presence alive while an agent works. */
export function touchAgent(modelLabel: string | null): void {
  if (modelLabel) agentModel = modelLabel;
  agentLastSeenAt = Date.now();
}

export function detachAgent(): void {
  agentModel = null;
  agentLastSeenAt = 0;
}

export function agentStatus(ctx: ProjectContext | null): AiAgentStatus {
  const attached = agentLastSeenAt > 0 && Date.now() - agentLastSeenAt < AGENT_TTL_MS;
  return {
    attached,
    modelLabel: attached ? agentModel : null,
    lastSeenAt: agentLastSeenAt > 0 ? new Date(agentLastSeenAt).toISOString() : null,
    pending: ctx ? countPending(ctx) : 0,
  };
}

export class AiDelegationError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AiDelegationError';
  }
}

interface AiRequestRow {
  id: string;
  action: string;
  status: AiRequestStatus;
  source: string;
  model_label: string | null;
  context_hash: string;
  body_json: string;
  state_json: string;
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface StoredState {
  raws: unknown[];
  extra: Record<string, unknown>;
  pendingJson: boolean;
  vision: VisionStatus | null;
  /** The step the agent must run next, stored when an apply returns
   * 'continue'. Round-0 steps are rebuilt from the body instead (they may
   * carry base64 images and are deterministic). */
  pendingStep?: InferenceStep | null;
}

function now(): string {
  return new Date().toISOString();
}

/** Fingerprint of everything a step depends on. Rebuilt on apply to detect
 * that the project changed after prepare (stale delegation). */
function contextHash(action: string, body: Record<string, unknown>, step: InferenceStep): string {
  return createHash('sha256').update(JSON.stringify({ action, body, system: step.system, messages: step.messages })).digest('hex');
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function parseState(row: AiRequestRow): StoredState {
  const parsed = parseJson<Partial<StoredState>>(row.state_json, {});
  return {
    raws: Array.isArray(parsed.raws) ? parsed.raws : [],
    extra: parsed.extra && typeof parsed.extra === 'object' ? parsed.extra : {},
    pendingJson: parsed.pendingJson === true,
    vision: parsed.vision ?? null,
    pendingStep: parsed.pendingStep ?? null,
  };
}

function toSummary(row: AiRequestRow): AiRequestSummary {
  const body = parseJson<{ shotId?: unknown }>(row.body_json, {});
  return {
    id: row.id,
    action: row.action,
    status: row.status,
    source: row.source as AiRequestSource,
    modelLabel: row.model_label,
    shotId: typeof body.shotId === 'string' ? body.shotId : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function getRow(ctx: ProjectContext, id: string): AiRequestRow | null {
  return ctx.db.get<AiRequestRow>('SELECT * FROM ai_requests WHERE id = ?', [id]) ?? null;
}

/** Serialize a server step into the wire contract (adds hasImages). */
export function wireStep(step: InferenceStep): AiInferenceStep {
  return {
    system: step.system,
    messages: step.messages as AiInferenceMessage[],
    json: step.json,
    temperature: step.temperature,
    hasImages: stepHasImages(step),
  };
}

export function countPending(ctx: ProjectContext): number {
  return ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ai_requests WHERE status = 'pending'")?.n ?? 0;
}

export function listRequests(ctx: ProjectContext, status?: string, limit = 20): AiRequestSummary[] {
  const capped = Math.max(1, Math.min(100, limit));
  const rows = status
    ? ctx.db.all<AiRequestRow>('SELECT * FROM ai_requests WHERE status = ? ORDER BY created_at DESC LIMIT ?', [status, capped])
    : ctx.db.all<AiRequestRow>('SELECT * FROM ai_requests ORDER BY created_at DESC LIMIT ?', [capped]);
  return rows.map(toSummary);
}

export function getRequest(ctx: ProjectContext, id: string): AiRequestDetail | null {
  const row = getRow(ctx, id);
  if (!row) return null;
  return { ...toSummary(row), result: parseJson(row.result_json, null), error: row.error };
}

/** Cancel a request that is still waiting for an agent. Applied/stale/failed
 * requests cannot be cancelled. */
export function cancelRequest(ctx: ProjectContext, id: string): AiRequestSummary {
  const row = getRow(ctx, id);
  if (!row) throw new AiDelegationError(`ai request ${id} not found`, 404, 'not_found');
  if (row.status !== 'pending') {
    throw new AiDelegationError(`只有等待中的请求可以取消（当前状态：${row.status}）`, 409, 'not_pending');
  }
  const ts = now();
  ctx.db.run('UPDATE ai_requests SET status = ?, error = ?, updated_at = ?, completed_at = ? WHERE id = ?', [
    'cancelled', '由用户取消', ts, ts, id,
  ]);
  return toSummary(getRow(ctx, id)!);
}

export interface PreparedRequest {
  requestId: string;
  step: InferenceStep;
  contextHash: string;
}

/** Create a pending request: build the first inference, store continuation
 * state, and hand the prompt to the caller. No model is called. */
export async function prepareRequest(
  ai: AIService,
  ctx: ProjectContext,
  action: string,
  body: Record<string, unknown>,
  modelLabel: string | null,
): Promise<PreparedRequest> {
  const step = await prepareAction(ai, ctx, action, body);
  touchAgent(modelLabel);
  const hash = contextHash(action, body, step);
  const id = nextId(ctx.db, 'aireq');
  const ts = now();
  const state: StoredState = { raws: [], extra: {}, pendingJson: step.json, vision: null };
  ctx.db.run(
    `INSERT INTO ai_requests (id, action, status, source, model_label, context_hash, body_json, state_json, created_at, updated_at)
     VALUES (?, ?, 'pending', 'agent', ?, ?, ?, ?, ?, ?)`,
    [id, action, modelLabel, hash, JSON.stringify(body), JSON.stringify(state), ts, ts],
  );
  return { requestId: id, step, contextHash: hash };
}

/** The inference a pending request waits on. Round 0 is rebuilt from the
 * stored body (pure); later rounds return the step stored by the previous
 * apply. Agents pick up UI-deferred requests with this. */
export async function pendingStep(ai: AIService, ctx: ProjectContext, id: string): Promise<InferenceStep> {
  const row = getRow(ctx, id);
  if (!row) throw new AiDelegationError(`ai request ${id} not found`, 404, 'not_found');
  if (row.status !== 'pending') {
    throw new AiDelegationError(`请求不在等待状态（当前：${row.status}）`, 409, 'not_pending');
  }
  const state = parseState(row);
  if (state.raws.length === 0) {
    const body = parseJson<Record<string, unknown>>(row.body_json, {});
    return prepareAction(ai, ctx, row.action, body);
  }
  if (!state.pendingStep) {
    throw new AiDelegationError('该请求缺少可重放的推理步骤，请重新发起', 409, 'no_step');
  }
  return state.pendingStep;
}

export type ApplyOutcome =
  | { status: 'applied'; result: unknown; vision: VisionStatus | null }
  | { status: 'continue'; step: InferenceStep };

/** Consume one agent-provided answer. Completes the action or asks for the
 * next inference round. Idempotent: re-applying a completed request returns
 * the stored result without touching project data again. */
export async function applyResult(
  ai: AIService,
  ctx: ProjectContext,
  id: string,
  result: unknown,
  vision: VisionStatus | null,
): Promise<ApplyOutcome> {
  return mutex(`ai-request:${id}`, async () => {
    touchAgent(null);
    const row = getRow(ctx, id);
    if (!row) throw new AiDelegationError(`ai request ${id} not found`, 404, 'not_found');
    if (row.status === 'applied') {
      return { status: 'applied', result: parseJson<unknown>(row.result_json, null), vision: parseState(row).vision };
    }
    if (row.status === 'failed') throw new AiDelegationError(row.error ?? 'ai request failed', 409, 'failed');
    if (row.status === 'stale') throw new AiDelegationError('项目在 prepare 之后已变化，请重新 prepare', 409, 'stale');
    if (row.status === 'cancelled') throw new AiDelegationError('该请求已被取消，等待新的请求', 409, 'cancelled');

    const body = parseJson<Record<string, unknown>>(row.body_json, {});
    const state = parseState(row);
    // Staleness gate: rebuild the first step and compare hashes so a project
    // change between prepare and apply is caught. Only checked BEFORE the
    // first answer is consumed — multi-round pipelines (auto_director) apply
    // side effects between rounds by design, so later rounds would always
    // look stale against the prepare-time snapshot.
    if (state.raws.length === 0) {
      const first = await prepareAction(ai, ctx, row.action, body);
      if (contextHash(row.action, body, first) !== row.context_hash) {
        ctx.db.run('UPDATE ai_requests SET status = ?, error = ?, updated_at = ? WHERE id = ?', ['stale', '项目在 prepare 之后已变化', now(), id]);
        throw new AiDelegationError('项目在 prepare 之后已变化，请重新 prepare', 409, 'stale');
      }
    }

    let raw = result;
    if (state.pendingJson && typeof raw === 'string') {
      const parsed = extractJsonValue<unknown>(raw);
      if (!parsed.ok) throw new AiDelegationError('结果不是有效 JSON；请只返回一个 JSON 数组或对象', 422, 'invalid_json');
      raw = parsed.value;
    }
    state.raws.push(raw);
    if (vision) state.vision = vision;

    if (JSON.stringify(state).length > MAX_STATE_BYTES) {
      ctx.db.run('UPDATE ai_requests SET status = ?, error = ?, updated_at = ? WHERE id = ?', ['failed', '推理状态过大，已中止', now(), id]);
      throw new AiDelegationError('推理状态过大，已中止；请将动作拆分为更小的请求', 413, 'state_too_large');
    }

    const advanceState: AdvanceState = { raws: state.raws, extra: state.extra };
    let outcome;
    try {
      outcome = await advanceAction(ai, ctx, row.action, body, advanceState);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.db.run('UPDATE ai_requests SET status = ?, error = ?, state_json = ?, updated_at = ? WHERE id = ?', ['failed', message, JSON.stringify(state), now(), id]);
      throw new AiDelegationError(message, 422, 'invalid_output');
    }

    if (outcome.done) {
      const decorated = decorateResult(row.action, outcome.result, state.vision);
      const ts = now();
      ctx.db.run('UPDATE ai_requests SET status = ?, result_json = ?, state_json = ?, updated_at = ?, completed_at = ? WHERE id = ?', [
        'applied', JSON.stringify(decorated ?? null), JSON.stringify(state), ts, ts, id,
      ]);
      return { status: 'applied', result: decorated, vision: state.vision };
    }

    state.pendingJson = outcome.step.json;
    state.pendingStep = outcome.step;
    ctx.db.run('UPDATE ai_requests SET state_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify(state), now(), id]);
    return { status: 'continue', step: outcome.step };
  });
}
