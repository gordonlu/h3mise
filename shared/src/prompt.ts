// Prompt version model.

import type { H3Mode } from './director.js';

// Prompt
// ---------------------------------------------------------------------------

export type PromptSource =
  | 'deterministic_compiler'
  | 'ai_compiler'
  | 'external_ai'
  | 'import'
  | 'manual';

export type PromptStage = 'rewrite' | 't2va' | 'ref2va' | 'audio_reference' | 'final';

export interface PromptVersion {
  id: string;
  shotId: string;
  source: PromptSource;
  directorPlanVersionId: string | null;
  h3Mode: H3Mode;
  stage: PromptStage;
  referenceSignature?: string | null;
  /** Signature of the per-shot production config used to compile this Prompt. */
  productionSignature?: string | null;
  text: string;
  /** Optional iteration lineage. A revised prompt points at the Take whose
   * observed problem motivated it; rendering remains a separate, confirmed step. */
  sourceTakeId: string | null;
  revisionReason: string;
  preservedAspects: string[];
  createdAt: string;
}
