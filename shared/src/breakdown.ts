import type { VideoAnalysisFrame } from './assets.js';
import type { TemporalBeat } from './director.js';
import type { ScreenDirection } from './shots.js';

export interface ReferenceSegment { id: string; start: number; end: number; label: string }
export interface ReferenceDirection {
  action: string;
  camera: string;
  shotSize: string;
  blocking: string;
  composition: string;
  screenDirection: ScreenDirection;
  beats: TemporalBeat[];
  assessment: string[];
  cameraSuggestion: 'static' | 'push_in' | 'pull_out' | 'pan_left' | 'pan_right';
}
export interface ReferenceBreakdown {
  assetId: string;
  duration: number;
  fps: number | null;
  width: number | null;
  height: number | null;
  cuts: number[];
  frames: VideoAnalysisFrame[];
  segments: ReferenceSegment[];
  revision: number;
}
export interface ReferenceAnalysis {
  start: number;
  end: number;
  direction: ReferenceDirection;
  visionMode: string;
}
