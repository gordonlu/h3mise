// Shots
// ---------------------------------------------------------------------------

export type ShotFunction =
  | 'establishing'
  | 'wide'
  | 'medium'
  | 'closeup'
  | 'insert'
  | 'reaction'
  | 'action'
  | 'transition'
  | 'montage'
  | 'pov'
  | 'aerial'
  | 'dialogue'
  | 'other';

export type ShotStatus =
  | 'DRAFT'
  | 'PLANNED'
  | 'ASSETS_READY'
  | 'DIRECTED'
  | 'PREFLIGHT_READY'
  | 'RENDERING'
  | 'HAS_TAKES'
  | 'SELECTED'
  | 'CONTINUITY_COMMITTED'
  | 'LOCKED';

export type ShotRenderDependencyMode =
  | 'auto'
  | 'independent'
  | 'planned'
  | 'previous_take'
  | 'manual_frame';

export interface ShotRenderReadiness {
  configuredMode: ShotRenderDependencyMode;
  effectiveMode: Exclude<ShotRenderDependencyMode, 'auto'>;
  dependsOnShotId: string | null;
  ready: boolean;
  canResolveFrame: boolean;
  reason: string;
}

export const SHOT_STATUS_ORDER: Record<ShotStatus, number> = {
  DRAFT: 0,
  PLANNED: 1,
  ASSETS_READY: 2,
  DIRECTED: 3,
  PREFLIGHT_READY: 4,
  RENDERING: 5,
  HAS_TAKES: 6,
  SELECTED: 7,
  CONTINUITY_COMMITTED: 8,
  LOCKED: 9,
};

export const SHOT_STATUS_LABEL: Record<ShotStatus, string> = {
  DRAFT: '待导演',
  PLANNED: '已计划',
  ASSETS_READY: '资产就绪',
  DIRECTED: '已导演',
  PREFLIGHT_READY: '已预检',
  RENDERING: '生成中',
  HAS_TAKES: '待选片',
  SELECTED: '已选片',
  CONTINUITY_COMMITTED: '连续性已提交',
  LOCKED: '已锁定',
};

/** PRD §9 user-visible states (5) — the internal 10-state machine (§10) is
 * folded into these for display; internal states remain available as detail. */
export type ShotUserStatus = 'draft' | 'ready' | 'rendering' | 'review' | 'done';

export const SHOT_USER_STATUS: Record<ShotStatus, ShotUserStatus> = {
  DRAFT: 'draft',
  PLANNED: 'ready',
  ASSETS_READY: 'ready',
  DIRECTED: 'ready',
  PREFLIGHT_READY: 'ready',
  RENDERING: 'rendering',
  HAS_TAKES: 'review',
  SELECTED: 'done',
  CONTINUITY_COMMITTED: 'done',
  LOCKED: 'done',
};

export const SHOT_USER_STATUS_LABEL: Record<ShotUserStatus, string> = {
  draft: '待导演',
  ready: '准备生成',
  rendering: '生成中',
  review: '待选片',
  done: '已完成',
};

/** Editorial direction of screen space: which side the action travels toward.
 * left_to_right and right_to_left conflict; neutral is unset/no constraint. */
export type ScreenDirection = 'left_to_right' | 'right_to_left' | 'neutral';

export const SCREEN_DIRECTIONS: ScreenDirection[] = ['left_to_right', 'right_to_left', 'neutral'];

export const SCREEN_DIRECTION_LABEL: Record<ScreenDirection, string> = {
  left_to_right: '左→右',
  right_to_left: '右→左',
  neutral: '中性',
};

import type { H3Mode } from './director.js';

export interface Shot {
  id: string;
  sequenceId: string | null;
  order: number;
  title: string;
  storyBeatId: string | null;
  purpose: string;
  shotFunction: ShotFunction;
  durationSeconds: number;
  status: ShotStatus;
  aspectRatio: string;
  h3Mode: H3Mode | null;
  primaryCharacterId: string | null;
  sceneId: string | null;
  renderDependencyMode: ShotRenderDependencyMode;
  dependsOnShotId: string | null;
  /** Screen-direction constraint for the compiler. */
  screenDirection: ScreenDirection;
  /** "I intend this reversal" — dissolves the preflight reversal warning. */
  intentionalReversal: boolean;
  createdAt: string;
  updatedAt: string;
}
