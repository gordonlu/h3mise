import type { RenderBatchShotStage } from './render.js';

export type ProductionIssueSeverity = 'blocker' | 'warning' | 'info';
export type ProductionIssueCategory = 'story' | 'assets' | 'generation' | 'review' | 'continuity' | 'timeline';

export interface ProductionIssue {
  id: string;
  severity: ProductionIssueSeverity;
  category: ProductionIssueCategory;
  title: string;
  detail: string;
  to: string;
  shotId?: string;
}

export interface ProductionShotStatus {
  shotId: string;
  order: number;
  title: string;
  durationSeconds: number;
  stage: RenderBatchShotStage;
  reason: string;
  takeCount: number;
  selectedTakeId: string | null;
  failedJobCount: number;
  onTimeline: boolean;
  hasContinuity: boolean;
  to: string;
}

export interface ProductionOverview {
  projectId: string;
  providerId: string;
  generatedAt: string;
  summary: {
    plannedDurationSeconds: number;
    shotDurationSeconds: number;
    timelineDurationSeconds: number;
    shotCount: number;
    selectedCount: number;
    timelineClipCount: number;
    exportCount: number;
    activeRenderCount: number;
    failedJobCount: number;
    remainingShotCount: number;
  };
  nextActions: ProductionIssue[];
  issues: ProductionIssue[];
  shots: ProductionShotStatus[];
}
