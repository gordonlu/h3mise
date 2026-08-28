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
  createdAt: string;
}
