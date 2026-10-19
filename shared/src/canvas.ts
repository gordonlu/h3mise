// Studio Canvas projection model (docs/studio-canvas/02-prd-tech.md §7).
// The canvas is a *projection* of the domain model: nodes/edges are derived from
// story/beat/shot/take/asset/timeline rows. Only layout (position/collapse/
// viewport/notes) is persisted; no second source of truth lives here.
// ---------------------------------------------------------------------------

import type { ShotStatus, ShotUserStatus, ShotRenderDependencyMode } from './shots.js';
import type { H3Mode } from './director.js';
import type { EntityKind, MediaKind, ReferenceRole } from './assets.js';
import type { StoryboardStatus } from './storyboard.js';
import type { TakeStatus } from './render.js';

export type CanvasNodeKind =
  | 'story' | 'beat' | 'sequence' | 'storyboard'
  | 'entity' | 'character_state' | 'media' | 'breakdown'
  | 'shot' | 'takes' | 'timeline' | 'export'
  | 'note' | 'frame';

export type CanvasPortType =
  | 'TEXT' | 'BEAT' | 'ENTITY' | 'IMAGE' | 'FRAME' | 'VIDEO' | 'AUDIO' | 'TAKE' | 'CLIP';

/** Stable node id: `${kind}:${domainId}` (e.g. `shot:shot-002`, `takes:shot-002`). */
export type CanvasNodeId = string;

export type CanvasPortId =
  | 'beats' | 'story' | 'beat'
  | 'entity' | 'image' | 'video' | 'audio'
  | 'cast' | 'first_frame' | 'last_frame' | 'refs' | 'video_ref' | 'audio_ref'
  | 'takes' | 'tail_frame' | 'selected' | 'clips' | 'timeline'
  | `panel:${string}`;

export interface CanvasPort {
  id: CanvasPortId;
  type: CanvasPortType;
  direction: 'in' | 'out';
  label: string;
  multiple: boolean;
  visible: boolean;
  userConnectable: boolean;
}

export interface CanvasBadge {
  kind: 'paid' | 'blocker' | 'warning' | 'agent' | 'waiting' | 'locked' | 'stale';
  count?: number;
  text?: string;
}

export type CanvasLane = 'cast' | 'reference' | 'story' | 'beats' | 'storyboard' | 'shots' | 'takes' | 'edit' | 'free';

export interface CanvasNodeBase<K extends CanvasNodeKind, D> {
  id: CanvasNodeId;
  kind: K;
  domainId: string;
  title: string;
  lane: CanvasLane;
  /** Narrative ordering key used by lane layout (beat order, shot order…). */
  rowKey: number;
  ports: CanvasPort[];
  badges: CanvasBadge[];
  /** Parent group (sequence frame) if any. */
  groupId?: CanvasNodeId | null;
  data: D;
}

export interface ShotNodeData {
  order: number;
  status: ShotStatus;
  userStatus: ShotUserStatus;
  h3Mode: H3Mode | null;
  durationSeconds: number;
  aspectRatio: string;
  storyBeatId: string | null;
  primaryCharacterId: string | null;
  sceneId: string | null;
  renderDependencyMode: ShotRenderDependencyMode;
  dependsOnShotId: string | null;
  dependencyReady: boolean;
  castChips: Array<{ entityId: string; name: string; kind: EntityKind; imageAssetId: string | null }>;
  missingRequired: string[];
  coverPath: string | null;
  previewTakeId: string | null;
  hasPlan: boolean;
  latestPromptVersionId: string | null;
  latestPreflight: { id: string; blocked: boolean; risk: string | null; stale: boolean } | null;
  activeJob: { id: string; status: string } | null;
  takeCount: number;
  candidateCount: number;
  selectedTakeId: string | null;
  guideSteps: Array<{ key: string; state: string }>;
  pendingAiRequestIds: string[];
}

export interface TakesNodeData {
  shotId: string;
  takes: Array<{
    id: string;
    status: TakeStatus;
    posterPath: string | null;
    rating: number | null;
    failureTags: string[];
    duration: number;
    createdAt: string;
  }>;
}

export interface BeatNodeData {
  order: number;
  category: string;
  summary: string;
  durationSeconds: number;
  location?: string;
  timeOfDay?: string;
  weather?: string;
  shotIds: string[];
}

export interface StoryNodeData {
  synopsis: string;
  plannedDurationSeconds: number;
  beatDurationSeconds: number;
  beatCount: number;
}

export interface StoryboardNodeData {
  pageNumber: number;
  totalPages: number;
  panelCount: 3 | 6 | 9;
  status: StoryboardStatus;
  sourceStartIndex: number;
  sourceEndIndex: number;
  panels: Array<{ id: string; order: number; description: string; assetId: string | null; version: number }>;
  activeJobId: string | null;
}

export interface BreakdownNodeData {
  mediaId: string;
  mediaKind: MediaKind;
  posterPath: string | null;
  durationSeconds: number | null;
  segmentCount: number;
  frameCount: number;
  hasAnalysis: boolean;
  revision: number;
}

export interface EntityNodeData {
  entityKind: EntityKind;
  imageAssetId: string | null;
  stateCount: number;
  usageShotIds: string[];
}

export interface CharacterStateNodeData {
  characterId: string;
  effectiveImageAssetId: string | null;
}

export interface MediaNodeData {
  mediaKind: MediaKind;
  posterPath: string | null;
  durationSeconds?: number;
  userPlaced: boolean;
}

export interface TimelineNodeData {
  clipCount: number;
  durationSeconds: number;
  clips: Array<{ id: string; order: number; shotId: string; takeId: string }>;
}

export interface ExportNodeData {
  latest: { relPath: string; durationSeconds: number | null; createdAt: string } | null;
  exportCount: number;
}

export interface AnnotationNodeData {
  text: string;
  color: string;
  width: number;
  height: number;
}

export type CanvasNode =
  | CanvasNodeBase<'story', StoryNodeData>
  | CanvasNodeBase<'beat', BeatNodeData>
  | CanvasNodeBase<'sequence', { order: number }>
  | CanvasNodeBase<'storyboard', StoryboardNodeData>
  | CanvasNodeBase<'entity', EntityNodeData>
  | CanvasNodeBase<'character_state', CharacterStateNodeData>
  | CanvasNodeBase<'media', MediaNodeData>
  | CanvasNodeBase<'breakdown', BreakdownNodeData>
  | CanvasNodeBase<'shot', ShotNodeData>
  | CanvasNodeBase<'takes', TakesNodeData>
  | CanvasNodeBase<'timeline', TimelineNodeData>
  | CanvasNodeBase<'export', ExportNodeData>
  | CanvasNodeBase<'note' | 'frame', AnnotationNodeData>;

export type CanvasEdgeKind =
  | 'story_beat'
  | 'beat_shot'
  | 'cast'
  | 'binding'
  | 'frame_chain'
  | 'storyboard_panel'
  | 'shot_takes'
  | 'take_clip'
  | 'timeline_export'
  | 'continuity';

export interface CanvasEdge {
  id: string;
  kind: CanvasEdgeKind;
  source: CanvasNodeId;
  sourcePort: CanvasPortId;
  target: CanvasNodeId;
  targetPort: CanvasPortId;
  derived: boolean;
  focusOnly: boolean;
  data?: { roles?: ReferenceRole[]; bindingId?: string; clipId?: string; order?: number };
}

export interface CanvasGraph {
  projectId: string;
  storyId: string;
  revision: string;
  generatedAt: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface CanvasNodeLayout {
  nodeId: CanvasNodeId;
  x: number;
  y: number;
  width?: number | null;
  height?: number | null;
  collapsed: boolean;
  pinned: boolean;
  userPlaced: boolean;
}

export interface CanvasViewState {
  viewport: { x: number; y: number; zoom: number };
  layoutMode: 'lanes' | 'free';
  edgeVisibility: 'default' | 'all';
  hiddenLanes: CanvasLane[];
}

export interface CanvasAnnotation {
  id: string;
  kind: 'note' | 'frame';
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: string;
}

export interface CanvasLayoutDoc {
  storyId: string;
  nodes: CanvasNodeLayout[];
  view: CanvasViewState;
  annotations: CanvasAnnotation[];
  updatedAt: string;
}

export interface CanvasConnectRequest {
  storyId: string;
  source: { nodeId: CanvasNodeId; port: CanvasPortId };
  target: { nodeId: CanvasNodeId; port: CanvasPortId };
  options?: {
    roles?: ReferenceRole[];
    preserve?: string[];
    ignore?: string[];
    replace?: boolean;
    switchMode?: H3Mode;
  };
}

export interface CanvasConnectResult {
  ok: true;
  edgeId: string;
  affectedNodeIds: CanvasNodeId[];
  undo: { method: 'DELETE'; edgeId: string } | { method: 'POST'; request: CanvasConnectRequest } | null;
}

export type CanvasConnectErrorCode =
  | 'invalid_connection'
  | 'needs_replace'
  | 'needs_mode_switch'
  | 'cycle'
  | 'reference_limit'
  | 'locked'
  | 'not_found'
  | 'stale_episode';

// ---------------------------------------------------------------------------
// Id + port helpers (shared by the server graph builder and the web canvas).
// ---------------------------------------------------------------------------

export function canvasNodeId(kind: CanvasNodeKind, domainId: string): CanvasNodeId {
  return `${kind}:${domainId}`;
}

export function parseCanvasNodeId(id: CanvasNodeId): { kind: string; domainId: string } {
  const index = id.indexOf(':');
  if (index < 0) return { kind: '', domainId: id };
  return { kind: id.slice(0, index), domainId: id.slice(index + 1) };
}

function port(
  id: CanvasPortId,
  type: CanvasPortType,
  direction: 'in' | 'out',
  label: string,
  options: { multiple?: boolean; visible?: boolean; userConnectable?: boolean } = {},
): CanvasPort {
  return {
    id,
    type,
    direction,
    label,
    multiple: options.multiple ?? false,
    visible: options.visible ?? true,
    userConnectable: options.userConnectable ?? (direction === 'in'),
  };
}

/** Shot ports. `last_frame` shows only in fl2va/l2va, `video_ref` only in vref2va. */
export function shotNodePorts(h3Mode: H3Mode | null): CanvasPort[] {
  const frameMode = h3Mode === 'fl2va' || h3Mode === 'l2va';
  const videoMode = h3Mode === 'vref2va';
  return [
    port('beat', 'BEAT', 'in', '归属节拍'),
    port('cast', 'ENTITY', 'in', '角色/场景'),
    port('first_frame', 'FRAME', 'in', '首帧'),
    port('last_frame', 'FRAME', 'in', '尾帧', { visible: frameMode }),
    port('refs', 'IMAGE', 'in', '参考图', { multiple: true }),
    port('video_ref', 'VIDEO', 'in', '视频参考', { visible: videoMode }),
    port('audio_ref', 'AUDIO', 'in', '音频参考'),
    port('takes', 'TAKE', 'out', '生成结果', { multiple: true, userConnectable: false }),
    port('tail_frame', 'FRAME', 'out', '尾帧输出', { userConnectable: true }),
  ];
}

export function storyNodePorts(): CanvasPort[] {
  return [port('beats', 'BEAT', 'out', '节拍', { multiple: true, userConnectable: false })];
}

export function beatNodePorts(): CanvasPort[] {
  return [
    port('story', 'TEXT', 'in', '故事', { userConnectable: false }),
    port('beat', 'BEAT', 'out', '节拍', { userConnectable: true }),
  ];
}

export function sequenceNodePorts(): CanvasPort[] {
  return [port('beats', 'BEAT', 'out', '节拍', { multiple: true, userConnectable: false })];
}

export function storyboardNodePorts(panelIds: string[]): CanvasPort[] {
  return panelIds.map((id) => port(`panel:${id}`, 'IMAGE', 'out', `格 ${id}`, { userConnectable: false }));
}

export function entityNodePorts(): CanvasPort[] {
  return [port('entity', 'ENTITY', 'out', '实体', { userConnectable: true })];
}

export function characterStateNodePorts(): CanvasPort[] {
  return [port('image', 'IMAGE', 'out', '状态图', { userConnectable: true })];
}

export function mediaNodePorts(kind: MediaKind): CanvasPort[] {
  const type: CanvasPortType = kind === 'image' ? 'IMAGE' : kind === 'video' ? 'VIDEO' : 'AUDIO';
  return [port(kind, type, 'out', kind === 'image' ? '图片' : kind === 'video' ? '视频' : '音频', { userConnectable: true })];
}

export function takesNodePorts(): CanvasPort[] {
  return [
    port('takes', 'TAKE', 'in', '结果', { multiple: true, userConnectable: false }),
    port('selected', 'TAKE', 'out', '入选', { userConnectable: true }),
  ];
}

export function timelineNodePorts(): CanvasPort[] {
  return [
    port('clips', 'CLIP', 'in', '片段', { multiple: true }),
    port('timeline', 'VIDEO', 'out', '成片', { userConnectable: false }),
  ];
}

export function exportNodePorts(): CanvasPort[] {
  return [port('timeline', 'VIDEO', 'in', '时间线', { userConnectable: false })];
}
