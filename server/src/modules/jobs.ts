// Background jobs — long operations (ffmpeg export, AI analysis) run off the
// request thread. The endpoint returns {jobId, status} immediately; the UI
// follows status via SSE or GET /api/jobs/:id. No request ever blocks on a
// provider or subprocess.

import { randomBytes } from 'node:crypto';
import type { EventBus } from '../events.js';

export type BackgroundJobStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface BackgroundJob {
  id: string;
  kind: string;
  label: string;
  status: BackgroundJobStatus;
  progress: number | null; // 0..1
  message: string;
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export class JobRunner {
  private jobs = new Map<string, BackgroundJob>();
  private readonly maxJobs = 200;

  constructor(private readonly bus: EventBus) {}

  start<T>(kind: string, label: string, work: (update: (patch: Partial<BackgroundJob>) => void) => Promise<T>): BackgroundJob {
    this.prune();
    const id = `job-${randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();
    const job: BackgroundJob = {
      id,
      kind,
      label,
      status: 'running',
      progress: null,
      message: 'started',
      result: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(id, job);
    const update = (patch: Partial<BackgroundJob>) => {
      Object.assign(job, patch, { updatedAt: new Date().toISOString() });
      this.bus.emit({ type: 'job.updated', jobId: id, status: job.status, kind });
    };
    void work(update)
      .then((result) => {
        job.status = 'done';
        job.result = result;
        job.progress = 1;
        job.message = 'done';
        job.updatedAt = new Date().toISOString();
        this.bus.emit({ type: 'job.updated', jobId: id, status: 'done', kind });
      })
      .catch((e) => {
        job.status = 'failed';
        job.error = e instanceof Error ? e.message : String(e);
        job.message = 'failed';
        job.updatedAt = new Date().toISOString();
        this.bus.emit({ type: 'job.updated', jobId: id, status: 'failed', kind });
      });
    return job;
  }

  get(id: string): BackgroundJob | undefined {
    return this.jobs.get(id);
  }

  list(kind?: string): BackgroundJob[] {
    const all = [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return kind ? all.filter((j) => j.kind === kind) : all;
  }

  private prune(): void {
    if (this.jobs.size < this.maxJobs) return;
    const sorted = [...this.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const j of sorted.slice(0, this.jobs.size - this.maxJobs)) {
      if (j.status !== 'running') this.jobs.delete(j.id);
    }
  }
}
