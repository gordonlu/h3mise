// SSE event payloads — server pushes, web subscribes.

import type { RenderJobStatus } from './render.js';
import type { ShotStatus } from './shots.js';

// Events (SSE payloads)
// ---------------------------------------------------------------------------

export type AppEvent =
  | { type: 'render.job.created'; projectId: string; jobId: string; shotId: string }
  | { type: 'render.job.queued'; projectId: string; jobId: string; shotId: string }
  | { type: 'render.job.running'; projectId: string; jobId: string; shotId: string }
  | { type: 'render.job.succeeded'; projectId: string; jobId: string; shotId: string; takeId: string }
  | { type: 'render.job.failed'; projectId: string; jobId: string; shotId: string; error: string }
  | { type: 'render.job.updated'; projectId: string; jobId: string; shotId: string; status: RenderJobStatus }
  | { type: 'take.created'; takeId: string; shotId: string }
  | { type: 'take.selected'; takeId: string; shotId: string }
  | { type: 'continuity.committed'; shotId: string; scope: 'visual' | 'narrative' }
  | { type: 'shot.updated'; shotId: string; status: ShotStatus }
  | { type: 'project.updated' }
  | { type: 'auto.updated'; runId: string; status: import('./auto-produce.js').AutoProduceStatus }
  | { type: 'job.updated'; jobId: string; status: 'running' | 'done' | 'failed' | 'cancelled'; kind: string };
