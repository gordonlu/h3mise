import type { H3Mode } from './director.js';
import type { VideoProviderId } from './project.js';

export type AutoProduceStatus = 'preparing' | 'rendering' | 'assembling' | 'checking' | 'exporting' | 'succeeded' | 'failed' | 'cancelled';
export type AutoProduceShotState = 'pending' | 'rendering' | 'done' | 'failed' | 'skipped';

export interface AutoProduceSettings {
  providerId: VideoProviderId;
  aspectRatio: string;
  megapixels: number;
  skipCompleted: boolean;
  /** Required for every non-mock start; never persisted as a reusable permission. */
  confirmRealProvider?: boolean;
}

export interface AutoProduceShot {
  shotId: string;
  storyBeatId: string | null;
  order: number;
  title: string;
  durationSeconds: number;
  state: AutoProduceShotState;
  renderJobId: string | null;
  takeId: string | null;
  error: string | null;
  attempts: number;
}

export interface AutoProduceRun {
  id: string;
  status: AutoProduceStatus;
  settings: AutoProduceSettings;
  shots: AutoProduceShot[];
  totalShots: number;
  doneShots: number;
  failedShots: number;
  currentStep: string;
  exportRelPath: string | null;
  exportUrl: string | null;
  exportDurationSeconds: number | null;
  error: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface AutoProducePlanShot {
  shotId: string;
  storyBeatId: string | null;
  order: number;
  title: string;
  durationSeconds: number;
  mode: H3Mode;
  hasSelectedTake: boolean;
  hasCandidateTake: boolean;
  hasActiveJob: boolean;
  willRender: boolean;
  refReady: boolean;
}

export interface AutoProduceProviderOption {
  id: VideoProviderId;
  name: string;
  kind: 'mock' | 'runninghub_ai_app' | 'comfyui_local';
  configured: boolean;
  usable: boolean;
  requiresConfirmation: boolean;
  note: string;
}

export interface AutoProducePlan {
  settings: AutoProduceSettings;
  providers: AutoProduceProviderOption[];
  shots: AutoProducePlanShot[];
  renderCount: number;
  skipCount: number;
  estimatedDurationSeconds: number;
  storyPreparation: { willCreateBeats: number; willCreateShots: number; uncoveredBeatIds: string[]; note: string | null };
  blockers: string[];
}

export const AUTO_PRODUCE_TERMINAL: AutoProduceStatus[] = ['succeeded', 'failed', 'cancelled'];
