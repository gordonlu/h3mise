export const TAKE_QUALITY_CHECKS = [
  'character_presence',
  'character_count',
  'wardrobe_completeness',
  'unexpected_objects',
  'deity_icon',
  'camera_in_frame',
  'text_watermark',
  'locked_camera_drift',
  'unexpected_cut',
  'aspect_ratio',
  'duration',
  'audio',
  'anatomy_scale',
] as const;

export type TakeQualityCheckKey = (typeof TAKE_QUALITY_CHECKS)[number];
export type TakeQualityStatus = 'pass' | 'warn' | 'fail' | 'unknown';
export type TakeQualityEvidence = 'programmatic' | 'ai_inference' | 'manual' | 'unavailable';

export interface TakeQualityItem {
  key: TakeQualityCheckKey;
  status: TakeQualityStatus;
  evidence: TakeQualityEvidence;
  message: string;
  observed: string | null;
  overridden: boolean;
}

export interface TakeQualityReport {
  id: string;
  takeId: string;
  shotId: string;
  items: TakeQualityItem[];
  status: 'pass' | 'attention' | 'unverified';
  programmaticComplete: boolean;
  aiComplete: boolean;
  createdAt: string;
}
