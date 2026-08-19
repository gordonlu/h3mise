// Director-plan model (PRD §11) — modes, intent, blocking, plan versions.
// ---------------------------------------------------------------------------

import type { ShotFunction } from './shots.js';

export type H3Mode = 't2va' | 'i2va' | 'fl2va' | 'l2va' | 'ref2va';

export const H3_MODES: H3Mode[] = ['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va'];

export const H3_MODE_LABEL: Record<H3Mode, string> = {
  t2va: 'T2VA',
  i2va: 'I2VA',
  fl2va: 'FL2VA',
  l2va: 'L2VA',
  ref2va: 'Ref2VA',
};

export type RealityMode = 'strict_realism' | 'plausible_stylized' | 'deliberate_fantasy';

export interface PlanIntent {
  shotFunction: ShotFunction;
  visualThesis: string;
  dramaticGoal: string;
  peak: string;
  endState: string;
}

export interface PlanSubject {
  primarySubject: string;
  action: string;
  primaryMotionOwner: string;
}

export interface PlanBlocking {
  startPosition: string;
  endPosition: string;
  facing: string;
  movementAxis: string;
  travelPath: string;
  spatialRelationships: string;
}

export interface PlanCamera {
  shotSizeStart: string;
  shotSizePeak: string;
  shotSizeEnd: string;
  geometry: string;
  lensIntent: string;
  dominantBehavior: string;
  trigger: string;
  speedRelation: string;
  stopCondition: string;
}

export interface PlanMovementQuality {
  weight: string;
  time: string;
  space: string;
  flow: string;
}

export interface PlanPerformance {
  objective: string;
  obstacle: string;
  tactic: string;
  performanceTurn: string;
  movementQuality: PlanMovementQuality;
  anticipation: string;
  primaryAction: string;
  followThrough: string;
  recovery: string;
  gaze: string;
  endPose: string;
}

export interface PlanEnvironment {
  location: string;
  weather: string;
  medium: string;
  wind: string;
  lighting: string;
  foreground: string;
  midground: string;
  background: string;
}

export interface PlanContinuity {
  plannedStartState: string;
  plannedEndState: string;
}

export interface PlanGeneration {
  requestedMode: H3Mode | '';
  durationSeconds: number;
  aspectRatio: string;
  audioIntent: string;
}

export interface DirectorPlan {
  version: number;
  intent: PlanIntent;
  subject: PlanSubject;
  blocking: PlanBlocking;
  camera: PlanCamera;
  performance: PlanPerformance;
  environment: PlanEnvironment;
  reality: { mode: RealityMode; constraints: string[] };
  continuity: PlanContinuity;
  generation: PlanGeneration;
}

export function emptyDirectorPlan(): DirectorPlan {
  return {
    version: 0,
    intent: {
      shotFunction: 'other',
      visualThesis: '',
      dramaticGoal: '',
      peak: '',
      endState: '',
    },
    subject: { primarySubject: '', action: '', primaryMotionOwner: '' },
    blocking: {
      startPosition: '',
      endPosition: '',
      facing: '',
      movementAxis: '',
      travelPath: '',
      spatialRelationships: '',
    },
    camera: {
      shotSizeStart: '',
      shotSizePeak: '',
      shotSizeEnd: '',
      geometry: '',
      lensIntent: '',
      dominantBehavior: '',
      trigger: '',
      speedRelation: '',
      stopCondition: '',
    },
    performance: {
      objective: '',
      obstacle: '',
      tactic: '',
      performanceTurn: '',
      movementQuality: { weight: '', time: '', space: '', flow: '' },
      anticipation: '',
      primaryAction: '',
      followThrough: '',
      recovery: '',
      gaze: '',
      endPose: '',
    },
    environment: {
      location: '',
      weather: '',
      medium: '',
      wind: '',
      lighting: '',
      foreground: '',
      midground: '',
      background: '',
    },
    reality: { mode: 'strict_realism', constraints: [] },
    continuity: { plannedStartState: '', plannedEndState: '' },
    generation: { requestedMode: '', durationSeconds: 5, aspectRatio: '16:9', audioIntent: '' },
  };
}

export interface DirectorPlanVersion {
  id: string;
  shotId: string;
  version: number;
  plan: DirectorPlan;
  source: 'manual' | 'external_ai' | 'builtin_ai' | 'default';
  createdAt: string;
}
