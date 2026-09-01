import type { StoryBeat } from './project.js';

export type SkeletonSegmentCount = 3 | 6 | 9;

export interface SkeletonSegment {
  title: string;
  purpose: string;
  tension: 'up' | 'hold' | 'release';
  question: string;
  category: StoryBeat['category'];
}

export interface StorySkeleton {
  id: string;
  name: string;
  description: string;
  group: 'comedy' | 'high_tension' | 'suspense' | 'emotion';
  tags: string[];
  variants: Record<SkeletonSegmentCount, SkeletonSegment[]>;
}

export interface SkeletonRecommendation {
  skeleton: StorySkeleton;
  score: number;
  reason: string;
}

export interface SkeletonRecommendationResult {
  mode: 'ai' | 'local' | 'local_fallback';
  recommendations: SkeletonRecommendation[];
}
