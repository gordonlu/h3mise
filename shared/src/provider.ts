// Provider / AI-app profiles.

import type { H3Mode } from './director.js';

export interface ProviderVerification {
  status: 'unconfigured' | 'nodes_detected' | 'verified' | 'failed';
  checkedAt: string | null;
  note: string;
}

export type RunningHubRegion = 'cn' | 'global';

// Provider / AI profiles
// ---------------------------------------------------------------------------

export interface ProviderCapabilities {
  supportedModes: H3Mode[];
  minDuration?: number;
  maxDuration?: number;
  /** Optional source-video limits for v2v/faceswap workflows. */
  maxVideoSeconds?: number;
  maxVideoBytes?: number;
  supportedAspectRatios?: string[];
  supportedResolutions?: string[];
  /** RunningHub reference limits: ≤9 images, ≤3 audios, ≤12 total.
   * A video-reference or faceswap workflow must declare its own video slots. */
  maxImageRefs?: number;
  maxVideoRefs?: number;
  maxAudioRefs?: number;
  maxTotalRefs?: number;
  audioSupported?: boolean;
  /** v2v/faceswap workflows normally keep the source video's audio track. */
  preservesSourceAudio?: boolean;
}

export interface AiAppNode {
  nodeId: string;
  nodeName: string;
  fieldName: string;
  fieldType: string;
  fieldData: string | null;
  description: string;
}

export interface AiAppInputs {
  prompt: { nodeId: string; fieldName: string };
  mode?: { nodeId: string; fieldName: string };
  firstFrame?: { nodeId: string; fieldName: string };
  lastFrame?: { nodeId: string; fieldName: string };
  /** Reference-image slots; a faceswap workflow uses exactly one. */
  refImages: Array<{ nodeId: string; fieldName: string }>;
  refAudios: Array<{ nodeId: string; fieldName: string }>;
  /** Dedicated video slots used by vref2va and faceswap workflows. */
  refVideos?: Array<{ nodeId: string; fieldName: string }>;
  duration?: { nodeId: string; fieldName: string };
  resolution?: { nodeId: string; fieldName: string };
  megapixels?: { nodeId: string; fieldName: string };
  steps?: { nodeId: string; fieldName: string };
  extra?: { nodeId: string; fieldName: string };
}

export type WorkflowKind = 'video' | 'frame' | 'video_reference' | 'faceswap' | 'custom';

export interface WorkflowModeReadiness {
  mode: H3Mode;
  supported: boolean;
  ready: boolean;
  missing: string[];
}

/** One executable RunningHub AI App workflow. It owns its node layout,
 * business-input mapping, capability declaration and verification receipt.
 * A bare `{ id, name, appId }` entry is only a saved reference and is not
 * executable until it is mapped and verified. */
export interface WorkflowProfile {
  id: string;
  name: string;
  appId: string;
  description?: string;
  /** Optional UI hint; mode support is always derived from `capabilities`. */
  kind?: WorkflowKind;
  nodes?: AiAppNode[];
  inputs?: AiAppInputs;
  capabilities?: ProviderCapabilities;
  verification?: ProviderVerification;
  providerParamBindings?: Record<string, { nodeId: string; fieldName: string }>;
  /** Server-computed convenience fields; ignored by PUT. */
  runnable?: boolean;
  modes?: H3Mode[];
  readiness?: WorkflowModeReadiness[];
}

export interface AiAppProfile {
  provider: string;
  /** Account/API region. Credentials and App IDs must belong to this site. */
  region: RunningHubRegion;
  /** Maximum active remote tasks for this account/workflow. Defaults to 1
   * because a wrong value can create several paid tasks at once. */
  concurrency?: number;
  /** Active workflow's App ID. Kept as a compatibility mirror of
   * `apps[activeWorkflowId]`; submit resolves the actual App per mode. */
  appId: string;
  invokeUrl: string;
  protocolVersion: 'observed';
  capabilities: ProviderCapabilities;
  /** Discovered (apiCallDemo) or default node layout of the active App. */
  nodes: AiAppNode[];
  /** Business input → app node slot mapping of the active workflow. */
  inputs: AiAppInputs;
  /** Per-key node bindings for providerParams (P0-4): unknown params are
   * rejected, never guessed into an arbitrary node. */
  providerParamBindings?: Record<string, { nodeId: string; fieldName: string }>;
  /** Secondary AI App for camera motion reference video generation. When set,
   * the Camera Planner can submit the source image to this app instead of
   * using local FFmpeg zoompan. The app must accept an image input node. */
  refVideoAppId?: string;
  /** Every saved AI App workflow. The active entry is mirrored into the
   * top-level appId/inputs/capabilities/verification fields for backward
   * compatibility, but each entry keeps its own independent evidence. */
  apps: WorkflowProfile[];
  /** Explicit active workflow. Never inferred from array position alone. */
  activeWorkflowId?: string;
  verification: ProviderVerification;
}

export interface ComfyUiInputBinding {
  nodeId: string;
  inputName: string;
  /** Translate H3Mise canonical values (for example "16:9") to the exact
   * widget value expected by a workflow. */
  valueMap?: Record<string, string | number | boolean>;
}

export interface ComfyUiApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string; [key: string]: unknown };
}

export interface ComfyUiWorkflowProfile {
  provider: 'comfyui';
  /** Maximum active prompts for this local workflow/GPU. */
  concurrency?: number;
  baseUrl: string;
  /** Local ComfyUI uses no prefix. Keep configurable for compatible proxies. */
  apiPrefix: string;
  clientId: string;
  /** Non-loopback URLs are rejected unless the user explicitly opts in. */
  allowRemote: boolean;
  workflow: Record<string, ComfyUiApiNode>;
  inputs: {
    prompt?: ComfyUiInputBinding;
    mode?: ComfyUiInputBinding;
    firstFrame?: ComfyUiInputBinding;
    lastFrame?: ComfyUiInputBinding;
    refImages: ComfyUiInputBinding[];
    duration?: ComfyUiInputBinding;
    aspectRatio?: ComfyUiInputBinding;
    megapixels?: ComfyUiInputBinding;
  };
  outputNodeId?: string;
  providerParamBindings?: Record<string, ComfyUiInputBinding>;
  capabilities: ProviderCapabilities;
  verification: ProviderVerification;
}

export interface ProviderWorkflowSummary {
  id: string;
  name: string;
  appId: string;
  description?: string;
  active: boolean;
  runnable: boolean;
  verification: ProviderVerification;
  modes: H3Mode[];
  readiness: WorkflowModeReadiness[];
}

export interface ProviderStatus {
  id: string;
  name: string;
  kind: 'runninghub_ai_app' | 'comfyui_local' | 'mock';
  configured: boolean;
  verification: ProviderVerification;
  capabilities: ProviderCapabilities | null;
  /** RunningHub-only: the workflow selected for non-frame modes. */
  activeWorkflowId?: string | null;
  activeModes?: H3Mode[];
  workflows?: ProviderWorkflowSummary[];
}

export interface AIConfigStatus {
  configured: boolean;
  baseUrl: string;
  model: string;
}
