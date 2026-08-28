// Provider / AI-app profiles.

import type { H3Mode } from './director.js';

export interface ProviderVerification {
  status: 'unconfigured' | 'nodes_detected' | 'verified' | 'failed';
  checkedAt: string | null;
  note: string;
}

// Provider / AI profiles
// ---------------------------------------------------------------------------

export interface ProviderCapabilities {
  supportedModes: H3Mode[];
  minDuration?: number;
  maxDuration?: number;
  supportedAspectRatios?: string[];
  supportedResolutions?: string[];
  /** RunningHub reference limits: ≤9 images, no video references, ≤3 audios,
   * ≤12 total; audio is 2–15s each / ≤15s combined and requires an image. */
  maxImageRefs?: number;
  maxVideoRefs?: number;
  maxAudioRefs?: number;
  maxTotalRefs?: number;
  audioSupported?: boolean;
}

export interface AiAppProfile {
  provider: string;
  appId: string;
  invokeUrl: string;
  protocolVersion: 'observed';
  capabilities: ProviderCapabilities;
  /** Discovered (apiCallDemo) or default node layout of the AI App. */
  nodes: Array<{
    nodeId: string;
    nodeName: string;
    fieldName: string;
    fieldType: string;
    fieldData: string | null;
    description: string;
  }>;
  /** Business input → app node slot mapping. Array slots (refImages etc.)
   * list one entry per physical slot; submit fills them by order.
   * Two mutually exclusive image modes: firstFrame+lastFrame (2 slots) or
   * refImages (reference-image mode, ≤9); never both.
   * ref_videos was dropped from the RunningHub API — no video slots. */
  inputs: {
    prompt: { nodeId: string; fieldName: string };
    mode?: { nodeId: string; fieldName: string };
    firstFrame?: { nodeId: string; fieldName: string };
    lastFrame?: { nodeId: string; fieldName: string };
    refImages: Array<{ nodeId: string; fieldName: string }>;
    refAudios: Array<{ nodeId: string; fieldName: string }>;
    duration?: { nodeId: string; fieldName: string };
    resolution?: { nodeId: string; fieldName: string };
    megapixels?: { nodeId: string; fieldName: string };
    steps?: { nodeId: string; fieldName: string };
    extra?: { nodeId: string; fieldName: string };
  };
  /** Verified via live invoke example — null until verified. */
  /** Per-key node bindings for providerParams (P0-4): unknown params are
   * rejected, never guessed into an arbitrary node. */
  providerParamBindings?: Record<string, { nodeId: string; fieldName: string }>;
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

export interface ProviderStatus {
  id: string;
  name: string;
  kind: 'runninghub_ai_app' | 'comfyui_local' | 'mock';
  configured: boolean;
  verification: ProviderVerification;
  capabilities: ProviderCapabilities | null;
}

export interface AIConfigStatus {
  configured: boolean;
  baseUrl: string;
  model: string;
}
