// Render
// ---------------------------------------------------------------------------

import type { H3Mode } from './director.js';
import type { MediaKind } from './assets.js';

export type RenderJobStatus =
  | 'UPLOADING'
  | 'SUBMITTING'
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'DOWNLOADING'
  | 'LOCAL_READY'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';

export interface RenderRequest {
  provider: string;
  aiAppId: string;
  mode: H3Mode;
  promptVersionId: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution?: string;
  megapixels?: number;
  references: { bindingId: string; assetId: string; kind: MediaKind }[];
  providerParams: Record<string, unknown>;
}

export interface RenderJob {
  id: string;
  /** Owning project (P0-1): jobs are pinned to their project, never to the UI's current project. */
  projectId: string;
  shotId: string;
  promptVersionId: string;
  directorPlanVersionId: string | null;
  provider: string;
  providerTaskId: string | null;
  status: RenderJobStatus;
  submittedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  requestSnapshot: RenderRequest | null;
  /** Hash of the preflight-checked render intent (P0-2 audit trail). */
  renderIntentHash: string | null;
  providerResponseSnapshot: Record<string, unknown> | null;
  /** Provider-reported cost. credits = CNY money, coins = RH 币 (RunningHub
   * coin balance) — an account consumes one or the other per task. */
  cost: { credits?: number; unit?: string; coins?: number; raw?: unknown } | null;
  error: string | null;
  takeId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Take
// ---------------------------------------------------------------------------

export type TakeStatus = 'candidate' | 'selected' | 'rejected';
export type TakeSource = 'render' | 'import';

export interface TakeProvenance {
  originalFileName?: string;
  provider?: string;
  model?: string;
  prompt?: string;
}

export const FAILURE_TAGS = [
  'identity_drift',
  'bad_anatomy',
  'physics',
  'camera',
  'motion',
  'continuity',
  'composition',
  'lighting',
  'reference_mismatch',
  'text',
  'audio',
  'other',
] as const;

export type FailureTag = (typeof FAILURE_TAGS)[number];

export interface Take {
  id: string;
  shotId: string;
  renderJobId: string;
  promptVersionId: string;
  directorPlanVersionId: string | null;
  source: TakeSource;
  provenance: TakeProvenance;
  localVideoPath: string; // relative under project shots/<shot>/takes/
  posterPath: string | null;
  firstFramePath: string | null;
  lastFramePath: string | null;
  duration: number;
  status: TakeStatus;
  rating: number | null;
  failureTags: FailureTag[];
  notes: string;
  createdAt: string;
}
