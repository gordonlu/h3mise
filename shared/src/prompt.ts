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

export interface PromptVersion {
  id: string;
  shotId: string;
  source: PromptSource;
  directorPlanVersionId: string | null;
  h3Mode: H3Mode;
  text: string;
  /** Optional iteration lineage. A revised prompt points at the Take whose
   * observed problem motivated it; rendering remains a separate, confirmed step. */
  sourceTakeId: string | null;
  revisionReason: string;
  preservedAspects: string[];
  createdAt: string;
}
