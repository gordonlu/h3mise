// Render Queue — PRD §27-28. Persisted jobs; a single worker processes the
// queue sequentially (cost protection); the queue survives restarts and
// re-polls provider tasks. Events push status to the UI (SSE).

import { join } from 'node:path';
import type { RenderJob, RenderJobStatus, RenderRequest } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
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
    providerResponseSnapshot: jgetOrNull<Record<string, unknown>>(r.provider_response_snapshot_json),
    cost: jgetOrNull<RenderJob['cost']>(r.cost_json),
    error: r.error,
    takeId: r.take_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const ACTIVE_STATUSES: RenderJobStatus[] = ['UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING'];

export class RenderQueue {
  private pending = new Set<string>();
  private handles = new Map<string, RenderJobHandle>();
  private running = false;
  private readonly pollMs: number;

  constructor(
    private readonly getProject: () => ProjectContext | null,
    private readonly registry: ProviderRegistry,
    private readonly ffmpeg: Ffmpeg,
    private readonly bus: EventBus,
    pollMs = 10_000,
  ) {
    this.pollMs = pollMs;
  }

  // --- persistence ---------------------------------------------------------

  private saveStatus(jobId: string, status: RenderJobStatus, patch: Partial<Omit<RenderJob, 'id'>> = {}): void {
    const p = this.getProject();
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

  private getJob(jobId: string): RenderJob | null {
    const p = this.getProject();
    if (!p) return null;
    const r = p.db.get<JobRow>('SELECT * FROM render_jobs WHERE id = ?', [jobId]);
    return r ? jobFromRow(r) : null;
  }

  // --- public API ----------------------------------------------------------

  list(shotId?: string): RenderJob[] {
    const p = this.getProject();
    if (!p) return [];
    const rows = shotId
      ? p.db.all<JobRow>('SELECT * FROM render_jobs WHERE shot_id = ? ORDER BY created_at DESC', [shotId])
      : p.db.all<JobRow>('SELECT * FROM render_jobs ORDER BY created_at DESC');
    return rows.map(jobFromRow);
  }

  get(jobId: string): RenderJob | null {
    return this.getJob(jobId);
  }

  /** Enqueue a render. Caller must have run preflight (blocked=false). */
  submit(input: { shotId: string; promptVersionId: string; provider: string; request: RenderRequest }): RenderJob {
    const p = this.getProject();
    if (!p) throw new Error('no project open');
    const shot = getShot(p, input.shotId);
    const prompt = getPrompt(p, input.promptVersionId);
    const id = nextId(p.db, 'job');
    const now = new Date().toISOString();
    const dpvId = prompt.directorPlanVersionId;
    p.db.run(
      `INSERT INTO render_jobs (id, shot_id, prompt_version_id, director_plan_version_id, provider, status, request_snapshot_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'SUBMITTING', ?, ?, ?)`,
      [id, input.shotId, input.promptVersionId, dpvId, input.provider, j(input.request), now, now],
    );
    updateShot(p, input.shotId, { h3Mode: input.request.mode });
    if (shot.status !== 'RENDERING') advanceShotStatus(p, input.shotId, 'RENDERING');
    this.pending.add(id);
    this.bus.emit({ type: 'render.job.created', jobId: id, shotId: input.shotId });
    this.pump();
    return this.getJob(id)!;
  }

  cancel(jobId: string): void {
    const job = this.getJob(jobId);
    if (!job) return;
    this.pending.delete(jobId);
    const handle = this.handles.get(jobId);
    if (handle) {
      const provider = this.registry.get(job.provider);
      if (provider) provider.cancel(handle).catch(() => undefined);
    }
    if (ACTIVE_STATUSES.includes(job.status)) {
      this.saveStatus(jobId, 'CANCELLED', { finishedAt: new Date().toISOString() });
      this.bus.emit({ type: 'render.job.updated', jobId, shotId: job.shotId, status: 'CANCELLED' });
    }
  }

  retry(jobId: string): void {
    const job = this.getJob(jobId);
    if (!job || job.status !== 'FAILED') return;
    this.saveStatus(jobId, 'SUBMITTING', { error: null, finishedAt: null, providerTaskId: null, providerResponseSnapshot: null });
    this.pending.add(jobId);
    this.bus.emit({ type: 'render.job.updated', jobId, shotId: job.shotId, status: 'SUBMITTING' });
    this.pump();
  }

  /** Boot recovery: requeue jobs that were mid-flight, keep polling known taskIds. */
  recover(): void {
    const p = this.getProject();
    if (!p) return;
    const rows = p.db.all<JobRow>("SELECT * FROM render_jobs WHERE status IN ('UPLOADING','SUBMITTING','QUEUED','RUNNING','DOWNLOADING')");
    for (const r of rows) {
      const job = jobFromRow(r);
      if (job.providerTaskId) {
        // We can resume polling immediately; no resubmit (avoid double cost).
        this.handles.set(job.id, { providerTaskId: job.providerTaskId });
        this.pending.add(job.id);
      } else {
        // Never resubmitted without user action — mark failed with a hint.
        this.saveStatus(job.id, 'FAILED', { error: 'interrupted before provider taskId was returned; resubmit to render' });
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
        const p = this.getProject();
        if (!p) break;
        const jobId = this.pending.values().next().value as string | undefined;
        if (!jobId) break;
        this.pending.delete(jobId);
        const job = this.getJob(jobId);
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
    const p = this.getProject();
    if (!p) return;
    const provider = this.registry.get(job.provider);
    if (!provider) {
      this.fail(job, 'provider not found: ' + job.provider);
      return;
    }
    try {
      // 1) Upload references if we have a fresh job (no handle yet).
      if (!this.handles.has(job.id) && job.requestSnapshot) {
        this.saveStatus(job.id, 'UPLOADING');
        this.bus.emit({ type: 'render.job.updated', jobId: job.id, shotId: job.shotId, status: 'UPLOADING' });
        const uploads: Record<string, string> = {};
        for (const ref of job.requestSnapshot.references) {
          const asset = getMedia(p, ref.assetId);
          const abs = p.resolveProjectPath(asset.fileName);
          const uploaded = await provider.uploadAsset(asset, abs);
          uploads[ref.assetId] = uploaded.providerRef;
        }
        this.saveStatus(job.id, 'SUBMITTING');
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
        this.handles.set(job.id, handle);
        this.saveStatus(job.id, 'QUEUED', { providerTaskId: handle.providerTaskId, providerResponseSnapshot: handle.raw });
        this.bus.emit({ type: 'render.job.queued', jobId: job.id, shotId: job.shotId });
        await this.pollUntilDone(job.id);
        return;
      }

      // 2) Job has a handle (recovered or already submitted) — poll.
      if (this.handles.has(job.id)) {
        await this.pollUntilDone(job.id);
      }
    } catch (e) {
      if (e instanceof ProviderError) {
        this.fail(job, `${e.stage}: ${e.message}`);
      } else {
        this.fail(job, e instanceof Error ? e.message : String(e));
      }
    }
  }

  private async pollUntilDone(jobId: string): Promise<void> {
    const job = this.getJob(jobId);
    if (!job || !job.providerTaskId) return;
    const p = this.getProject();
    if (!p) return;
    const provider = this.registry.get(job.provider);
    if (!provider) {
      this.fail(job, 'provider not found');
      return;
    }
    const handle = this.handles.get(jobId)!;
    let lastStatus: RenderJobStatus = job.status;
    for (let i = 0; i < 600; i++) {
      // CANCELLED while polling?
      const cur = this.getJob(jobId);
      if (!cur) return;
      if (cur.status === 'CANCELLED' || cur.status === 'FAILED') return;
      const st = await provider.status(handle);
      const mapped: RenderJobStatus = st.status === 'SUCCEEDED' ? 'SUCCEEDED' : st.status === 'FAILED' ? 'FAILED' : st.status === 'EXPIRED' ? 'EXPIRED' : 'RUNNING';
      if (mapped === 'SUCCEEDED') {
        this.saveStatus(jobId, 'DOWNLOADING', { startedAt: new Date().toISOString() });
        this.bus.emit({ type: 'render.job.updated', jobId, shotId: cur.shotId, status: 'DOWNLOADING' });
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
        this.saveStatus(jobId, mapped, { startedAt: cur.startedAt ?? new Date().toISOString() });
        this.bus.emit({ type: 'render.job.running', jobId, shotId: cur.shotId });
      }
      await sleep(this.pollMs);
    }
    this.fail(job, 'poll timeout (100 minutes)');
  }

  private async downloadAndCreateTake(job: RenderJob, url: string, cost?: RenderJob['cost']): Promise<void> {
    const p = this.getProject();
    if (!p) return;
    const dir = p.paths.shotTakes(job.shotId);
    const ext = url.includes('.mp4') || /^mock:/.test(url) ? 'mp4' : 'mp4';
    const filePath = join(dir, `take-${job.id}.${ext}`);
    await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }));
    if (/^mock:/.test(url)) {
      await import('node:fs/promises').then((fs) => fs.copyFile(url.slice('mock://'.length), filePath));
    } else {
      const res = await fetch(url, { signal: AbortSignal.timeout(600_000) });
      if (!res.ok) throw new ProviderError(`download failed HTTP ${res.status}`, 'download');
      const buf = Buffer.from(await res.arrayBuffer());
      await import('node:fs/promises').then((fs) => fs.writeFile(filePath, buf));
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
    this.saveStatus(job.id, 'LOCAL_READY', { finishedAt: new Date().toISOString(), cost, takeId: take.id });
    this.bus.emit({ type: 'render.job.succeeded', jobId: job.id, shotId: job.shotId, takeId: take.id });
    this.bus.emit({ type: 'take.created', takeId: take.id, shotId: job.shotId });
    const shot = getShot(p, job.shotId);
    if (shot.status === 'RENDERING') advanceShotStatus(p, job.shotId, 'HAS_TAKES');
  }

  private fail(job: RenderJob, error: string): void {
    this.saveStatus(job.id, 'FAILED', { error, finishedAt: new Date().toISOString() });
    this.handles.delete(job.id);
    this.bus.emit({ type: 'render.job.failed', jobId: job.id, shotId: job.shotId, error });
    const p = this.getProject();
    if (p) {
      const shot = getShot(p, job.shotId);
      if (shot.status === 'RENDERING') advanceShotStatus(p, job.shotId, 'PREFLIGHT_READY');
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
