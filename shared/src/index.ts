// H3Mise shared domain model.
// Single source of truth for every business entity. Pure types — no runtime deps.

export type ProjectFormat = 'single_shot' | 'sequence' | 'story';

export interface ProjectConfig {
  title: string;
  format: ProjectFormat;
  default_aspect_ratio: string;
  visual_style?: string;
  default_provider: string;
  default_video_model: string;
  default_duration_seconds: number;
}

/** Registry row for a project on disk (global registry DB). */
export interface ProjectMeta {
  id: string;
  title: string;
  format: ProjectFormat;
  dirPath: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  shotCount?: number;
  selectedTakeCount?: number;
}

// ---------------------------------------------------------------------------
// Story
// ---------------------------------------------------------------------------

export type BeatCategory =
  | 'setup'
  | 'inciting_incident'
  | 'rising_action'
  | 'climax'
  | 'falling_action'
  | 'resolution'
  | 'transition'
  | 'other';

export interface StoryBeat {
  id: string;
  sequenceId: string | null;
  order: number;
  title: string;
  category: BeatCategory;
  summary: string;
  location?: string;
  timeOfDay?: string;
  weather?: string;
  characters: string[]; // entity ids
  stateChange?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Sequence {
  id: string;
  title: string;
  order: number;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoryDoc {
  id: string;
  title: string;
  logline: string;
  synopsis: string;
  body: string; // free-form script / source text
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export type EntityKind = 'character' | 'scene' | 'prop' | 'vehicle' | 'creature';

export interface Entity {
  id: string;
  kind: EntityKind;
  name: string;
  description: string;
  notes?: string;
  /** Open-ended trait map (costume defaults, physical traits, …). */
  traits: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/** CharacterState = "what this person looks like in the current story state". */
export interface CharacterState {
  id: string;
  characterId: string;
  name: string;
  costume: string;
  hair: string;
  injury: string;
  heldItems: string[];
  extra: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export type MediaKind = 'image' | 'video' | 'audio';

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  fileName: string; // relative path under project assets/…
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  /** Poster frame (relative path) — auto-generated for video imports. */
  posterPath?: string | null;
  source: 'import' | 'frame_extract' | 'render_download' | 'other';
  label: string;
  tags: string[];
  createdAt: string;
}

export type ReferenceRole =
  | 'identity'
  | 'costume'
  | 'environment'
  | 'motion'
  | 'body_motion'
  | 'timing'
  | 'camera_motion'
  | 'lighting'
  | 'style'
  | 'audio'
  | 'first_frame'
  | 'last_frame';

export interface ReferenceBinding {
  id: string;
  assetId: string;
  type: MediaKind;
  roles: ReferenceRole[];
  /** Attributes of the reference the model must preserve. */
  preserve: string[];
  /** Attributes the model must ignore. */
  ignore: string[];
  label: string;
  /** Optional target shot; null = global/pool binding. */
  shotId: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
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
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// DirectorPlan
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export type PromptSource =
  | 'deterministic_compiler'
  | 'ai_compiler'
  | 'external_ai'
  | 'manual';

export interface PromptVersion {
  id: string;
  shotId: string;
  source: PromptSource;
  directorPlanVersionId: string | null;
  h3Mode: H3Mode;
  text: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export type PreflightSeverity = 'error' | 'warning' | 'info';

export interface PreflightCheck {
  key: string;
  severity: PreflightSeverity;
  message: string;
}

export interface PreflightSection {
  key: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  label: string;
  checks: PreflightCheck[];
}

export interface PreflightReport {
  id: string;
  shotId: string;
  promptVersionId: string | null;
  basic: PreflightSection[];
  semantic: PreflightSection[] | null; // null when AI not run
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  blocked: boolean;
  aiSemanticRun: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export type RenderJobStatus =
  | 'UPLOADING'
  | 'SUBMITTING'
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'DOWNLOADING'
  | 'LOCAL_READY'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';

export interface RenderRequest {
  provider: string;
  aiAppId: string;
  mode: H3Mode;
  promptVersionId: string;
  durationSeconds: number;
  aspectRatio: string;
  resolution?: string;
  references: { bindingId: string; assetId: string; kind: MediaKind }[];
  providerParams: Record<string, unknown>;
}

export interface RenderJob {
  id: string;
  shotId: string;
  promptVersionId: string;
  directorPlanVersionId: string | null;
  provider: string;
  providerTaskId: string | null;
  status: RenderJobStatus;
  submittedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  requestSnapshot: RenderRequest | null;
  providerResponseSnapshot: Record<string, unknown> | null;
  cost: { credits?: number; unit?: string; raw?: unknown } | null;
  error: string | null;
  takeId: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Take
// ---------------------------------------------------------------------------

export type TakeStatus = 'candidate' | 'selected' | 'rejected';

export const FAILURE_TAGS = [
  'identity_drift',
  'bad_anatomy',
  'physics',
  'camera',
  'motion',
  'continuity',
  'composition',
  'lighting',
  'reference_mismatch',
  'text',
  'audio',
  'other',
] as const;

export type FailureTag = (typeof FAILURE_TAGS)[number];

export interface Take {
  id: string;
  shotId: string;
  renderJobId: string;
  promptVersionId: string;
  directorPlanVersionId: string | null;
  localVideoPath: string; // relative under project shots/<shot>/takes/
  posterPath: string | null;
  firstFramePath: string | null;
  lastFramePath: string | null;
  duration: number;
  status: TakeStatus;
  rating: number | null;
  failureTags: FailureTag[];
  notes: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Continuity
// ---------------------------------------------------------------------------

export interface VisualContinuityState {
  characterStates: Record<string, string>; // characterId -> characterStateId
  costume: Record<string, string>;
  hair: Record<string, string>;
  injury: Record<string, string>;
  heldItems: Record<string, string[]>;
  location: string;
  timeOfDay: string;
  weather: string;
  wind: string;
  screenDirection: string;
  facing: string;
  vehicleState: Record<string, string>;
  notes: string;
}

export interface ContinuityEntry {
  id: string;
  shotId: string;
  scope: 'visual' | 'narrative';
  kind: 'planned' | 'actual';
  sourceTakeId: string | null;
  state: VisualContinuityState | null;
  narrative: NarrativeState | null;
  committedAt: string;
  createdAt: string;
}

export interface NarrativeState {
  knowledge: string[];
  relationships: string[];
  dramaticState: string;
  goals: string[];
  knownEvents: string[];
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export interface TimelineClip {
  id: string;
  order: number;
  shotId: string;
  takeId: string;
  /** Trim within the take's video, seconds. */
  trimIn: number;
  trimOut: number | null;
  transition: 'cut' | 'fade' | 'dissolve' | 'none';
  transitionDuration: number;
  audio: { volume: number; mute: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface TimelineDoc {
  id: string;
  title: string;
  clips: TimelineClip[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Provider / AI profiles
// ---------------------------------------------------------------------------

export interface ProviderCapabilities {
  supportedModes: H3Mode[];
  minDuration?: number;
  maxDuration?: number;
  supportedAspectRatios?: string[];
  supportedResolutions?: string[];
  maxImageRefs?: number;
  maxVideoRefs?: number;
  maxAudioRefs?: number;
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
  /** Business input → app node slot mapping. */
  inputs: {
    prompt: { nodeId: string; fieldName: string };
    mode?: { nodeId: string; fieldName: string };
    firstFrame?: { nodeId: string; fieldName: string };
    lastFrame?: { nodeId: string; fieldName: string };
    motion?: { nodeId: string; fieldName: string };
    audio?: { nodeId: string; fieldName: string };
    duration?: { nodeId: string; fieldName: string };
    resolution?: { nodeId: string; fieldName: string };
    extra?: { nodeId: string; fieldName: string };
  };
  /** Verified via live invoke example — null until verified. */
  verification: {
    status: 'unverified' | 'verified' | 'failed';
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

// ---------------------------------------------------------------------------
// Events (SSE payloads)
// ---------------------------------------------------------------------------

export type AppEvent =
  | { type: 'render.job.created'; jobId: string; shotId: string }
  | { type: 'render.job.queued'; jobId: string; shotId: string }
  | { type: 'render.job.running'; jobId: string; shotId: string }
  | { type: 'render.job.succeeded'; jobId: string; shotId: string; takeId: string }
  | { type: 'render.job.failed'; jobId: string; shotId: string; error: string }
  | { type: 'render.job.updated'; jobId: string; shotId: string; status: RenderJobStatus }
  | { type: 'take.created'; takeId: string; shotId: string }
  | { type: 'take.selected'; takeId: string; shotId: string }
  | { type: 'continuity.committed'; shotId: string; scope: 'visual' | 'narrative' }
  | { type: 'shot.updated'; shotId: string; status: ShotStatus }
  | { type: 'project.updated' }
  | { type: 'job.updated'; jobId: string; status: 'running' | 'done' | 'failed' | 'cancelled'; kind: string };
