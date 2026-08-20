// Render Queue — PRD §27-28. Persisted jobs; a single worker processes the
// queue sequentially (cost protection); the queue survives restarts and
// re-polls provider tasks. Events push status to the UI (SSE).
//
// P0-1: every queued task is pinned to the project that created it
// (projectId is persisted on the job row). Upload / poll / download / take
// creation always re-open THAT project and never read `store.current`, so
// switching projects in the UI can never corrupt or collide with jobs.
// Job ids are per-project counters, so runtime keys are `projectId/jobId`.

import { join } from 'node:path';
import type { RenderJob, RenderJobStatus, RenderRequest } from '@h3mise/shared';
import type { ProjectContext, ProjectStore } from '../project-store.js';
import { j, jget, jgetOrNull } from '../db/sqlite.js';
import { nextId } from '../db/ids.js';
import type { EventBus } from '../events.js';
import type { Ffmpeg } from '../ffmpeg.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { RenderJobHandle } from '../providers/types.js';
import { ProviderError } from '../providers/types.js';
import { getShot, updateShot, advanceShotStatus } from './shots.js';
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

const ACTIVE_STATUSES: RenderJobStatus[] = ['UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING'];

const runKey = (projectId: string, jobId: string) => `${projectId}/${jobId}`;

export class RenderQueue {
  private pending = new Set<string>();
  private handles = new Map<string, RenderJobHandle>();
  private running = false;
  private readonly pollMs: number;
  /** Detached contexts for projects with active jobs (never `store.current`). */
  private readonly detached = new Map<string, ProjectContext>();

  constructor(
    private readonly getStore: () => ProjectStore,
    private readonly registry: ProviderRegistry,
    private readonly ffmpeg: Ffmpeg,
    private readonly bus: EventBus,
    pollMs = 10_000,
  ) {
    this.pollMs = pollMs;
  }

  // --- project contexts ----------------------------------------------------

  /**
   * Context for a job's owning project: the live current context when it
   * matches, otherwise a cached detached one. Never switches `store.current`.
   */
  private ctxFor(projectId: string): ProjectContext | null {
    const cur = this.getStore().current;
    if (cur && cur.meta.id === projectId) return cur;
    let ctx = this.detached.get(projectId);
    if (!ctx) return null;
    return ctx;
  }

  private async ensureDetached(projectId: string): Promise<ProjectContext | null> {
    const cur = this.getStore().current;
    if (cur && cur.meta.id === projectId) return cur;
    let ctx = this.detached.get(projectId);
    if (ctx) return ctx;
    try {
      ctx = await this.getStore().openDetached(projectId);
      this.detached.set(projectId, ctx);
      return ctx;
    } catch {
      return null;
    }
  }

  /** Drop a detached context (e.g. project deleted while jobs were pending). */
  forgetProject(projectId: string): void {
    const ctx = this.detached.get(projectId);
    if (ctx) {
      ctx.close();
      this.detached.delete(projectId);
    }
    for (const k of [...this.pending]) {
      if (k.startsWith(`${projectId}/`)) this.pending.delete(k);
    }
    for (const k of [...this.handles.keys()]) {
      if (k.startsWith(`${projectId}/`)) this.handles.delete(k);
    }
  }

  // --- persistence ---------------------------------------------------------

  private saveStatus(projectId: string, jobId: string, status: RenderJobStatus, patch: Partial<Omit<RenderJob, 'id'>> = {}): void {
    const p = this.ctxFor(projectId);
    if (!p) return;
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

  /** Look a job up across all projects (jobs are owned by their project DB). */
  private async findJobAnywhere(jobId: string): Promise<{ job: RenderJob; projectId: string } | null> {
    const cur = this.getStore().current;
    if (cur) {
      const job = this.getJob(cur.meta.id, jobId);
      if (job) return { job, projectId: cur.meta.id };
    }
    for (const meta of await this.getStore().list()) {
      const ctx = await this.ensureDetached(meta.id);
      if (!ctx) continue;
      const job = this.getJob(meta.id, jobId);
      if (job) return { job, projectId: meta.id };
    }
    return null;
  }

  // --- public API ----------------------------------------------------------

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
    const shot = getShot(p, input.shotId);
    const prompt = getPrompt(p, input.promptVersionId);
    // Idempotency: the same intent already active for this shot is rejected —
    // covers double-click, multi-tab, and network replay (no double cost).
    const active = p.db.get<{ id: string; status: string }>(
      `SELECT id, status FROM render_jobs WHERE shot_id = ? AND render_intent_hash = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 1`,
      [input.shotId, input.intentHash, ...ACTIVE_STATUSES],
    );
    if (active) {
      throw new Error(`a render job for this exact intent is already active (${active.id}, ${active.status}) — wait for it to finish or change parameters`);
    }
    const id = nextId(p.db, 'job');
    const now = new Date().toISOString();
    const dpvId = prompt.directorPlanVersionId;
    p.db.run(
      `INSERT INTO render_jobs (id, project_id, shot_id, prompt_version_id, director_plan_version_id, provider, status, request_snapshot_json, render_intent_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'SUBMITTING', ?, ?, ?, ?)`,
      [id, p.meta.id, input.shotId, input.promptVersionId, dpvId, input.provider, j(input.request), input.intentHash, now, now],
    );
    updateShot(p, input.shotId, { h3Mode: input.request.mode });
    if (shot.status !== 'RENDERING') advanceShotStatus(p, input.shotId, 'RENDERING');
    this.pending.add(runKey(p.meta.id, id));
    this.bus.emit({ type: 'render.job.created', jobId: id, shotId: input.shotId });
    this.pump();
    return this.getJob(p.meta.id, id)!;
  }

  cancel(jobId: string): void {
    void this.doCancel(jobId);
  }

  private async doCancel(jobId: string): Promise<void> {
    const found = await this.findJobAnywhere(jobId);
    if (!found) return;
    const { job, projectId } = found;
    const key = runKey(projectId, jobId);
    this.pending.delete(key);
    const handle = this.handles.get(key);
    if (handle) {
      const provider = this.registry.get(job.provider);
      if (provider) provider.cancel(handle).catch(() => undefined);
    }
    if (ACTIVE_STATUSES.includes(job.status)) {
      this.saveStatus(projectId, jobId, 'CANCELLED', { finishedAt: new Date().toISOString() });
      this.bus.emit({ type: 'render.job.updated', jobId, shotId: job.shotId, status: 'CANCELLED' });
    }
  }

  retry(jobId: string): void {
    // P1: retry creates a NEW job (keeps the failed attempt's traceability),
    // linked via the request snapshot; the old job stays as the failure record.
    void this.doRetry(jobId);
  }

  private async doRetry(jobId: string): Promise<void> {
    const found = await this.findJobAnywhere(jobId);
    if (!found) return;
    const { job, projectId } = found;
    if (job.status !== 'FAILED' && job.status !== 'CANCELLED') return;
    const p = await this.ensureDetached(projectId);
    if (!p || !job.requestSnapshot) return;
    const newId = nextId(p.db, 'job');
    const now = new Date().toISOString();
    const prompt = getPrompt(p, job.promptVersionId);
    p.db.run(
      `INSERT INTO render_jobs (id, project_id, shot_id, prompt_version_id, director_plan_version_id, provider, status, request_snapshot_json, render_intent_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'SUBMITTING', ?, ?, ?, ?)`,
      [newId, projectId, job.shotId, job.promptVersionId, prompt.directorPlanVersionId, job.provider, j(job.requestSnapshot), job.renderIntentHash, now, now],
    );
    this.pending.add(runKey(projectId, newId));
    this.bus.emit({ type: 'render.job.created', jobId: newId, shotId: job.shotId });
    this.pump();
  }

  /** Boot recovery: requeue active jobs of EVERY project, keep polling known
   * taskIds. Never resubmits (no double cost). */
  async recover(): Promise<void> {
    for (const meta of await this.getStore().list()) {
      const p = await this.ensureDetached(meta.id);
      if (!p) continue;
      const rows = p.db.all<JobRow>("SELECT * FROM render_jobs WHERE status IN ('UPLOADING','SUBMITTING','QUEUED','RUNNING','DOWNLOADING')");
      for (const r of rows) {
        const job = jobFromRow(r);
        if (!job.projectId) {
          p.db.run('UPDATE render_jobs SET project_id = ? WHERE id = ?', [meta.id, job.id]);
          job.projectId = meta.id;
        }
        if (job.providerTaskId) {
          // Resume polling immediately; no resubmit (avoid double cost).
          this.handles.set(runKey(job.projectId, job.id), { providerTaskId: job.providerTaskId });
          this.pending.add(runKey(job.projectId, job.id));
        } else {
          // Never resubmitted without user action — mark failed with a hint.
          this.saveStatus(job.projectId, job.id, 'FAILED', { error: 'interrupted before provider taskId was returned; retry to render' });
        }
      }
    }
    this.bus.emit({ type: 'project.updated' });
    this.pump();
  }

  // --- worker --------------------------------------------------------------

  private pump(): void {
    if (this.running) return;
    this.running = true;
    void this.work();
  }

  private async work(): Promise<void> {
    try {
      while (this.pending.size > 0) {
        const key = this.pending.values().next().value as string | undefined;
        if (!key) break;
        this.pending.delete(key);
        const sep = key.indexOf('/');
        const projectId = key.slice(0, sep);
        const jobId = key.slice(sep + 1);
        const ctx = await this.ensureDetached(projectId);
        if (!ctx) continue;
        const job = this.getJob(projectId, jobId);
        if (!job) continue;
        await this.process(job);
      }
    } catch (e) {
      console.error('[render-queue] worker error:', e);
    } finally {
      this.running = false;
      if (this.pending.size > 0) this.pump();
    }
  }

  private async process(job: RenderJob): Promise<void> {
    const p = this.ctxFor(job.projectId);
    if (!p) return;
    const provider = this.registry.get(job.provider);
    if (!provider) {
      this.fail(job, 'provider not found: ' + job.provider);
      return;
    }
    try {
      // 1) Upload references if we have a fresh job (no handle yet).
      if (!this.handles.has(runKey(job.projectId, job.id)) && job.requestSnapshot) {
        this.saveStatus(job.projectId, job.id, 'UPLOADING');
        this.bus.emit({ type: 'render.job.updated', jobId: job.id, shotId: job.shotId, status: 'UPLOADING' });
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
        this.saveStatus(job.projectId, job.id, 'QUEUED', { providerTaskId: handle.providerTaskId, providerResponseSnapshot: handle.raw });
        // P0-6: a real submission that returned a taskId confirms the node
        // mapping is executable → profile becomes 'verified'.
        if (job.provider !== 'mock') {
          try {
            this.registry.confirmVerified();
          } catch {
            /* profile persistence is best-effort here */
          }
        }
        this.bus.emit({ type: 'render.job.queued', jobId: job.id, shotId: job.shotId });
        await this.pollUntilDone(job);
        return;
      }

      // 2) Job has a handle (recovered or already submitted) — poll.
      if (this.handles.has(runKey(job.projectId, job.id))) {
        await this.pollUntilDone(job);
      }
    } catch (e) {
      if (e instanceof ProviderError) {
        this.fail(job, `${e.stage}: ${e.message}`);
      } else {
        this.fail(job, e instanceof Error ? e.message : String(e));
      }
    }
  }

  private async pollUntilDone(job: RenderJob): Promise<void> {
    // The caller's `job` is a pre-submit snapshot (no providerTaskId yet) —
    // re-read the row the worker itself persisted so polling actually starts.
    const fresh = this.getJob(job.projectId, job.id) ?? job;
    if (!fresh.providerTaskId) return;
    const provider = this.registry.get(job.provider);
    if (!provider) {
      this.fail(job, 'provider not found');
      return;
    }
    const handle = this.handles.get(runKey(job.projectId, job.id))!;
    let lastStatus: RenderJobStatus = job.status;
    for (let i = 0; i < 600; i++) {
      // CANCELLED/FAILED while polling?
      const cur = this.getJob(job.projectId, job.id);
      if (!cur) return;
      if (cur.status === 'CANCELLED' || cur.status === 'FAILED') return;
      const st = await provider.status(handle);
      const mapped: RenderJobStatus = st.status === 'SUCCEEDED' ? 'SUCCEEDED' : st.status === 'FAILED' ? 'FAILED' : st.status === 'EXPIRED' ? 'EXPIRED' : 'RUNNING';
      if (mapped === 'SUCCEEDED') {
        this.saveStatus(job.projectId, job.id, 'DOWNLOADING', { startedAt: new Date().toISOString() });
        this.bus.emit({ type: 'render.job.updated', jobId: job.id, shotId: cur.shotId, status: 'DOWNLOADING' });
        const res = await provider.result(handle);
        await this.downloadAndCreateTake(cur, res.url, res.cost);
        return;
      }
      if (mapped === 'FAILED' || mapped === 'EXPIRED') {
        this.fail(cur, st.error ?? `provider task ${mapped.toLowerCase()}`);
        return;
      }
      if (mapped !== lastStatus) {
        lastStatus = mapped;
        this.saveStatus(job.projectId, job.id, mapped, { startedAt: cur.startedAt ?? new Date().toISOString() });
        this.bus.emit({ type: 'render.job.running', jobId: job.id, shotId: cur.shotId });
      }
      await sleep(this.pollMs);
    }
    this.fail(job, 'poll timeout (100 minutes)');
  }

  private async downloadAndCreateTake(job: RenderJob, url: string, cost?: RenderJob['cost']): Promise<void> {
    const p = this.ctxFor(job.projectId);
    if (!p) return;
    // Idempotent take creation: if a take already exists for this job (crash
    // between INSERT and status update), reuse it instead of creating a second.
    const existing = p.db.get<{ id: string }>('SELECT id FROM takes WHERE render_job_id = ?', [job.id]);
    if (existing) {
      this.saveStatus(job.projectId, job.id, 'LOCAL_READY', { finishedAt: new Date().toISOString(), cost, takeId: existing.id });
      this.bus.emit({ type: 'render.job.succeeded', jobId: job.id, shotId: job.shotId, takeId: existing.id });
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
      const buf = Buffer.from(await res.arrayBuffer());
      // Atomic-ish: write .part, then rename into place (P0-3).
      const fs = await import('node:fs/promises');
      await fs.writeFile(partPath, buf);
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
    this.bus.emit({ type: 'render.job.succeeded', jobId: job.id, shotId: job.shotId, takeId: take.id });
    this.bus.emit({ type: 'take.created', takeId: take.id, shotId: job.shotId });
    const shot = getShot(p, job.shotId);
    if (shot.status === 'RENDERING') advanceShotStatus(p, job.shotId, 'HAS_TAKES');
  }

  private fail(job: RenderJob, error: string): void {
    this.saveStatus(job.projectId, job.id, 'FAILED', { error, finishedAt: new Date().toISOString() });
    this.handles.delete(runKey(job.projectId, job.id));
    this.bus.emit({ type: 'render.job.failed', jobId: job.id, shotId: job.shotId, error });
    const p = this.ctxFor(job.projectId);
    if (p) {
      const shot = getShot(p, job.shotId);
      if (shot.status === 'RENDERING') advanceShotStatus(p, job.shotId, 'PREFLIGHT_READY');
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}