// Inference delegation contract. When an external agent drives H3Mise it
// already brings its own model, so the server never calls its own AI: it
// prepares the exact inference payload (prepare), the agent runs inference
// with its own model, and the server validates + applies the answer (apply).
// This keeps one inference authority per session.

export type AiRequestStatus = 'pending' | 'applied' | 'failed' | 'stale';

export type AiRequestSource = 'agent' | 'builtin';

export type AiInferenceContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: string } }>;

export interface AiInferenceMessage {
  role: 'user' | 'assistant' | 'system';
  content: AiInferenceContent;
}

export interface AiInferenceStep {
  system: string;
  messages: AiInferenceMessage[];
  /** Ask the agent for a single JSON value (array or object). */
  json: boolean;
  temperature: number;
  /** True when the step carries reference images the agent may read. */
  hasImages: boolean;
}

/** Response of POST /api/ai/actions/:action/prepare. */
export interface AiPreparedRequest {
  requestId: string;
  action: string;
  source: AiRequestSource;
  inference: AiInferenceStep;
  contextHash: string;
}

/** Response of POST /api/ai/requests/:id/apply when the action is complete. */
export interface AiAppliedResult {
  status: 'applied';
  requestId: string;
  result: unknown;
  vision: { mode: 'multimodal' | 'text_fallback' | 'text_only'; imageCount: number } | null;
}

/** Response of POST /api/ai/requests/:id/apply when another round is needed
 * (e.g. the plan failed validation and a repair inference is requested). */
export interface AiContinueResult {
  status: 'continue';
  requestId: string;
  inference: AiInferenceStep;
}

export interface AiRequestSummary {
  id: string;
  action: string;
  status: AiRequestStatus;
  source: AiRequestSource;
  modelLabel: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface AiRequestDetail extends AiRequestSummary {
  result: unknown;
  error: string | null;
}

export interface AiDelegationStatus {
  supported: true;
  prepare: string;
  apply: string;
  pending: number;
}
