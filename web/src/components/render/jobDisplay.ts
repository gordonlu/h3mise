// Shared render-job display helpers (used by the queue drawer and its job list).

import type { RenderJob } from '@h3mise/shared';
import { t } from '../../stores/locale';

const STATUS_KEY: Record<string, string> = {
  LOCAL_QUEUED: 'localQueued', UPLOADING: 'uploading', SUBMITTING: 'submitting', QUEUED: 'queued', RUNNING: 'running',
  SUCCEEDED: 'succeeded', DOWNLOADING: 'downloading', LOCAL_READY: 'localReady',
  FAILED: 'failed', CANCELLED: 'cancelled', EXPIRED: 'expired',
};

export const STATUS_BADGE: Record<string, string> = {
  LOCAL_QUEUED: 'muted', UPLOADING: 'warn', SUBMITTING: 'warn', QUEUED: 'warn', RUNNING: 'warn', SUCCEEDED: 'ok', DOWNLOADING: 'info', LOCAL_READY: 'ok',
  FAILED: 'bad', CANCELLED: 'muted', EXPIRED: 'muted',
};

export const ACTIVE = ['LOCAL_QUEUED', 'UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING'];
export const CANCELLABLE = ACTIVE;

export const STAGES = ['LOCAL_QUEUED', 'UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING', 'LOCAL_READY'] as const;

export function statusLabel(status: string): string {
  return t(`queue.status.${STATUS_KEY[status] ?? 'unknown'}`, { status });
}

export function formatSeconds(sec: number): string {
  const m = Math.floor(sec / 60);
  return m > 0 ? t('queue.durationMinutes', { m, s: String(sec % 60).padStart(2, '0') }) : t('queue.durationSeconds', { s: sec });
}

export function isActive(job: RenderJob): boolean {
  return ACTIVE.includes(job.status);
}

export function elapsedText(job: RenderJob, now: number): string {
  const start = job.startedAt ?? job.submittedAt ?? job.createdAt;
  const end = isActive(job) ? now : new Date(job.finishedAt ?? job.updatedAt).getTime();
  const startMs = new Date(start).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(end)) return '—';
  return formatSeconds(Math.max(0, Math.floor((end - startMs) / 1000)));
}

export function costText(job: RenderJob): string {
  if (!job.cost) return '';
  const c = job.cost as { credits?: number; coins?: number };
  const parts: string[] = [];
  if (c.credits) parts.push(`≈¥${Number(c.credits).toFixed(2)} CNY`);
  if (c.coins) parts.push(t('queue.coins', { n: c.coins }));
  return parts.join(' + ');
}

export function stageState(job: RenderJob, stage: (typeof STAGES)[number]): 'done' | 'current' | 'todo' {
  const current = STAGES.indexOf(job.status as (typeof STAGES)[number]);
  if (current < 0) return job.status === 'SUCCEEDED' ? 'done' : 'todo';
  const target = STAGES.indexOf(stage);
  return target < current ? 'done' : target === current ? 'current' : 'todo';
}
