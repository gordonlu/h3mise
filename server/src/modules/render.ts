// Render Queue — persisted, project-pinned jobs with per-provider concurrency.
// Waiting jobs share one global scheduler; provider limits protect paid APIs
// and local GPUs while independent shots/projects can use available slots.
//
// P0-1: every queued task is pinned to the project that created it
// (projectId is persisted on the job row). Upload / poll / download / take
// creation always re-open THAT project and never read `store.current`, so
// switching projects in the UI can never corrupt or collide with jobs.
// Job ids are per-project counters, so runtime keys are `projectId/jobId`.

import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { RenderJob, RenderJobStatus, RenderRequest } from '@h3mise/shared';
import type { ProjectContext, ProjectStore } from '../project-store.js';
import { j, jget, jgetOrNull } from '../db/sqlite.js';
import { nextId } from '../db/ids.js';
import type { EventBus } from '../events.js';
import type { Ffmpeg } from '../ffmpeg.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { RenderJobHandle } from '../providers/types.js';
import { ProviderError } from '../providers/types.js';
import { getShot, updateShot, advanceShotStatus, advanceTo } from './shots.js';
import { getPrompt } from './prompt.js';
import { getMedia, insertMedia } from './assets.js';
import { createTake } from './takes.js';

interface JobRow {
  id: string;
  project_id: string | null;
  shot_id: string;
  prompt_version_id: string;
  director_plan_version_id: string | null;
  provider: string;
  provider_task_id: string | null;
  status: string;
  submitted_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  request_snapshot_json: string | null;
  render_intent_hash: string | null;
  provider_response_snapshot_json: string | null;
  cost_json: string | null;
  error: string | null;
  take_id: string | null;
  created_at: string;
  updated_at: string;
}

export function jobFromRow(r: JobRow): RenderJob {
  return {
    id: r.id,
    projectId: r.project_id ?? '',
    shotId: r.shot_id,
    promptVersionId: r.prompt_version_id,
    directorPlanVersionId: r.director_plan_version_id,
    provider: r.provider,
    providerTaskId: r.provider_task_id,
    status: r.status as RenderJobStatus,
    submittedAt: r.submitted_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    requestSnapshot: jgetOrNull<RenderRequest>(r.request_snapshot_json),
    renderIntentHash: r.render_intent_hash ?? null,
    providerResponseSnapshot: jgetOrNull<Record<string, unknown>>(r.provider_response_snapshot_json),
    cost: jgetOrNull<RenderJob['cost']>(r.cost_json),
    error: r.error,
    takeId: r.take_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const ACTIVE_STATUSES: RenderJobStatus[] = ['LOCAL_QUEUED', 'UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING'];
const TERMINAL_STATUSES: RenderJobStatus[] = ['SUCCEEDED', 'LOCAL_READY', 'FAILED', 'CANCELLED', 'EXPIRED'];

const runKey = (projectId: string, jobId: string) => `${projectId}/${jobId}`;

export class RenderQueue {
  /** key -> provider. Insertion order gives stable FIFO among runnable jobs. */
  private pending = new Map<string, string>();
  private handles = new Map<string, RenderJobHandle>();
  /** Jobs currently occupying a provider slot. */
  private active = new Map<string, string>();
  private readonly deferredClose = new Set<string>();
  private readonly stoppedProjects = new Set<string>();
  private readonly waiters = new Map<string, Set<() => void>>();
  /** Provider-wide cooldown after a capacity rejection. Without this, the
   * failed slot was immediately handed to the next LOCAL_QUEUED job and a
   * whole batch could be rejected in a few milliseconds. */
  private readonly providerCooldownUntil = new Map<string, number>();
  private readonly capacityRetries = new Map<string, number>();
  private readonly pollMs: number;
  /** Detached contexts for projects with active jobs (never `store.current`). */
  private readonly detached = new Map<string, ProjectContext>();
  /** Single-flight guards concurrent workers from opening two SQLite handles
   * for the same project and leaking the one overwritten in `detached`. */
  private readonly openingDetached = new Map<string, Promise<ProjectContext | null>>();

  constructor(
    private readonly getStore: () => ProjectStore,
    private readonly registry: ProviderRegistry,
    private readonly ffmpeg: Ffmpeg,
    private readonly bus: EventBus,
    pollMs = 10_000,
    private readonly capacityRetryBaseMs = 30_000,
  ) {
    this.pollMs = pollMs;
  }

  private providerLimit(provider: string): number {
    const fn = (this.registry as ProviderRegistry & { concurrencyLimit?: (id: string) => number }).concurrencyLimit;
    return typeof fn === 'function' ? fn.call(this.registry, provider) : 1;
  }

  // --- project contexts ----------------------------------------------------

  /**
   * Context for a job's owning project: the live current context when it
   * matches, otherwise a cached detached one. Never switches `store.current`.
   */
  private ctxFor(projectId: string): ProjectContext | null {
    if (this.stoppedProjects.has(projectId)) return null;
    const cur = this.getStore().current;
    if (cur && cur.meta.id === projectId) return cur;
    let ctx = this.detached.get(projectId);
    if (!ctx) return null;
    return ctx;
  }

  private async ensureDetached(projectId: string): Promise<ProjectContext | null> {
    if (this.stoppedProjects.has(projectId)) return null;
    const cur = this.getStore().current;
    if (cur && cur.meta.id === projectId) return cur;
    return this.openDetachedOnce(projectId);
  }

  /**
   * Context for BACKGROUND pipeline work. Unlike ensureDetached, this NEVER
   * hands out `store.current`: the UI can switch projects at any moment and
   * store.open() closes the previous current db 鈥?a job running on that
   * handle would die mid-flight ("database is not open"). Only the cached
   * dedicated connections are safe for long-lived work.
   */
  private async pipelineCtx(projectId: string): Promise<ProjectContext | null> {
    if (this.stoppedProjects.has(projectId)) return null;
    const cached = this.detached.get(projectId);
    if (cached) return cached;
    return this.openDetachedOnce(projectId);
  }

  private async openDetachedOnce(projectId: string): Promise<ProjectContext | null> {
    const cached = this.detached.get(projectId);
    if (cached) return cached;
    const existing = this.openingDetached.get(projectId);
    if (existing) return existing;
    const opening = (async () => {
      try {
        const ctx = await this.getStore().openDetached(projectId);
        if (this.stoppedProjects.has(projectId)) {
          ctx.close();
          return null;
        }
        this.detached.set(projectId, ctx);
        return ctx;
      } catch {
        return null;
      } finally {
        this.openingDetached.delete(projectId);
      }
    })();
    this.openingDetached.set(projectId, opening);
    return opening;
  }

  /** Drop a detached context (e.g. project deleted while jobs were pending). */
  async forgetProject(projectId: string): Promise<void> {
    this.stoppedProjects.add(projectId);
    await this.openingDetached.get(projectId);
    for (const wake of this.waiters.get(projectId) ?? []) wake();
    this.waiters.delete(projectId);
    const ctx = this.detached.get(projectId);
    if (ctx && [...this.active.keys()].some((key) => key.startsWith(`${projectId}/`))) {
      // The worker may currently be awaiting provider I/O while holding this
      // context in a local variable. Closing it here creates a use-after-close.
      this.deferredClose.add(projectId);
    } else if (ctx) {
      ctx.close();
      this.detached.delete(projectId);
    }
    for (const k of [...this.pending.keys()]) {
      if (k.startsWith(`${projectId}/`)) {
        this.pending.delete(k);
        this.capacityRetries.delete(k);
      }
    }
    for (const k of [...this.handles.keys()]) {
      if (k.startsWith(`${projectId}/`)) this.handles.delete(k);
    }
    // Cancellation wakes pollers, but their async finally blocks still need a
    // turn before the detached SQLite handle is safe to remove. Awaiting this
    // in project deletion prevents Windows EPERM and avoids deleting a DB
    // underneath a worker. Callers that do not await retain the old best-effort
    // behaviour.
    const deadline = Date.now() + 30_000;
    while ([...this.active.keys()].some((key) => key.startsWith(`${projectId}/`)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (![...this.active.keys()].some((key) => key.startsWith(`${projectId}/`))) {
      const remaining = this.detached.get(projectId);
      remaining?.close();
      this.detached.delete(projectId);
      this.deferredClose.delete(projectId);
    }
  }

  // --- persistence ---------------------------------------------------------

  private saveStatus(projectId: string, jobId: string, status: RenderJobStatus, patch: Partial<Omit<RenderJob, 'id'>> = {}): void {
    if (this.stoppedProjects.has(projectId)) return;
    const p = this.ctxFor(projectId);
    if (!p) return;
    // Terminal states are final: a worker racing a cancel()/fail() must not
    // resurrect the job by writing a stale transient status over it (a cancel
    // that lands mid-submit used to be overwritten back to QUEUED/RUNNING).
    if (!TERMINAL_STATUSES.includes(status)) {
      const curStatus = p.db.get<{ status: string }>('SELECT status FROM render_jobs WHERE id = ?', [jobId])?.status;
      if (curStatus && TERMINAL_STATUSES.includes(curStatus as RenderJobStatus)) return;
    }
    const cols: string[] = ['status = ?'];
    const vals: unknown[] = [status];
    if (patch.providerTaskId !== undefined) {
      cols.push('provider_task_id = ?');
      vals.push(patch.providerTaskId);
    }
    if (patch.startedAt !== undefined) {
      cols.push('started_at = ?');
      vals.push(patch.startedAt);
    }
    if (patch.finishedAt !== undefined) {
      cols.push('finished_at = ?');
      vals.push(patch.finishedAt);
    }
    if (patch.error !== undefined) {
      cols.push('error = ?');
      vals.push(patch.error);
    }
    if (patch.providerResponseSnapshot !== undefined) {
      cols.push('provider_response_snapshot_json = ?');
      vals.push(j(patch.providerResponseSnapshot));
    }
    if (patch.cost !== undefined) {
      cols.push('cost_json = ?');
      vals.push(j(patch.cost));
    }
    if (patch.takeId !== undefined) {
      cols.push('take_id = ?');
      vals.push(patch.takeId);
    }
    vals.push(new Date().toISOString(), jobId);
    p.db.run(`UPDATE render_jobs SET ${cols.join(', ')}, updated_at = ? WHERE id = ?`, vals);
  }

  private getJob(projectId: string, jobId: string): RenderJob | null {
    const p = this.ctxFor(projectId);
    if (!p) return null;
    const r = p.db.get<JobRow>('SELECT * FROM render_jobs WHERE id = ?', [jobId]);
    if (!r) return null;
    const job = jobFromRow(r);
    if (!job.projectId) {
      // Legacy row without project_id: adopt the context it lives in.
      this.saveStatus(projectId, jobId, job.status, { providerTaskId: job.providerTaskId ?? undefined });
      job.projectId = projectId;
    }
    return job;
  }

  /**
   * Look a job up across all projects (jobs are owned by their project DB).
   * P2: opens connections TRANSIENTLY — cancel/retry are rare user actions,
   * and caching every project's handle here leaked one sqlite connection per
   * known project for the lifetime of the process.
   */
  private async findJobAnywhere(jobId: string, requestedProjectId?: string): Promise<{ job: RenderJob; projectId: string } | null> {
    if (requestedProjectId) {
      const ctx = await this.ensureDetached(requestedProjectId);
      if (!ctx) return null;
      const job = this.getJob(requestedProjectId, jobId);
      return job ? { job, projectId: requestedProjectId } : null;
    }
    const cur = this.getStore().current;
    if (cur) {
      const job = this.getJob(cur.meta.id, jobId);
      if (job) return { job, projectId: cur.meta.id };
    }
    for (const meta of await this.getStore().list()) {
      let ctx: ProjectContext | null = null;
      try {
        ctx = await this.getStore().openDetached(meta.id);
      } catch {
        continue;
      }
      try {
        const r = ctx.db.get<JobRow>('SELECT * FROM render_jobs WHERE id = ?', [jobId]);
        if (!r) continue;
        const job = jobFromRow(r);
        if (!job.projectId) {
          // Legacy row without project_id: adopt the context it lives in.
          ctx.db.run('UPDATE render_jobs SET project_id = ? WHERE id = ?', [meta.id, jobId]);
          job.projectId = meta.id;
        }
        return { job, projectId: meta.id };
      } finally {
        ctx.close();
      }
    }
    return null;
  }

  // --- public API ----------------------------------------------------------

  /** Re-evaluate waiting jobs after a Provider concurrency setting changes. */
  reschedule(): void {
    this.pump();
  }

  list(shotId?: string): RenderJob[] {
    const p = this.getStore().current;
    if (!p) return [];
    const rows = shotId
      ? p.db.all<JobRow>('SELECT * FROM render_jobs WHERE shot_id = ? ORDER BY created_at DESC', [shotId])
      : p.db.all<JobRow>('SELECT * FROM render_jobs ORDER BY created_at DESC');
    return rows.map((r) => {
      const job = jobFromRow(r);
      if (!job.projectId) job.projectId = p.meta.id;
      return job;
    });
  }

  /** Stable detached context for long-lived orchestration. It is owned by the
   * queue and remains valid when the interactive project changes. */
  async backgroundContext(projectId: string): Promise<ProjectContext | null> {
    return this.pipelineCtx(projectId);
  }

  /** Global queue view. Job ids repeat across project DBs, so every item is
   * returned with its owning project and display names. */
  async listAll(): Promise<RenderJob[]> {
    const out: RenderJob[] = [];
    for (const meta of await this.getStore().list()) {
      let ctx: ProjectContext | null = null;
      let close = false;
      try {
        if (this.getStore().current?.meta.id === meta.id) ctx = this.getStore().current;
        else if (this.detached.has(meta.id)) ctx = this.detached.get(meta.id)!;
        else {
          ctx = await this.getStore().openDetached(meta.id);
          close = true;
        }
        if (!ctx) continue;
        const projectCtx = ctx;
        const rows = projectCtx.db.all<JobRow>('SELECT * FROM render_jobs ORDER BY created_at DESC');
        for (const row of rows) {
          const job = jobFromRow(row);
          if (!job.projectId) job.projectId = meta.id;
          job.projectTitle = meta.title;
          job.shotTitle = projectCtx.db.get<{ title: string }>('SELECT title FROM shots WHERE id = ?', [job.shotId])?.title;
          out.push(job);
        }
      } catch {
        // A damaged/unavailable project should not hide other queue entries.
      } finally {
        if (close) ctx?.close();
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(jobId: string): RenderJob | null {
    const p = this.getStore().current;
    if (!p) return null;
    return this.getJob(p.meta.id, jobId);
  }

  /** Enqueue a render. Caller must have run preflight (blocked=false). */
  submit(input: { projectId: string; shotId: string; promptVersionId: string; provider: string; request: RenderRequest; intentHash: string }): RenderJob {
    const p = this.getStore().current;
    if (!p) throw new Error('no project open');
    if (input.projectId !== p.meta.id) throw new Error('render job must be created in the open project');
    return this.submitInContext(p, input);
  }

  /** Background equivalent used by persisted workflows. The returned job row
   * already exists before any Provider I/O begins, so callers can checkpoint
   * its id without a paid-submission recovery gap. */
  async submitDetached(input: { projectId: string; shotId: string; promptVersionId: string; provider: string; request: RenderRequest; intentHash: string }): Promise<RenderJob> {
    const p = await this.pipelineCtx(input.projectId);
    if (!p) throw new Error('project unavailable for render');
    return this.submitInContext(p, input);
  }

  private submitInContext(
    p: ProjectContext,
    input: { projectId: string; shotId: string; promptVersionId: string; provider: string; request: RenderRequest; intentHash: string },
  ): RenderJob {
    if (input.projectId !== p.meta.id) throw new Error('render job project mismatch');
    const shot = getShot(p, input.shotId);
    const prompt = getPrompt(p, input.promptVersionId);
    // One active task per Shot covers double-click, multi-tab, network replay,
    // and changing parameters while an earlier paid task is still running.
    const active = p.db.get<{ id: string; status: string }>(
      `SELECT id, status FROM render_jobs WHERE shot_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 1`,
      [input.shotId, ...ACTIVE_STATUSES],
    );
    if (active) {
      throw new Error(`a render job for this shot is already active (${active.id}, ${active.status}) — wait for it to finish or cancel it first`);
    }
    const dpvId = prompt.directorPlanVersionId;
    // P2: the row insert and its state transitions are one transaction — an
    // invalid transition used to throw AFTER the insert, leaving an orphan
    // SUBMITTING job that only restart recovery could clean up.
    const id = p.db.tx(() => {
      const newId = nextId(p.db, 'job');
      const now = new Date().toISOString();
      p.db.run(
        `INSERT INTO render_jobs (id, project_id, shot_id, prompt_version_id, director_plan_version_id, provider, status, request_snapshot_json, render_intent_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'LOCAL_QUEUED', ?, ?, ?, ?)`,
        [newId, p.meta.id, input.shotId, input.promptVersionId, dpvId, input.provider, j(input.request), input.intentHash, now, now],
      );
      updateShot(p, input.shotId, { h3Mode: input.request.mode });
      if (shot.status !== 'RENDERING') advanceShotStatus(p, input.shotId, 'RENDERING');
      return newId;
    });
    this.pending.set(runKey(p.meta.id, id), input.provider);
    this.bus.emit({ type: 'render.job.created', projectId: p.meta.id, jobId: id, shotId: input.shotId });
    this.pump();
    return this.getJob(p.meta.id, id)!;
  }

  /**
   * Best-effort cancel: stops local tracking and polling. A Provider may not
   * be able to stop work already running remotely or in a shared local queue.
   * Never throws 鈥?cancelling an already-finished/unknown job is a no-op.
   */
  async cancel(jobId: string, requestedProjectId?: string): Promise<void> {
    try {
      const found = await this.findJobAnywhere(jobId, requestedProjectId);
      if (!found) return;
      const { job, projectId: ownerProjectId } = found;
      const key = runKey(ownerProjectId, jobId);
      this.pending.delete(key);
      this.capacityRetries.delete(key);
      const handle = this.handles.get(key);
      if (handle) {
        const provider = this.registry.get(job.provider);
        if (provider) provider.cancel(handle).catch(() => undefined);
      }
      this.handles.delete(key);
      if (ACTIVE_STATUSES.includes(job.status)) {
        this.saveStatus(ownerProjectId, jobId, 'CANCELLED', { finishedAt: new Date().toISOString() });
        this.bus.emit({ type: 'render.job.updated', projectId: ownerProjectId, jobId, shotId: job.shotId, status: 'CANCELLED' });
        // Wake polling workers immediately so the Provider slot is released;
        // otherwise a cancellation could leave overflow jobs waiting for the
        // full production poll interval.
        for (const wake of this.waiters.get(ownerProjectId) ?? []) wake();
      }
    } catch (e) {
      // P1: cancel used to be fire-and-forget; an in-flight throw became an
      // unhandled rejection that could kill the process.
      console.error('[render-queue] cancel failed:', e);
    }
  }

  /**
   * Retry a FAILED/CANCELLED job. If RunningHub already returned a task id,
   * reconcile that paid remote task in place; otherwise create a NEW job for
   * traceability. Throws when retry is not allowed so callers can surface a
   * real error to the user.
   * P1 hardening over the old fire-and-forget version:
   *  - same-intent idempotency: a double-clicked retry cannot create two
   *    paid jobs;
   *  - the shot returns to RENDERING so take arrival advances HAS_TAKES
   *    instead of leaving it stuck in PREFLIGHT_READY/DIRECTED.
   */
  async retry(jobId: string, requestedProjectId?: string): Promise<void> {
    const found = await this.findJobAnywhere(jobId, requestedProjectId);
    if (!found) throw new Error(`render job not found: ${jobId}`);
    const { job, projectId: ownerProjectId } = found;
    if (job.status !== 'FAILED' && job.status !== 'CANCELLED') {
      throw new Error(`job is ${job.status} 鈥?only FAILED or CANCELLED jobs can be retried`);
    }
    const p = await this.pipelineCtx(ownerProjectId);
    if (!p) throw new Error('project unavailable for retry');
    if (!job.requestSnapshot) throw new Error('cannot retry: request snapshot missing');
    if (job.renderIntentHash) {
      const active = p.db.get<{ id: string }>(
        `SELECT id FROM render_jobs WHERE shot_id = ? AND render_intent_hash = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 1`,
        [job.shotId, job.renderIntentHash, ...ACTIVE_STATUSES],
      );
      if (active) throw new Error(`a render job for this exact intent is already active (${active.id}) 鈥?wait for it to finish`);
    }
    // A provider task id means RunningHub already accepted (and may already
    // have charged for) this render. A local polling/network failure must be
    // reconciled against that SAME remote task instead of submitting another
    // paid job. This also recovers locally-cancelled tasks because RunningHub
    // AI App tasks cannot be cancelled remotely.
    if (job.providerTaskId) {
      const now = new Date().toISOString();
      p.db.run(
        "UPDATE render_jobs SET status = 'QUEUED', error = NULL, finished_at = NULL, updated_at = ? WHERE id = ?",
        [now, job.id],
      );
      this.handles.set(runKey(ownerProjectId, job.id), { providerTaskId: job.providerTaskId });
      this.pending.set(runKey(ownerProjectId, job.id), job.provider);
      this.bus.emit({ type: 'render.job.queued', projectId: ownerProjectId, jobId: job.id, shotId: job.shotId });
      try {
        const shot = getShot(p, job.shotId);
        if (shot.status !== 'RENDERING') advanceTo(p, job.shotId, 'RENDERING');
      } catch (e) {
        console.warn('[render-queue] could not advance shot while reconciling remote task:', e instanceof Error ? e.message : e);
      }
      this.pump();
      return;
    }
    const prompt = getPrompt(p, job.promptVersionId);
    const newId = nextId(p.db, 'job');
    const now = new Date().toISOString();
    p.db.run(
      `INSERT INTO render_jobs (id, project_id, shot_id, prompt_version_id, director_plan_version_id, provider, status, request_snapshot_json, render_intent_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'LOCAL_QUEUED', ?, ?, ?, ?)`,
      [newId, ownerProjectId, job.shotId, job.promptVersionId, prompt.directorPlanVersionId, job.provider, j(job.requestSnapshot), job.renderIntentHash, now, now],
    );
    this.pending.set(runKey(ownerProjectId, newId), job.provider);
    this.bus.emit({ type: 'render.job.created', projectId: ownerProjectId, jobId: newId, shotId: job.shotId });
    try {
      const shot = getShot(p, job.shotId);
      if (shot.status !== 'RENDERING') advanceTo(p, job.shotId, 'RENDERING');
    } catch (e) {
      console.warn('[render-queue] could not advance shot to RENDERING on retry:', e instanceof Error ? e.message : e);
    }
    this.pump();
  }

  /** Boot recovery: requeue active jobs of EVERY project, keep polling known
   * taskIds. Never resubmits (no double cost).
   * P2: scans through TRANSIENT connections — only projects that actually
   * hold recovered jobs get cached later (the worker opens its own context). */
  async recover(): Promise<void> {
    let recovered = 0;
    for (const meta of await this.getStore().list()) {
      let p: ProjectContext | null = null;
      try {
        p = await this.getStore().openDetached(meta.id);
      } catch {
        continue;
      }
      try {
        const rows = p.db.all<JobRow>("SELECT * FROM render_jobs WHERE status IN ('LOCAL_QUEUED','UPLOADING','SUBMITTING','QUEUED','RUNNING','DOWNLOADING')");
        for (const r of rows) {
          const job = jobFromRow(r);
          if (!job.projectId) {
            p.db.run('UPDATE render_jobs SET project_id = ? WHERE id = ?', [meta.id, job.id]);
            job.projectId = meta.id;
          }
          if (job.providerTaskId) {
            // Resume polling immediately; no resubmit (avoid double cost).
            this.handles.set(runKey(job.projectId, job.id), { providerTaskId: job.providerTaskId });
            this.pending.set(runKey(job.projectId, job.id), job.provider);
          } else if (job.status === 'LOCAL_QUEUED') {
            // This state has not crossed the provider boundary and is safe to
            // submit after restart without risking a duplicate paid task.
            this.pending.set(runKey(job.projectId, job.id), job.provider);
          } else {
            // Never resubmitted without user action — mark failed with a hint.
            const now = new Date().toISOString();
            p.db.run(
              'UPDATE render_jobs SET status = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?',
              ['FAILED', 'interrupted before provider taskId was returned; retry to render', now, now, job.id],
            );
            const shot = getShot(p, job.shotId);
            if (shot.status === 'RENDERING') {
              advanceShotStatus(p, job.shotId, 'PREFLIGHT_READY');
            }
            this.bus.emit({ type: 'render.job.failed', projectId: job.projectId, jobId: job.id, shotId: job.shotId, error: 'interrupted before provider taskId was returned; retry to render' });
          }
          recovered++;
        }
      } finally {
        p.close();
      }
    }
    if (recovered > 0) console.log(`[render-queue] recovered ${recovered} active job(s)`);
    this.bus.emit({ type: 'project.updated' });
    this.pump();
  }

  // --- worker --------------------------------------------------------------

  private pump(): void {
    // Start every FIFO job whose Provider still has capacity. A long-running
    // poll occupies only that Provider's slot and no longer blocks unrelated
    // providers or independent projects.
    for (const [key, provider] of [...this.pending]) {
      const cooldownUntil = this.providerCooldownUntil.get(provider) ?? 0;
      if (cooldownUntil > Date.now()) continue;
      if (cooldownUntil) this.providerCooldownUntil.delete(provider);
      const used = [...this.active.values()].filter((id) => id === provider).length;
      if (used >= this.providerLimit(provider)) continue;
      this.pending.delete(key);
      this.active.set(key, provider);
      void this.work(key).finally(() => {
        this.active.delete(key);
        const sep = key.indexOf('/');
        const projectId = key.slice(0, sep);
        if (this.deferredClose.has(projectId) && ![...this.active.keys()].some((activeKey) => activeKey.startsWith(`${projectId}/`))) {
          this.deferredClose.delete(projectId);
          const ctx = this.detached.get(projectId);
          ctx?.close();
          this.detached.delete(projectId);
        }
        this.pump();
      });
    }
  }

  private async work(key: string): Promise<void> {
    try {
      const sep = key.indexOf('/');
      const projectId = key.slice(0, sep);
      const jobId = key.slice(sep + 1);
      const ctx = await this.pipelineCtx(projectId);
      if (!ctx) return;
      const job = this.getJob(projectId, jobId);
      if (!job) return;
      await this.process(job);
    } catch (e) {
      console.error('[render-queue] worker error:', e);
    }
  }

  private async process(job: RenderJob): Promise<void> {
    // P1: resolve the owning project even when the UI switched away 鈥?a bare
    // ctxFor() returns null after the switch and silently dropped the job.
    const p = await this.pipelineCtx(job.projectId);
    if (!p) return;
    const provider = this.registry.get(job.provider);
    if (!provider) {
      await this.fail(job, 'provider not found: ' + job.provider);
      return;
    }
    try {
      if (this.stoppedProjects.has(job.projectId)) return;
      // 1) Upload references if we have a fresh job (no handle yet).
      if (!this.handles.has(runKey(job.projectId, job.id)) && job.requestSnapshot) {
        // LOCAL_QUEUED is only waiting for a provider slot. Start elapsed
        // execution time when the worker actually owns that slot, before the
        // first upload/provider call, and keep this timestamp for all later
        // stages.
        this.saveStatus(job.projectId, job.id, 'UPLOADING', { startedAt: job.startedAt ?? new Date().toISOString(), error: null });
        this.bus.emit({ type: 'render.job.updated', projectId: job.projectId, jobId: job.id, shotId: job.shotId, status: 'UPLOADING' });
        const uploads: Record<string, string> = {};
        for (const ref of job.requestSnapshot.references) {
          const asset = getMedia(p, ref.assetId);
          const abs = p.resolveProjectPath(asset.fileName);
          const uploaded = await provider.uploadAsset(asset, abs);
          uploads[ref.assetId] = uploaded.providerRef;
        }
        this.saveStatus(job.projectId, job.id, 'SUBMITTING');
        const prompt = getPrompt(p, job.promptVersionId);
        const handle = await provider.submit({
          mode: job.requestSnapshot.mode,
          prompt: prompt.text,
          durationSeconds: job.requestSnapshot.durationSeconds,
          aspectRatio: job.requestSnapshot.aspectRatio,
          resolution: job.requestSnapshot.resolution,
          megapixels: job.requestSnapshot.megapixels,
          references: job.requestSnapshot.references.map((r) => {
            const binding = p.db.get<{ roles_json: string | null }>('SELECT roles_json FROM reference_bindings WHERE id = ?', [r.bindingId]);
            return {
              asset: getMedia(p, r.assetId),
              roles: (jget<string[]>(binding?.roles_json ?? '[]', []) as import('@h3mise/shared').ReferenceRole[]) ?? [],
              label: r.bindingId,
              providerRef: uploads[r.assetId] ?? '',
            };
          }),
          providerParams: job.requestSnapshot.providerParams,
        });
        this.handles.set(runKey(job.projectId, job.id), handle);
        this.capacityRetries.delete(runKey(job.projectId, job.id));
        this.saveStatus(job.projectId, job.id, 'QUEUED', { providerTaskId: handle.providerTaskId, providerResponseSnapshot: handle.raw });
        // P0-6: a real submission that returned a taskId confirms the node
        // mapping is executable 鈫?profile becomes 'verified'.
        if (job.provider !== 'mock') {
          try {
            this.registry.confirmProviderVerified(job.provider);
          } catch {
            /* profile persistence is best-effort here */
          }
        }
        this.bus.emit({ type: 'render.job.queued', projectId: job.projectId, jobId: job.id, shotId: job.shotId });
        await this.pollUntilDone(job);
        return;
      }

      // 2) Job has a handle (recovered or already submitted) 鈥?poll.
      if (this.handles.has(runKey(job.projectId, job.id))) {
        await this.pollUntilDone(job);
      }
    } catch (e) {
      if (e instanceof ProviderError) {
        if (e.retry?.reason === 'provider_capacity' && !this.handles.has(runKey(job.projectId, job.id))) {
          this.deferForProviderCapacity(job, e);
          return;
        }
        await this.fail(job, `${e.stage}: ${e.message}`);
      } else {
        await this.fail(job, e instanceof Error ? e.message : String(e));
      }
    }
  }

  /** A capacity rejection has no provider task id and therefore no paid task
   * to reconcile. Put the same job back in the local queue and pause the whole
   * provider before trying again; never drain the rest of the batch into the
   * same full remote queue. */
  private deferForProviderCapacity(job: RenderJob, error: ProviderError): void {
    const key = runKey(job.projectId, job.id);
    const attempt = (this.capacityRetries.get(key) ?? 0) + 1;
    this.capacityRetries.set(key, attempt);
    const requested = Math.max(this.capacityRetryBaseMs, error.retry?.afterMs ?? 0);
    const delay = Math.min(120_000, requested * 2 ** Math.min(2, attempt - 1));
    const until = Date.now() + delay;
    this.providerCooldownUntil.set(job.provider, Math.max(this.providerCooldownUntil.get(job.provider) ?? 0, until));
    this.saveStatus(job.projectId, job.id, 'LOCAL_QUEUED', {
      startedAt: null,
      error: `生成服务并发队列已满，已保留任务，将在${Math.ceil(delay / 1000)}秒后自动继续（未产生新的付费任务）`,
    });
    this.pending.set(key, job.provider);
    this.bus.emit({ type: 'render.job.updated', projectId: job.projectId, jobId: job.id, shotId: job.shotId, status: 'LOCAL_QUEUED' });
    const timer = setTimeout(() => {
      const current = this.providerCooldownUntil.get(job.provider) ?? 0;
      if (current <= Date.now()) this.providerCooldownUntil.delete(job.provider);
      this.pump();
    }, delay + 10);
    timer.unref();
  }

  private async pollUntilDone(job: RenderJob): Promise<void> {
    // The caller's `job` is a pre-submit snapshot (no providerTaskId yet) 鈥?
    // re-read the row the worker itself persisted so polling actually starts.
    const fresh = (await this.getJobEnsured(job.projectId, job.id)) ?? job;
    if (!fresh.providerTaskId) return;
    const provider = this.registry.get(job.provider);
    if (!provider) {
      await this.fail(job, 'provider not found');
      return;
    }
    const handle = this.handles.get(runKey(job.projectId, job.id))!;
    let lastStatus: RenderJobStatus = job.status;
    // P1: a paid render must survive transient polling hiccups (network
    // blips, unrecognized payloads). Fail only after a sustained streak 鈥?
    // roughly 5 minutes at production pollMs, bounded for fast test polls.
    const maxTransient = Math.min(60, Math.max(3, Math.round(300_000 / this.pollMs)));
    let transientStreak = 0;
    for (let i = 0; i < 600; i++) {
      if (this.stoppedProjects.has(job.projectId)) return;
      // CANCELLED/FAILED while polling? Re-read through pipelineCtx — a UI
      // project switch must not end the poll silently.
      const cur = await this.getJobEnsured(job.projectId, job.id);
      // The row disappearing means its Shot/project was deliberately deleted.
      // Do not hold the single worker for the remainder of the 100-minute poll
      // budget; stop tracking the now-orphaned remote task immediately.
      if (!cur) {
        this.handles.delete(runKey(job.projectId, job.id));
        return;
      }
      if (cur.status === 'CANCELLED' || cur.status === 'FAILED') return;
      let st;
      try {
        st = await provider.status(handle);
        if (st.transient) {
          transientStreak += 1;
          if (transientStreak >= maxTransient) {
            await this.fail(cur, `provider unusable for ${transientStreak} consecutive polls: ${st.error ?? 'unknown'}`);
            return;
          }
          await this.wait(job.projectId, this.pollMs);
          continue;
        }
        transientStreak = 0;
      } catch (e) {
        transientStreak += 1;
        if (transientStreak >= maxTransient) throw e instanceof Error ? e : new Error(String(e));
        await this.wait(job.projectId, this.pollMs);
        continue;
      }
      const mapped: RenderJobStatus = st.status === 'SUCCEEDED' ? 'SUCCEEDED' : st.status === 'FAILED' ? 'FAILED' : st.status === 'EXPIRED' ? 'EXPIRED' : 'RUNNING';
      if (mapped === 'SUCCEEDED') {
        this.saveStatus(job.projectId, job.id, 'DOWNLOADING', { startedAt: cur.startedAt ?? new Date().toISOString() });
        this.bus.emit({ type: 'render.job.updated', projectId: job.projectId, jobId: job.id, shotId: cur.shotId, status: 'DOWNLOADING' });
        const res = await provider.result(handle);
        await this.downloadAndCreateTake(cur, res.url, res.cost);
        this.handles.delete(runKey(job.projectId, job.id));
        return;
      }
      if (mapped === 'FAILED' || mapped === 'EXPIRED') {
        await this.fail(cur, st.error ?? `provider task ${mapped.toLowerCase()}`);
        return;
      }
      if (mapped !== lastStatus) {
        lastStatus = mapped;
        this.saveStatus(job.projectId, job.id, mapped, { startedAt: cur.startedAt ?? new Date().toISOString() });
        this.bus.emit({ type: 'render.job.running', projectId: job.projectId, jobId: job.id, shotId: cur.shotId });
      }
      await this.wait(job.projectId, this.pollMs);
    }
    await this.fail(job, 'poll timeout (100 minutes)');
  }

  /** getJob that also materializes the owning project context on demand. */
  private async getJobEnsured(projectId: string, jobId: string): Promise<RenderJob | null> {
    const ctx = await this.pipelineCtx(projectId);
    if (!ctx) return null;
    return this.getJob(projectId, jobId);
  }

  private async downloadAndCreateTake(job: RenderJob, url: string, cost?: RenderJob['cost']): Promise<void> {
    const p = await this.pipelineCtx(job.projectId);
    if (!p) return;
    // Idempotent take creation: if a take already exists for this job (crash
    // between INSERT and status update), reuse it instead of creating a second.
    const existing = p.db.get<{ id: string }>('SELECT id FROM takes WHERE render_job_id = ?', [job.id]);
    if (existing) {
      this.saveStatus(job.projectId, job.id, 'LOCAL_READY', { finishedAt: new Date().toISOString(), cost, takeId: existing.id });
      this.bus.emit({ type: 'render.job.succeeded', projectId: job.projectId, jobId: job.id, shotId: job.shotId, takeId: existing.id });
      return;
    }
    const dir = p.paths.shotTakes(job.shotId);
    const filePath = join(dir, `take-${job.id}.mp4`);
    const partPath = filePath + '.part';
    await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }));
    if (/^mock:/.test(url)) {
      await import('node:fs/promises').then((fs) => fs.copyFile(url.slice('mock://'.length), filePath));
    } else {
      const res = await fetch(url, { signal: AbortSignal.timeout(600_000) });
      if (!res.ok) throw new ProviderError(`download failed HTTP ${res.status}`, 'download');
      if (!res.body) throw new ProviderError('download failed: empty response body', 'download');
      // Stream potentially large render files to disk, then atomically rename.
      const fs = await import('node:fs/promises');
      try {
        await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(partPath));
      } catch (error) {
        await fs.rm(partPath, { force: true });
        throw error;
      }
      await fs.rename(partPath, filePath);
    }
    const info = await this.ffmpeg.probe(filePath);
    const rel = filePath.slice(p.root.length + 1);
    const take = await createTake(p, {
      shotId: job.shotId,
      renderJobId: job.id,
      promptVersionId: job.promptVersionId,
      directorPlanVersionId: job.directorPlanVersionId,
      localVideoPath: rel,
      duration: info.durationSeconds ?? job.requestSnapshot?.durationSeconds ?? 0,
    }, this.ffmpeg);
    this.saveStatus(job.projectId, job.id, 'LOCAL_READY', { finishedAt: new Date().toISOString(), cost, takeId: take.id });
    this.bus.emit({ type: 'render.job.succeeded', projectId: job.projectId, jobId: job.id, shotId: job.shotId, takeId: take.id });
    this.bus.emit({ type: 'take.created', takeId: take.id, shotId: job.shotId });
    const shot = getShot(p, job.shotId);
    if (shot.status === 'RENDERING') advanceShotStatus(p, job.shotId, 'HAS_TAKES');
  }

  private async fail(job: RenderJob, error: string): Promise<void> {
    this.saveStatus(job.projectId, job.id, 'FAILED', { error, finishedAt: new Date().toISOString() });
    this.handles.delete(runKey(job.projectId, job.id));
    this.bus.emit({ type: 'render.job.failed', projectId: job.projectId, jobId: job.id, shotId: job.shotId, error });
    const p = await this.pipelineCtx(job.projectId);
    if (p) {
      const shot = getShot(p, job.shotId);
      if (shot.status === 'RENDERING') advanceShotStatus(p, job.shotId, 'PREFLIGHT_READY');
    }
  }

  private wait(projectId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const waiters = this.waiters.get(projectId) ?? new Set<() => void>();
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        waiters.delete(done);
        if (waiters.size === 0) this.waiters.delete(projectId);
        resolve();
      };
      const timer = setTimeout(done, ms);
      waiters.add(done);
      this.waiters.set(projectId, waiters);
      if (this.stoppedProjects.has(projectId)) done();
    });
  }
}
