// Inference delegation contract. When an external agent drives H3Mise it
// already brings its own model, so the server never calls its own AI: it
// prepares the exact inference payload (prepare), the agent runs inference
// with its own model, and the server validates + applies the answer (apply).
// This keeps one inference authority per session.

export type AiRequestStatus = 'pending' | 'applied' | 'failed' | 'stale' | 'cancelled';

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
  /** Shot the request belongs to, when the action body carried one. */
  shotId: string | null;
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

/** Presence of an external agent that brings its own inference. In-memory on
 * the local server; expires when the agent has been idle for a while. */
export interface AiAgentStatus {
  attached: boolean;
  modelLabel: string | null;
  lastSeenAt: string | null;
  pending: number;
}

/** Response of POST /api/ai/actions/:action for the built-in driver. */
export interface AiActionJobResponse {
  deferred: false;
  jobId: string;
  status: string;
}

/** Response of POST /api/ai/actions/:action when inference was delegated to
 * an attached external agent instead of the project's own model. */
export interface AiActionDeferredResponse {
  deferred: true;
  requestId: string;
  status: 'pending';
}

export type AiActionResponse = AiActionJobResponse | AiActionDeferredResponse;
