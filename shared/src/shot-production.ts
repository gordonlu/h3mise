import type { H3Mode } from './director.js';

export type ShotAudioMode = 'none' | 'native_dialogue' | 'tts_dry' | 'reference_audio';
export type SegmentKind = 'single' | 'continuous' | 'time_jump' | 'surveillance_skip';

export interface DialogueCue {
  id: string;
  speaker: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface LockedCameraSetup {
  heightMeters: number | null;
  focalLengthMm: number | null;
  tiltDegrees: number | null;
  locked: boolean;
}

export interface CctvOverlayConfig {
  enabled: boolean;
  cameraLabel: string;
  location: string;
  startTime: string;
  showRec: boolean;
  lowResolution: boolean;
  dotMatrix: boolean;
  blurUpscale: boolean;
}

export interface ShotContinuitySegment {
  groupId: string | null;
  kind: SegmentKind;
  index: number;
  count: number;
  timeJumpSeconds: number;
  frameSkip: number;
}

export interface ShotProductionConfig {
  version: 1;
  /** Optional RunningHub workflow ID (or registered App ID) pinned to this Shot so
   * dual-workflow episodes can mix workflows concurrently without switching global activeWorkflowId. */
  workflowId?: string | null;
  camera: LockedCameraSetup;
  audio: {
    mode: ShotAudioMode;
    dialogue: DialogueCue[];
  };
  cctv: CctvOverlayConfig;
  segment: ShotContinuitySegment;
}

/** Interpret a CCTV wall-clock string as a fictional local clock, not the
 * browser/server timezone. Offsets preserve the entered wall-clock time. */
export function cctvWallClock(startTime: string, offsetSeconds: number): Date {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(startTime);
  const base = parsed
    ? Date.UTC(Number(parsed[1]), Number(parsed[2]) - 1, Number(parsed[3]), Number(parsed[4]), Number(parsed[5]), Number(parsed[6] ?? 0))
    : Date.UTC(2026, 0, 1);
  return new Date(base + Math.max(0, offsetSeconds) * 1000);
}

export const DEFAULT_SHOT_PRODUCTION: ShotProductionConfig = {
  version: 1,
  camera: { heightMeters: null, focalLengthMm: null, tiltDegrees: null, locked: false },
  audio: { mode: 'none', dialogue: [] },
  cctv: {
    enabled: false,
    cameraLabel: 'CAM 04',
    location: '',
    startTime: '2026-01-01T00:00:00',
    showRec: true,
    lowResolution: false,
    dotMatrix: false,
    blurUpscale: false,
  },
  segment: { groupId: null, kind: 'single', index: 1, count: 1, timeJumpSeconds: 0, frameSkip: 1 },
};

export function normalizeShotProduction(value: unknown): ShotProductionConfig {
  const input = value && typeof value === 'object' ? value as Partial<ShotProductionConfig> : {};
  const camera = input.camera && typeof input.camera === 'object' ? input.camera : DEFAULT_SHOT_PRODUCTION.camera;
  const audio = input.audio && typeof input.audio === 'object' ? input.audio : DEFAULT_SHOT_PRODUCTION.audio;
  const cctv = input.cctv && typeof input.cctv === 'object' ? input.cctv : DEFAULT_SHOT_PRODUCTION.cctv;
  const segment = input.segment && typeof input.segment === 'object' ? input.segment : DEFAULT_SHOT_PRODUCTION.segment;
  const finiteOrNull = (candidate: unknown) => typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
  const audioModes: ShotAudioMode[] = ['none', 'native_dialogue', 'tts_dry', 'reference_audio'];
  const segmentKinds: SegmentKind[] = ['single', 'continuous', 'time_jump', 'surveillance_skip'];
  const workflowId = typeof input.workflowId === 'string' && input.workflowId.trim() ? input.workflowId.trim() : null;
  return {
    version: 1,
    ...(workflowId ? { workflowId } : {}),
    camera: {
      heightMeters: finiteOrNull(camera.heightMeters),
      focalLengthMm: finiteOrNull(camera.focalLengthMm),
      tiltDegrees: finiteOrNull(camera.tiltDegrees),
      locked: camera.locked === true,
    },
    audio: {
      mode: audioModes.includes(audio.mode as ShotAudioMode) ? audio.mode as ShotAudioMode : 'none',
      dialogue: Array.isArray(audio.dialogue) ? audio.dialogue.flatMap((cue, index) => {
        if (!cue || typeof cue !== 'object') return [];
        const startSeconds = Number(cue.startSeconds);
        const endSeconds = Number(cue.endSeconds);
        if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds) return [];
        return [{
          id: typeof cue.id === 'string' && cue.id ? cue.id : `cue-${index + 1}`,
          speaker: typeof cue.speaker === 'string' ? cue.speaker.trim() : '',
          text: typeof cue.text === 'string' ? cue.text.trim() : '',
          startSeconds,
          endSeconds,
        }];
      }) : [],
    },
    cctv: {
      enabled: cctv.enabled === true,
      cameraLabel: typeof cctv.cameraLabel === 'string' ? cctv.cameraLabel : 'CAM 04',
      location: typeof cctv.location === 'string' ? cctv.location : '',
      startTime: typeof cctv.startTime === 'string' ? cctv.startTime : DEFAULT_SHOT_PRODUCTION.cctv.startTime,
      showRec: cctv.showRec !== false,
      lowResolution: cctv.lowResolution === true,
      dotMatrix: cctv.dotMatrix === true,
      blurUpscale: cctv.blurUpscale === true,
    },
    segment: {
      groupId: typeof segment.groupId === 'string' && segment.groupId ? segment.groupId : null,
      kind: segmentKinds.includes(segment.kind as SegmentKind) ? segment.kind as SegmentKind : 'single',
      index: Math.max(1, Math.floor(Number(segment.index) || 1)),
      count: Math.max(1, Math.floor(Number(segment.count) || 1)),
      timeJumpSeconds: Math.max(0, Number(segment.timeJumpSeconds) || 0),
      frameSkip: Math.max(1, Math.floor(Number(segment.frameSkip) || 1)),
    },
  };
}

export interface ProjectAudioSettings {
  bgmAssetId: string | null;
  bgmGainDb: number;
  duckingEnabled: boolean;
  duckingGainDb: number;
}

export const DEFAULT_PROJECT_AUDIO: ProjectAudioSettings = {
  bgmAssetId: null,
  bgmGainDb: -18,
  duckingEnabled: true,
  duckingGainDb: -9,
};

export interface SubmissionReferencePreview {
  tag: string;
  bindingId: string;
  assetId: string;
  order: number;
  kind: 'image' | 'video' | 'audio';
  label: string;
  assetLabel: string;
  roles: string[];
  referenceUse: string;
  framePolicy: string;
  width: number | null;
  height: number | null;
  providerRef: string;
}

export interface SubmissionPayloadPreview {
  shotId: string;
  promptVersionId: string;
  promptStage: string;
  promptText: string;
  providerId: string;
  workflowId?: string | null;
  appId: string;
  mode: H3Mode;
  durationSeconds: number;
  aspectRatio: string;
  megapixels: number | null;
  references: SubmissionReferencePreview[];
  parameters: Record<string, unknown>;
  providerPayload: Record<string, unknown>;
  verification: {
    status: string;
    exactCombination: 'tested' | 'declared' | 'unknown';
    note: string;
  };
  cost: {
    estimatedCny: number | null;
    evidence: 'mock' | 'user_estimate' | 'provider_receipt' | 'unknown';
    failureCharge: 'charged' | 'not_charged' | 'unknown';
    note: string;
  };
  generatedAt: string;
}

export interface RenderRecoveryPlan {
  code: 'RUNNINGHUB_805';
  summary: string;
  automaticRetry: false;
  takeCreated: false;
  suggestions: Array<{
    key: 'lower_mp' | 'shorter_duration' | 'same_camera_segments';
    title: string;
    durationSeconds?: number;
    megapixels?: number;
    segments?: Array<{ index: number; durationSeconds: number; cameraGroupId: string | null }>;
  }>;
}

export function runningHub805RecoveryPlan(
  durationSeconds: number,
  megapixels: number | null,
  cameraGroupId: string | null,
): RenderRecoveryPlan {
  const safeDuration = Math.max(1, Math.min(15, durationSeconds));
  const segmentCount = safeDuration > 10 ? 3 : 2;
  const base = Math.floor((safeDuration / segmentCount) * 100) / 100;
  const segments = Array.from({ length: segmentCount }, (_, index) => ({
    index: index + 1,
    durationSeconds: index === segmentCount - 1 ? Math.round((safeDuration - base * (segmentCount - 1)) * 100) / 100 : base,
    cameraGroupId,
  }));
  return {
    code: 'RUNNINGHUB_805',
    summary: 'RunningHub 805 是任务级通用失败，没有节点级原因。先降低负载并核对输入；系统不会自动重试或再次扣费。',
    automaticRetry: false,
    takeCreated: false,
    suggestions: [
      { key: 'lower_mp', title: '先降到 0.6 MP，保留原 Prompt 与参考图顺序', megapixels: 0.6 },
      { key: 'shorter_duration', title: '把单段缩短到 6 秒后再由用户明确确认', durationSeconds: 6 },
      { key: 'same_camera_segments', title: `按同一机位拆成 ${segmentCount} 段；这里仅提供方案，不自动创建任务`, segments },
    ],
  };
}
