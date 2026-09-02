import type { MediaAsset } from './assets.js';
import type { ProviderVerification, RunningHubRegion } from './provider.js';

export type StoryboardPanelCount = 3 | 6 | 9;
export type StoryboardStatus = 'draft' | 'generating' | 'ready' | 'approved' | 'failed';
export type StoryboardJobStatus = 'SUBMITTING' | 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED';

export interface StoryboardPanel {
  id: string;
  storyboardId: string;
  order: number;
  description: string;
  assetId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoryboardJob {
  id: string;
  storyboardId: string;
  panelId: string | null;
  kind: 'sheet' | 'panel';
  providerTaskId: string | null;
  status: StoryboardJobStatus;
  cost: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Storyboard {
  id: string;
  seriesId: string;
  pageNumber: number;
  totalPages: number;
  sourceStartIndex: number;
  sourceEndIndex: number;
  sourceSegmentCount: number;
  panelCount: StoryboardPanelCount;
  status: StoryboardStatus;
  sourceDurationSeconds: number;
  sheetAssetId: string | null;
  prompt: string;
  panels: StoryboardPanel[];
  activeJob: StoryboardJob | null;
  sheetAsset?: MediaAsset | null;
  createdAt: string;
  updatedAt: string;
  sync?: {
    shotsCreated: number;
    shotsUpdated: number;
    bindingsCreated: number;
  };
}

export interface StoryboardProviderProfile {
  provider: 'runninghub_storyboard';
  region: RunningHubRegion;
  enabled: boolean;
  appId: string;
  invokeUrl: string;
  estimatedCostCny: number | null;
  inputs: {
    prompt: { nodeId: string; fieldName: string };
    size: { nodeId: string; fieldName: string };
    layoutImage: { nodeId: string; fieldName: string };
  };
  sizeValues: Record<StoryboardPanelCount, string>;
  nodes: Array<{
    nodeId: string;
    nodeName: string;
    fieldName: string;
    fieldType: string;
    fieldData: string | null;
    description: string;
  }>;
  verification: ProviderVerification;
}

/** Grid size follows narrative units, not video duration. Each H3 Shot remains
 * an independent 2–15 second generation; more than nine units use pages. */
export function recommendedStoryboardPanelCount(segmentCount: number): StoryboardPanelCount {
  if (segmentCount <= 3) return 3;
  if (segmentCount <= 6) return 6;
  return 9;
}
