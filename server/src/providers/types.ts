// VideoProvider abstraction — PRD §25. v0.1 ships one real backend
// (RunningHubAiAppProvider) plus a mock provider for offline development.
// RenderRequest carries business intent only; provider internals stay here.

import type { H3Mode, MediaAsset, ProviderCapabilities, RenderJobStatus, ReferenceRole } from '@h3mise/shared';

export interface UploadedAsset {
  /** Provider-side reference (fileName/url) to place into the app input. */
  providerRef: string;
  meta?: Record<string, unknown>;
}

export interface RenderRequestInput {
  mode: H3Mode;
  prompt: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution?: string;
  /** Business references: local asset + its binding roles + upload ref. */
  references: { asset: MediaAsset; roles: ReferenceRole[]; label: string; providerRef: string }[];
  /** Extra provider params from the AiAppProfile. */
  providerParams: Record<string, unknown>;
}

export interface RenderJobHandle {
  providerTaskId: string;
  raw?: Record<string, unknown>;
}

export interface RenderStatus {
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'EXPIRED';
  error?: string;
  /** Transient hiccup (network blip / unrecognized payload): the queue keeps
   * polling instead of failing a paid job. Cleared by the next good answer. */
  transient?: boolean;
  /** Video result URL once succeeded. */
  resultUrl?: string;
  cost?: { credits?: number; unit?: string; raw?: unknown };
}

export interface RenderResult {
  url: string;
  cost?: RenderStatus['cost'];
  meta?: Record<string, unknown>;
}

export interface VideoProvider {
  readonly id: string;
  readonly name: string;
  /** Whether credentials are present (does not imply working). */
  configured: boolean;
  capabilities(): Promise<ProviderCapabilities>;
  uploadAsset(asset: MediaAsset, localPath: string): Promise<UploadedAsset>;
  submit(request: RenderRequestInput): Promise<RenderJobHandle>;
  status(handle: RenderJobHandle): Promise<RenderStatus>;
  result(handle: RenderJobHandle): Promise<RenderResult>;
  cancel(handle: RenderJobHandle): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly stage: 'upload' | 'submit' | 'poll' | 'download',
    readonly detail?: unknown,
  ) {
    super(message);
  }
}
