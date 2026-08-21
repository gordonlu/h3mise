// Provider / AI-app profiles.

import type { H3Mode } from './director.js';

// Provider / AI profiles
// ---------------------------------------------------------------------------

export interface ProviderCapabilities {
  supportedModes: H3Mode[];
  minDuration?: number;
  maxDuration?: number;
  supportedAspectRatios?: string[];
  supportedResolutions?: string[];
  /** RunningHub reference limits: ≤9 images, ≤3 videos, ≤3 audios,
   * ≤12 total, each video/audio 2–15s and their combined length ≤15s,
   * and audio can never be the only reference (needs ≥1 image or video). */
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
    extra?: { nodeId: string; fieldName: string };
  };
  /** Verified via live invoke example — null until verified. */
  /** Per-key node bindings for providerParams (P0-4): unknown params are
   * rejected, never guessed into an arbitrary node. */
  providerParamBindings?: Record<string, { nodeId: string; fieldName: string }>;
  verification: {
    /** unconfigured → nodes_detected (layout probed, mapping NOT confirmed) →
     * verified (a real submission succeeded against this profile). */
    status: 'unconfigured' | 'nodes_detected' | 'verified' | 'failed';
    checkedAt: string | null;
    note: string;
  };
}

export interface ProviderStatus {
  id: string;
  name: string;
  kind: 'runninghub_ai_app';
  configured: boolean;
  verification: AiAppProfile['verification'];
  capabilities: ProviderCapabilities | null;
}

export interface AIConfigStatus {
  configured: boolean;
  baseUrl: string;
  model: string;
}
