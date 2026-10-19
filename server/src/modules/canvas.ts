// Studio Canvas module — layout + annotations (docs/studio-canvas/02-prd-tech.md
// §9–§10). The canvas is a *projection* of the domain model: this module only
// persists layout (position/collapse/viewport/notes). Graph projection and
// connection commands are added by later work packages in this same file.

import type {
  CanvasAnnotation,
  CanvasBadge,
  CanvasConnectErrorCode,
  CanvasConnectRequest,
  CanvasConnectResult,
  CanvasEdge,
  CanvasGraph,
  CanvasLane,
  CanvasLayoutDoc,
  CanvasNode,
  CanvasNodeId,
  CanvasNodeLayout,
  CanvasPortId,
  CanvasViewState,
  BeatNodeData,
  BreakdownNodeData,
  CharacterStateNodeData,
  Entity,
  EntityNodeData,
  ExportNodeData,
  H3Mode,
  MediaKind,
  MediaNodeData,
  ProviderCapabilities,
  ReferenceRole,
  Shot,
  ShotNodeData,
  StoryNodeData,
  StoryboardNodeData,
  TakeStatus,
  TakesNodeData,
  TimelineNodeData,
} from '@h3mise/shared';
import {
  DEFAULT_LANE_ORDER,
  SHOT_USER_STATUS,
  beatNodePorts,
  canConnect,
  canvasNodeId,
  characterStateNodePorts,
  deriveShotGuideState,
  entityNodePorts,
  exportNodePorts,
  mediaNodePorts,
  sequenceNodePorts,
  shotNodePorts,
  storyNodePorts,
  storyboardNodePorts,
  takesNodePorts,
  timelineNodePorts,
} from '@h3mise/shared';
import { createHash } from 'node:crypto';
import type { ProjectContext } from '../project-store.js';
import { j, jget } from '../db/sqlite.js';
import { nextId } from '../db/ids.js';
import { activeEpisodeId } from './story.js';
import * as storyMod from './story.js';
import * as shotsMod from './shots.js';
import * as assetsMod from './assets.js';
import * as storyboardMod from './storyboard.js';
import * as timelineMod from './timeline.js';
import { referenceCountViolations } from './preflight.js';

export type CanvasErrorCode = CanvasConnectErrorCode | 'payload_too_large';

export class CanvasError extends Error {
  constructor(
    readonly code: CanvasErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CanvasError';
  }
}

export const MAX_LAYOUT_NODES = 500;

export const DEFAULT_CANVAS_VIEW: CanvasViewState = {
  viewport: { x: 0, y: 0, zoom: 1 },
  layoutMode: 'lanes',
  edgeVisibility: 'default',
  hiddenLanes: [],
};

/** The active episode. A request for a different episode is stale (409). */
export function resolveActiveStory(p: ProjectContext, requested?: string): string {
  const active = activeEpisodeId(p);
  if (requested && requested !== active) {
    throw new CanvasError('stale_episode', '画布作用域不是当前集');
  }
  return active;
}

interface LayoutRow {
  node_id: string;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  collapsed: number;
  pinned: number;
  user_placed: number;
}

interface AnnotationRow {
  id: string;
  kind: 'note' | 'frame';
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  color: string;
}

function layoutFromRow(row: LayoutRow): CanvasNodeLayout {
  return {
    nodeId: row.node_id,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    collapsed: row.collapsed === 1,
    pinned: row.pinned === 1,
    userPlaced: row.user_placed === 1,
  };
}

function annotationFromRow(row: AnnotationRow): CanvasAnnotation {
  return {
    id: row.id,
    kind: row.kind,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    text: row.text,
    color: row.color,
  };
}

function readView(p: ProjectContext, storyId: string): CanvasViewState {
  const row = p.db.get<{ view_json: string }>('SELECT view_json FROM canvas_views WHERE story_id = ?', [storyId]);
  if (!row) return { ...DEFAULT_CANVAS_VIEW, viewport: { ...DEFAULT_CANVAS_VIEW.viewport }, hiddenLanes: [] };
  const stored = jget<Partial<CanvasViewState>>(row.view_json, {});
  return {
    viewport: stored.viewport ?? { ...DEFAULT_CANVAS_VIEW.viewport },
    layoutMode: stored.layoutMode === 'free' ? 'free' : 'lanes',
    edgeVisibility: stored.edgeVisibility === 'all' ? 'all' : 'default',
    hiddenLanes: Array.isArray(stored.hiddenLanes) ? stored.hiddenLanes : [],
  };
}

/** Domain-object ids that currently exist for an episode, as canvas node ids.
 * Used to lazily drop layout rows whose domain object was deleted. */
export function existingDomainNodeIds(p: ProjectContext, storyId: string): Set<string> {
  const ids = new Set<string>();
  const add = (kind: string, id: string): void => {
    ids.add(`${kind}:${id}`);
  };
  if (p.db.get('SELECT 1 FROM story WHERE id = ?', [storyId])) add('story', storyId);
  for (const row of p.db.all<{ id: string }>('SELECT id FROM sequences WHERE story_id = ?', [storyId])) add('sequence', row.id);
  for (const row of p.db.all<{ id: string }>('SELECT id FROM story_beats WHERE story_id = ?', [storyId])) add('beat', row.id);
  for (const row of p.db.all<{ id: string }>('SELECT id FROM shots WHERE story_id = ?', [storyId])) {
    add('shot', row.id);
    add('takes', row.id);
  }
  for (const row of p.db.all<{ id: string }>('SELECT id FROM entities')) add('entity', row.id);
  for (const row of p.db.all<{ id: string }>('SELECT id FROM character_states')) add('character_state', row.id);
  for (const row of p.db.all<{ id: string }>('SELECT id FROM media_assets')) add('media', row.id);
  for (const row of p.db.all<{ id: string }>('SELECT id FROM storyboards WHERE story_id = ?', [storyId])) add('storyboard', row.id);
  const timeline = p.db.get<{ id: string }>('SELECT id FROM timeline LIMIT 1');
  if (timeline) {
    add('timeline', timeline.id);
    add('export', timeline.id);
  }
  return ids;
}

/** Drop layout rows whose domain object no longer exists. Returns the count. */
export function pruneOrphanLayouts(p: ProjectContext, storyId: string, validNodeIds: Set<string>): number {
  const rows = p.db.all<{ node_id: string }>('SELECT node_id FROM canvas_node_layouts WHERE story_id = ?', [storyId]);
  let removed = 0;
  for (const row of rows) {
    if (validNodeIds.has(row.node_id)) continue;
    p.db.run('DELETE FROM canvas_node_layouts WHERE story_id = ? AND node_id = ?', [storyId, row.node_id]);
    removed++;
  }
  return removed;
}

export function getLayout(p: ProjectContext, requestedStoryId?: string): CanvasLayoutDoc {
  const storyId = resolveActiveStory(p, requestedStoryId);
  pruneOrphanLayouts(p, storyId, existingDomainNodeIds(p, storyId));
  const rows = p.db.all<LayoutRow>('SELECT * FROM canvas_node_layouts WHERE story_id = ? ORDER BY node_id', [storyId]);
  const annotations = p.db.all<AnnotationRow>('SELECT * FROM canvas_annotations WHERE story_id = ? ORDER BY created_at, id', [storyId]);
  const updatedAt =
    p.db.get<{ updated_at: string }>(
      'SELECT MAX(updated_at) AS updated_at FROM canvas_node_layouts WHERE story_id = ?',
      [storyId],
    )?.updated_at ??
    p.db.get<{ updated_at: string }>('SELECT updated_at FROM canvas_views WHERE story_id = ?', [storyId])?.updated_at ??
    new Date(0).toISOString();
  return {
    storyId,
    nodes: rows.map(layoutFromRow),
    view: readView(p, storyId),
    annotations: annotations.map(annotationFromRow),
    updatedAt,
  };
}

export interface SaveLayoutInput {
  storyId: string;
  nodes: CanvasNodeLayout[];
  removeNodeIds?: CanvasNodeId[];
  view?: CanvasViewState;
}

export function saveLayout(p: ProjectContext, input: SaveLayoutInput): CanvasLayoutDoc {
  const storyId = resolveActiveStory(p, input.storyId);
  const nodes = input.nodes ?? [];
  if (nodes.length > MAX_LAYOUT_NODES) {
    throw new CanvasError('payload_too_large', `单次最多保存 ${MAX_LAYOUT_NODES} 个节点布局`);
  }
  const now = new Date().toISOString();
  p.db.tx(() => {
    for (const node of nodes) {
      p.db.run(
        `INSERT INTO canvas_node_layouts (story_id, node_id, x, y, width, height, collapsed, pinned, user_placed, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(story_id, node_id) DO UPDATE SET
           x = excluded.x, y = excluded.y, width = excluded.width, height = excluded.height,
           collapsed = excluded.collapsed, pinned = excluded.pinned, user_placed = excluded.user_placed,
           updated_at = excluded.updated_at`,
        [
          storyId,
          node.nodeId,
          node.x,
          node.y,
          node.width ?? null,
          node.height ?? null,
          node.collapsed ? 1 : 0,
          node.pinned ? 1 : 0,
          node.userPlaced ? 1 : 0,
          now,
        ],
      );
    }
    for (const nodeId of input.removeNodeIds ?? []) {
      p.db.run('DELETE FROM canvas_node_layouts WHERE story_id = ? AND node_id = ?', [storyId, nodeId]);
    }
    if (input.view) {
      p.db.run(
        `INSERT INTO canvas_views (story_id, view_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(story_id) DO UPDATE SET view_json = excluded.view_json, updated_at = excluded.updated_at`,
        [storyId, j(input.view), now],
      );
    }
  });
  return getLayout(p, storyId);
}

/** Reset positions to the deterministic lane layout. Annotations are preserved. */
export function resetLayout(p: ProjectContext, requestedStoryId?: string): CanvasLayoutDoc {
  const storyId = resolveActiveStory(p, requestedStoryId);
  p.db.run('DELETE FROM canvas_node_layouts WHERE story_id = ?', [storyId]);
  return getLayout(p, storyId);
}

// ---------------------------------------------------------------------------
// Annotations (notes / frames) — layout-only, never domain data.
// ---------------------------------------------------------------------------

export interface CreateAnnotationInput {
  storyId?: string;
  kind: 'note' | 'frame';
  x: number;
  y: number;
  width?: number;
  height?: number;
  text?: string;
  color?: string;
}

export function listAnnotations(p: ProjectContext, storyId: string): CanvasAnnotation[] {
  return p.db
    .all<AnnotationRow>('SELECT * FROM canvas_annotations WHERE story_id = ? ORDER BY created_at, id', [storyId])
    .map(annotationFromRow);
}

export function createAnnotation(p: ProjectContext, input: CreateAnnotationInput): CanvasAnnotation {
  const storyId = resolveActiveStory(p, input.storyId);
  if (input.kind !== 'note' && input.kind !== 'frame') {
    throw new CanvasError('invalid_connection', '注释类型无效');
  }
  const id = nextId(p.db, 'note');
  const now = new Date().toISOString();
  p.db.run(
    `INSERT INTO canvas_annotations (id, story_id, kind, x, y, width, height, text, color, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      storyId,
      input.kind,
      input.x,
      input.y,
      input.width ?? (input.kind === 'note' ? 240 : 480),
      input.height ?? (input.kind === 'note' ? 160 : 320),
      input.text ?? '',
      input.color ?? '',
      now,
      now,
    ],
  );
  const row = p.db.get<AnnotationRow>('SELECT * FROM canvas_annotations WHERE id = ?', [id]);
  if (!row) throw new CanvasError('not_found', '注释创建失败');
  return annotationFromRow(row);
}

export interface UpdateAnnotationInput {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  text?: string;
  color?: string;
}

export function updateAnnotation(p: ProjectContext, id: string, patch: UpdateAnnotationInput): CanvasAnnotation {
  const existing = p.db.get<AnnotationRow>('SELECT * FROM canvas_annotations WHERE id = ?', [id]);
  if (!existing) throw new CanvasError('not_found', '注释不存在');
  const next = {
    x: patch.x ?? existing.x,
    y: patch.y ?? existing.y,
    width: patch.width ?? existing.width,
    height: patch.height ?? existing.height,
    text: patch.text ?? existing.text,
    color: patch.color ?? existing.color,
  };
  p.db.run(
    'UPDATE canvas_annotations SET x = ?, y = ?, width = ?, height = ?, text = ?, color = ?, updated_at = ? WHERE id = ?',
    [next.x, next.y, next.width, next.height, next.text, next.color, new Date().toISOString(), id],
  );
  const row = p.db.get<AnnotationRow>('SELECT * FROM canvas_annotations WHERE id = ?', [id]);
  if (!row) throw new CanvasError('not_found', '注释不存在');
  return annotationFromRow(row);
}

export function deleteAnnotation(p: ProjectContext, id: string): void {
  const result = p.db.run('DELETE FROM canvas_annotations WHERE id = ?', [id]);
  if (result.changes === 0) throw new CanvasError('not_found', '注释不存在');
}

// ---------------------------------------------------------------------------
// Graph projection — GET /api/canvas/graph (spec §11). Read-only and
// deterministic: the same domain data yields the same nodes/edges/revision.
// ---------------------------------------------------------------------------

const LANE_INDEX = new Map<CanvasLane, number>(DEFAULT_LANE_ORDER.map((lane, index) => [lane, index]));

interface TakeRow {
  id: string;
  shot_id: string;
  status: TakeStatus;
  poster_path: string | null;
  rating: number | null;
  failure_tags_json: string;
  duration: number;
  created_at: string;
  last_frame_path: string | null;
}

interface JobRow {
  id: string;
  shot_id: string;
  status: string;
}

interface PromptRow {
  id: string;
  shot_id: string;
  created_at: string;
}

interface PreflightRow {
  id: string;
  shot_id: string;
  prompt_version_id: string;
  blocked: number;
  risk: string | null;
  created_at: string;
}

interface MediaRow {
  id: string;
  kind: string;
  file_name: string;
  poster_path: string | null;
  duration_seconds: number | null;
}

interface BindingRow {
  id: string;
  asset_id: string;
  type: string;
  roles_json: string;
  label: string;
  shot_id: string | null;
  source_entity_id: string | null;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

function compareNodes(a: CanvasNode, b: CanvasNode): number {
  const laneA = LANE_INDEX.get(a.lane) ?? 99;
  const laneB = LANE_INDEX.get(b.lane) ?? 99;
  return laneA - laneB || a.rowKey - b.rowKey || a.id.localeCompare(b.id);
}

function edge(
  id: string,
  kind: CanvasEdge['kind'],
  source: CanvasNodeId,
  sourcePort: CanvasPortId,
  target: CanvasNodeId,
  targetPort: CanvasPortId,
  derived: boolean,
  focusOnly = false,
  data?: CanvasEdge['data'],
): CanvasEdge {
  return { id, kind, source, sourcePort, target, targetPort, derived, focusOnly, ...(data ? { data } : {}) };
}

export interface BuildGraphOptions {
  /** Show the `paid` badge on action nodes. Defaults to the project provider. */
  paidProvider?: boolean;
}

export function buildCanvasGraph(p: ProjectContext, options: BuildGraphOptions = {}): CanvasGraph {
  const storyId = activeEpisodeId(p);
  const paidProvider = options.paidProvider ?? p.config.default_provider !== 'mock';

  const story = storyMod.getStory(p);
  const beats = storyMod.listBeats(p);
  const sequences = storyMod.listSequences(p);
  const shots = shotsMod.listShots(p);
  const entities = assetsMod.listEntities(p);
  const states = assetsMod.listCharacterStates(p);
  const storyboards = storyboardMod.listStoryboardPages(p);
  const timeline = timelineMod.getTimeline(p);
  const exports = timelineMod.listTimelineExports(p);

  const shotIds = shots.map((shot) => shot.id);
  const ph = shotIds.length ? placeholders(shotIds.length) : '';

  const takesByShot = new Map<string, TakeRow[]>();
  const selectedTakeByShot = new Map<string, { id: string; lastFramePath: string | null }>();
  const activeJobByShot = new Map<string, JobRow>();
  const latestPromptByShot = new Map<string, PromptRow>();
  const latestPreflightByShot = new Map<string, PreflightRow>();
  const planShots = new Set<string>();
  const bindingRows: BindingRow[] = [];
  const continuityShots = new Set<string>();
  const pendingByShot = new Map<string, string[]>();

  if (shotIds.length > 0) {
    for (const row of p.db.all<TakeRow>(
      `SELECT id, shot_id, status, poster_path, rating, failure_tags_json, duration, created_at, last_frame_path
       FROM takes WHERE shot_id IN (${ph}) ORDER BY created_at DESC`,
      shotIds,
    )) {
      const bucket = takesByShot.get(row.shot_id) ?? [];
      bucket.push(row);
      takesByShot.set(row.shot_id, bucket);
      if (row.status === 'selected' && !selectedTakeByShot.has(row.shot_id)) {
        selectedTakeByShot.set(row.shot_id, { id: row.id, lastFramePath: row.last_frame_path });
      }
    }
    for (const row of p.db.all<JobRow>(
      `SELECT id, shot_id, status FROM render_jobs
       WHERE shot_id IN (${ph}) AND status IN ('LOCAL_QUEUED','UPLOADING','SUBMITTING','QUEUED','RUNNING','DOWNLOADING')
       ORDER BY created_at DESC`,
      shotIds,
    )) {
      if (!activeJobByShot.has(row.shot_id)) activeJobByShot.set(row.shot_id, row);
    }
    for (const row of p.db.all<PromptRow>(
      `SELECT id, shot_id, created_at FROM prompt_versions WHERE shot_id IN (${ph}) ORDER BY created_at`,
      shotIds,
    )) {
      latestPromptByShot.set(row.shot_id, row);
    }
    for (const row of p.db.all<PreflightRow>(
      `SELECT id, shot_id, prompt_version_id, blocked, risk, created_at FROM preflight_reports WHERE shot_id IN (${ph}) ORDER BY created_at`,
      shotIds,
    )) {
      latestPreflightByShot.set(row.shot_id, row);
    }
    for (const row of p.db.all<{ shot_id: string }>(
      `SELECT DISTINCT shot_id FROM director_plan_versions WHERE shot_id IN (${ph})`,
      shotIds,
    )) {
      planShots.add(row.shot_id);
    }
    for (const row of p.db.all<BindingRow>(`SELECT * FROM reference_bindings WHERE shot_id IN (${ph})`, shotIds)) {
      bindingRows.push(row);
    }
    for (const row of p.db.all<{ shot_id: string }>(
      `SELECT DISTINCT shot_id FROM continuity_entries WHERE shot_id IN (${ph}) AND scope = 'visual' AND kind = 'actual'`,
      shotIds,
    )) {
      continuityShots.add(row.shot_id);
    }
  }

  for (const row of p.db.all<{ body_json: string }>("SELECT body_json FROM ai_requests WHERE status = 'pending'")) {
    const body = jget<{ shotId?: unknown }>(row.body_json, {});
    if (typeof body.shotId === 'string') {
      const bucket = pendingByShot.get(body.shotId) ?? [];
      bucket.push(body.shotId);
      pendingByShot.set(body.shotId, bucket);
    }
  }

  const mediaRows = p.db.all<MediaRow>('SELECT id, kind, file_name, poster_path, duration_seconds FROM media_assets');
  const mediaById = new Map(mediaRows.map((row) => [row.id, row]));
  const mediaIdByFileName = new Map(mediaRows.map((row) => [row.file_name, row.id]));
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const stateById = new Map(states.map((state) => [state.id, state]));

  const bindingsByShot = new Map<string, BindingRow[]>();
  for (const row of bindingRows) {
    if (!row.shot_id) continue;
    const bucket = bindingsByShot.get(row.shot_id) ?? [];
    bucket.push(row);
    bindingsByShot.set(row.shot_id, bucket);
  }

  const orderedShots = [...shots].sort((a, b) => a.order - b.order);
  const shotsById = new Map(shots.map((shot) => [shot.id, shot]));
  const readinessContext = {
    bindingsByShot: new Map([...bindingsByShot.entries()].map(([shotId, rows]) => [shotId, rows.map(bindingFromRow)])),
    shotsById,
    orderedShots,
    selectedTakeByShot,
    mediaIdByFileName,
  };

  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];

  const beatById = new Map(beats.map((beat) => [beat.id, beat]));
  const shotsByBeat = new Map<string, string[]>();
  for (const shot of shots) {
    if (!shot.storyBeatId) continue;
    const bucket = shotsByBeat.get(shot.storyBeatId) ?? [];
    bucket.push(shot.id);
    shotsByBeat.set(shot.storyBeatId, bucket);
  }

  const totalBeatSeconds = beats.reduce((sum, beat) => sum + beat.durationSeconds, 0);

  nodes.push({
    id: canvasNodeId('story', storyId),
    kind: 'story',
    domainId: storyId,
    title: story.title || p.config.title,
    lane: 'story',
    rowKey: 0,
    ports: storyNodePorts(),
    badges: [],
    groupId: null,
    data: {
      synopsis: story.synopsis,
      plannedDurationSeconds: story.plannedDurationSeconds,
      beatDurationSeconds: beats.length ? Math.round(totalBeatSeconds / beats.length) : 0,
      beatCount: beats.length,
    } satisfies StoryNodeData,
  });

  for (const sequence of sequences) {
    nodes.push({
      id: canvasNodeId('sequence', sequence.id),
      kind: 'sequence',
      domainId: sequence.id,
      title: sequence.title,
      lane: 'beats',
      rowKey: sequence.order,
      ports: sequenceNodePorts(),
      badges: [],
      groupId: null,
      data: { order: sequence.order },
    });
    edges.push(edge(`story_beat:${sequence.id}`, 'story_beat', canvasNodeId('story', storyId), 'beats', canvasNodeId('sequence', sequence.id), 'beats', true));
  }

  for (const beat of beats) {
    nodes.push({
      id: canvasNodeId('beat', beat.id),
      kind: 'beat',
      domainId: beat.id,
      title: beat.title,
      lane: 'beats',
      rowKey: beat.order,
      ports: beatNodePorts(),
      badges: [],
      groupId: beat.sequenceId ? canvasNodeId('sequence', beat.sequenceId) : null,
      data: {
        order: beat.order,
        category: beat.category,
        summary: beat.summary,
        durationSeconds: beat.durationSeconds,
        location: beat.location,
        timeOfDay: beat.timeOfDay,
        weather: beat.weather,
        shotIds: shotsByBeat.get(beat.id) ?? [],
      } satisfies BeatNodeData,
    });
    edges.push(edge(`story_beat:${beat.id}`, 'story_beat', canvasNodeId('story', storyId), 'beats', canvasNodeId('beat', beat.id), 'story', true));
  }

  for (const shot of shots) {
    const beat = shot.storyBeatId ? beatById.get(shot.storyBeatId) : undefined;
    const rowKey = beat ? beat.order * 1000 + shot.order : 999_000 + shot.order;
    const takeRows = takesByShot.get(shot.id) ?? [];
    const selected = selectedTakeByShot.get(shot.id);
    const latestPrompt = latestPromptByShot.get(shot.id) ?? null;
    const rawPreflight = latestPreflightByShot.get(shot.id);
    const latestPreflight = rawPreflight
      ? {
          id: rawPreflight.id,
          blocked: rawPreflight.blocked === 1,
          risk: rawPreflight.risk,
          stale: Boolean(latestPrompt && latestPrompt.created_at > rawPreflight.created_at),
        }
      : null;
    const active = activeJobByShot.get(shot.id) ?? null;
    const bindings = bindingsByShot.get(shot.id) ?? [];
    const requirements = assetsMod.shotAssetRequirements(p, shot, {
      bindings: bindings.map(bindingFromRow),
      entities,
      states,
    });
    const missingRequired = requirements.filter((requirement) => requirement.level === 'required').map((requirement) => requirement.label);
    const readiness = shotsMod.renderReadiness(p, shot, readinessContext);
    const coverRow = selected
      ? takeRows.find((row) => row.id === selected.id)
      : takeRows.find((row) => row.status !== 'rejected');
    const candidateCount = takeRows.filter((row) => row.status === 'candidate').length;
    const preflightBlocked = rawPreflight && latestPrompt && rawPreflight.prompt_version_id === latestPrompt.id ? rawPreflight.blocked === 1 : null;
    const guideSteps = deriveShotGuideState({
      id: shot.id,
      order: shot.order,
      title: shot.title || shot.id,
      hasDirectorPlan: planShots.has(shot.id),
      missingReferences: missingRequired,
      hasPrompt: Boolean(latestPrompt),
      preflightBlocked,
      activeRenderJobId: active?.id ?? null,
      takeCount: candidateCount + selectedTakeCount(takeRows),
      selectedTakeId: selected?.id ?? null,
    }).steps.map((step) => ({ key: step.key, state: step.state }));

    const castChips = [shot.primaryCharacterId, shot.sceneId]
      .map((id) => (id ? entityById.get(id) : undefined))
      .filter((entity): entity is Entity => Boolean(entity))
      .map((entity) => ({ entityId: entity.id, name: entity.name, kind: entity.kind, imageAssetId: entity.imageAssetId }));

    const badges: CanvasBadge[] = [];
    if (paidProvider) badges.push({ kind: 'paid' });
    if (missingRequired.length > 0 || latestPreflight?.blocked || !readiness.ready) badges.push({ kind: 'blocker' });
    if (shot.status === 'LOCKED' || active) badges.push({ kind: 'locked' });
    if (latestPreflight?.stale) badges.push({ kind: 'stale' });
    if (pendingByShot.has(shot.id)) badges.push({ kind: 'agent', count: (pendingByShot.get(shot.id) ?? []).length });

    const data: ShotNodeData = {
      order: shot.order,
      status: shot.status,
      userStatus: shotUserStatus(shot.status),
      h3Mode: shot.h3Mode,
      durationSeconds: shot.durationSeconds,
      aspectRatio: shot.aspectRatio,
      storyBeatId: shot.storyBeatId,
      primaryCharacterId: shot.primaryCharacterId,
      sceneId: shot.sceneId,
      renderDependencyMode: shot.renderDependencyMode,
      dependsOnShotId: shot.dependsOnShotId,
      dependencyReady: readiness.ready,
      castChips,
      missingRequired,
      coverPath: coverRow?.poster_path ?? null,
      previewTakeId: coverRow?.id ?? null,
      hasPlan: planShots.has(shot.id),
      latestPromptVersionId: latestPrompt?.id ?? null,
      latestPreflight,
      activeJob: active ? { id: active.id, status: active.status } : null,
      takeCount: takeRows.length,
      candidateCount,
      selectedTakeId: selected?.id ?? null,
      guideSteps,
      pendingAiRequestIds: pendingByShot.get(shot.id) ?? [],
    };

    nodes.push({
      id: canvasNodeId('shot', shot.id),
      kind: 'shot',
      domainId: shot.id,
      title: shot.title || shot.id,
      lane: 'shots',
      rowKey,
      ports: shotNodePorts(shot.h3Mode),
      badges,
      groupId: null,
      data,
    });

    if (shot.storyBeatId) {
      edges.push(edge(`beat_shot:${shot.id}`, 'beat_shot', canvasNodeId('beat', shot.storyBeatId), 'beat', canvasNodeId('shot', shot.id), 'beat', false));
    }
    if (shot.primaryCharacterId) {
      edges.push(edge(`cast:${shot.id}:${shot.primaryCharacterId}`, 'cast', canvasNodeId('entity', shot.primaryCharacterId), 'entity', canvasNodeId('shot', shot.id), 'cast', false, true));
    }
    if (shot.sceneId) {
      edges.push(edge(`cast:${shot.id}:${shot.sceneId}`, 'cast', canvasNodeId('entity', shot.sceneId), 'entity', canvasNodeId('shot', shot.id), 'cast', false, true));
    }
    edges.push(edge(`shot_takes:${shot.id}`, 'shot_takes', canvasNodeId('shot', shot.id), 'takes', canvasNodeId('takes', shot.id), 'takes', true));
    if (shot.renderDependencyMode === 'previous_take' && shot.dependsOnShotId) {
      edges.push(edge(`frame_chain:${shot.id}`, 'frame_chain', canvasNodeId('shot', shot.dependsOnShotId), 'tail_frame', canvasNodeId('shot', shot.id), 'first_frame', false));
    }

    nodes.push({
      id: canvasNodeId('takes', shot.id),
      kind: 'takes',
      domainId: shot.id,
      title: `${shot.title || shot.id} · Takes`,
      lane: 'takes',
      rowKey,
      ports: takesNodePorts(),
      badges: candidateCount > 0 ? [{ kind: 'warning', count: candidateCount }] : [],
      groupId: null,
      data: {
        shotId: shot.id,
        takes: takeRows.map((row) => ({
          id: row.id,
          status: row.status,
          posterPath: row.poster_path,
          rating: row.rating,
          failureTags: jget<string[]>(row.failure_tags_json, []),
          duration: row.duration,
          createdAt: row.created_at,
        })),
      } satisfies TakesNodeData,
    });
  }

  const orderedEntities = [...entities].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const entityRowKey = new Map(orderedEntities.map((entity, index) => [entity.id, index]));
  const statesByChar = new Map<string, typeof states>();
  for (const state of states) {
    const bucket = statesByChar.get(state.characterId) ?? [];
    bucket.push(state);
    statesByChar.set(state.characterId, bucket);
  }
  const shotIdSet = new Set(shotIds);
  const usageByEntity = new Map<string, string[]>();
  for (const shot of shots) {
    for (const id of [shot.primaryCharacterId, shot.sceneId]) {
      if (!id) continue;
      const bucket = usageByEntity.get(id) ?? [];
      bucket.push(shot.id);
      usageByEntity.set(id, bucket);
    }
  }
  for (const entity of orderedEntities) {
    nodes.push({
      id: canvasNodeId('entity', entity.id),
      kind: 'entity',
      domainId: entity.id,
      title: entity.name,
      lane: 'cast',
      rowKey: entityRowKey.get(entity.id) ?? 0,
      ports: entityNodePorts(),
      badges: [],
      groupId: null,
      data: {
        entityKind: entity.kind,
        imageAssetId: entity.imageAssetId,
        stateCount: (statesByChar.get(entity.id) ?? []).length,
        usageShotIds: (usageByEntity.get(entity.id) ?? []).filter((id) => shotIdSet.has(id)),
      } satisfies EntityNodeData,
    });
    for (const state of statesByChar.get(entity.id) ?? []) {
      nodes.push({
        id: canvasNodeId('character_state', state.id),
        kind: 'character_state',
        domainId: state.id,
        title: state.name,
        lane: 'cast',
        rowKey: entityRowKey.get(entity.id) ?? 0,
        ports: characterStateNodePorts(),
        badges: [],
        groupId: canvasNodeId('entity', entity.id),
        data: {
          characterId: state.characterId,
          effectiveImageAssetId: state.effectiveImageAssetId,
        } satisfies CharacterStateNodeData,
      });
    }
  }

  const storyboardPanelAssets = new Map<string, { storyboardId: string; panelId: string }>();
  for (const board of storyboards) {
    for (const panel of board.panels) {
      if (panel.assetId) storyboardPanelAssets.set(panel.assetId, { storyboardId: board.id, panelId: panel.id });
    }
    nodes.push({
      id: canvasNodeId('storyboard', board.id),
      kind: 'storyboard',
      domainId: board.id,
      title: `分镜页 ${board.pageNumber}/${board.totalPages}`,
      lane: 'storyboard',
      rowKey: board.pageNumber,
      ports: storyboardNodePorts(board.panels.map((panel) => panel.id)),
      badges: board.activeJob ? [{ kind: 'waiting' }] : [],
      groupId: null,
      data: {
        pageNumber: board.pageNumber,
        totalPages: board.totalPages,
        panelCount: board.panelCount,
        status: board.status,
        sourceStartIndex: board.sourceStartIndex,
        sourceEndIndex: board.sourceEndIndex,
        panels: board.panels.map((panel) => ({ id: panel.id, order: panel.order, description: panel.description, assetId: panel.assetId, version: panel.version })),
        activeJobId: board.activeJob?.id ?? null,
      } satisfies StoryboardNodeData,
    });
  }

  const includedMedia = new Set<string>();
  for (const row of bindingRows) {
    if (row.source_entity_id) continue;
    if (storyboardPanelAssets.has(row.asset_id)) continue;
    includedMedia.add(row.asset_id);
  }
  const userPlacedMedia = new Set<string>();
  for (const row of p.db.all<{ node_id: string; user_placed: number }>("SELECT node_id, user_placed FROM canvas_node_layouts WHERE story_id = ? AND user_placed = 1", [storyId])) {
    const kindPrefix = row.node_id.slice(0, row.node_id.indexOf(':'));
    if (kindPrefix !== 'media') continue;
    const mediaId = row.node_id.slice(row.node_id.indexOf(':') + 1);
    if (!mediaById.has(mediaId)) continue;
    includedMedia.add(mediaId);
    userPlacedMedia.add(mediaId);
  }
  for (const mediaId of includedMedia) {
    const media = mediaById.get(mediaId);
    if (!media) continue;
    nodes.push({
      id: canvasNodeId('media', media.id),
      kind: 'media',
      domainId: media.id,
      title: media.file_name.split('/').pop() ?? media.file_name,
      lane: 'free',
      rowKey: 0,
      ports: mediaNodePorts(media.kind as MediaKind),
      badges: [],
      groupId: null,
      data: {
        mediaKind: media.kind as MediaKind,
        posterPath: media.poster_path,
        durationSeconds: media.duration_seconds ?? undefined,
        userPlaced: userPlacedMedia.has(mediaId),
      } satisfies MediaNodeData,
    });
  }

  const breakdownRows = p.db.all<{
    asset_id: string;
    document_json: string;
    analysis_json: string | null;
    kind: string;
    label: string;
    poster_path: string | null;
    duration_seconds: number | null;
  }>(
    `SELECT rb.asset_id, rb.document_json, rb.analysis_json, m.kind, m.label, m.poster_path, m.duration_seconds
     FROM reference_breakdowns rb JOIN media_assets m ON m.id = rb.asset_id
     ORDER BY m.label, rb.asset_id`,
  );
  for (const row of breakdownRows) {
    const doc = jget<{ segments?: unknown[]; frames?: unknown[]; revision?: number }>(row.document_json, {});
    nodes.push({
      id: canvasNodeId('breakdown', row.asset_id),
      kind: 'breakdown',
      domainId: row.asset_id,
      title: row.label || row.asset_id,
      lane: 'reference',
      rowKey: 0,
      ports: [],
      badges: row.analysis_json ? [] : [{ kind: 'warning' }],
      groupId: null,
      data: {
        mediaId: row.asset_id,
        mediaKind: row.kind as MediaKind,
        posterPath: row.poster_path,
        durationSeconds: row.duration_seconds,
        segmentCount: Array.isArray(doc.segments) ? doc.segments.length : 0,
        frameCount: Array.isArray(doc.frames) ? doc.frames.length : 0,
        hasAnalysis: Boolean(row.analysis_json),
        revision: typeof doc.revision === 'number' ? doc.revision : 0,
      } satisfies BreakdownNodeData,
    });
  }

  for (const row of bindingRows) {
    const targetPort: CanvasPortId = rolesOf(row).includes('first_frame')
      ? 'first_frame'
      : rolesOf(row).includes('last_frame')
        ? 'last_frame'
        : row.type === 'video'
          ? 'video_ref'
          : row.type === 'audio'
            ? 'audio_ref'
            : 'refs';
    const focusOnly = targetPort === 'refs' || targetPort === 'video_ref' || targetPort === 'audio_ref';
    const panel = storyboardPanelAssets.get(row.asset_id);
    if (panel) {
      edges.push(
        edge(
          `storyboard_panel:${row.id}`,
          'storyboard_panel',
          canvasNodeId('storyboard', panel.storyboardId),
          `panel:${panel.panelId}`,
          canvasNodeId('shot', row.shot_id!),
          targetPort,
          true,
          focusOnly,
          { roles: rolesOf(row), bindingId: row.id },
        ),
      );
      continue;
    }
    const source = row.source_entity_id && entityById.has(row.source_entity_id)
      ? canvasNodeId('entity', row.source_entity_id)
      : canvasNodeId('media', row.asset_id);
    const sourcePort: CanvasPortId = row.source_entity_id ? 'entity' : (row.type as 'image' | 'video' | 'audio');
    edges.push(
      edge(`binding:${row.id}`, 'binding', source, sourcePort, canvasNodeId('shot', row.shot_id!), targetPort, false, focusOnly, {
        roles: rolesOf(row),
        bindingId: row.id,
      }),
    );
  }

  for (const clip of timeline.clips) {
    edges.push(
      edge(`take_clip:${clip.id}`, 'take_clip', canvasNodeId('takes', clip.shotId), 'selected', canvasNodeId('timeline', timeline.id), 'clips', false, false, {
        clipId: clip.id,
        order: clip.order,
      }),
    );
  }

  nodes.push({
    id: canvasNodeId('timeline', timeline.id),
    kind: 'timeline',
    domainId: timeline.id,
    title: timeline.title || 'Timeline',
    lane: 'edit',
    rowKey: 0,
    ports: timelineNodePorts(),
    badges: [],
    groupId: null,
    data: {
      clipCount: timeline.clips.length,
      durationSeconds: timeline.clips.reduce((sum, clip) => sum + Math.max(0, (clip.trimOut ?? clip.trimIn) - clip.trimIn), 0),
      clips: timeline.clips.map((clip) => ({ id: clip.id, order: clip.order, shotId: clip.shotId, takeId: clip.takeId })),
    } satisfies TimelineNodeData,
  });

  const latestExport = exports[0] ?? null;
  nodes.push({
    id: canvasNodeId('export', timeline.id),
    kind: 'export',
    domainId: timeline.id,
    title: '成片导出',
    lane: 'edit',
    rowKey: 1,
    ports: exportNodePorts(),
    badges: latestExport ? [] : [{ kind: 'warning' }],
    groupId: null,
    data: {
      latest: latestExport ? { relPath: latestExport.relPath, durationSeconds: latestExport.durationSeconds, createdAt: latestExport.createdAt } : null,
      exportCount: exports.length,
    } satisfies ExportNodeData,
  });

  edges.push(edge(`timeline_export:${timeline.id}`, 'timeline_export', canvasNodeId('timeline', timeline.id), 'timeline', canvasNodeId('export', timeline.id), 'timeline', true));

  for (let index = 0; index < orderedShots.length - 1; index++) {
    const from = orderedShots[index]!;
    const to = orderedShots[index + 1]!;
    if (!continuityShots.has(from.id)) continue;
    edges.push(edge(`continuity:${from.id}:${to.id}`, 'continuity', canvasNodeId('shot', from.id), 'tail_frame', canvasNodeId('shot', to.id), 'first_frame', true, true));
  }

  nodes.sort(compareNodes);
  edges.sort((a, b) => a.id.localeCompare(b.id));

  const revision = createHash('sha1').update(JSON.stringify({ nodes, edges })).digest('hex');
  return {
    projectId: p.meta.id,
    storyId,
    revision,
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
  };
}

function selectedTakeCount(rows: TakeRow[]): number {
  return rows.filter((row) => row.status === 'selected').length;
}

function rolesOf(row: BindingRow): ReferenceRole[] {
  return jget<ReferenceRole[]>(row.roles_json, []);
}

function bindingFromRow(row: BindingRow) {
  return {
    id: row.id,
    assetId: row.asset_id,
    type: row.type as 'image' | 'video' | 'audio',
    roles: rolesOf(row),
    preserve: [],
    ignore: [],
    label: row.label,
    shotId: row.shot_id,
    sourceEntityId: row.source_entity_id,
    createdAt: '',
  };
}

function shotUserStatus(status: Shot['status']) {
  return SHOT_USER_STATUS[status];
}

// ---------------------------------------------------------------------------
// Connection commands (spec §8 R1–R13, §10.4–§10.5). The dispatcher only calls
// existing domain-module functions; validation stays on the server.
// ---------------------------------------------------------------------------

export interface CanvasConnectDeps {
  capabilities?: (providerId: string, mode: H3Mode) => Promise<ProviderCapabilities | undefined>;
  providerId?: string;
}

const ACTIVE_JOB_SQL =
  "SELECT id FROM render_jobs WHERE shot_id = ? AND status IN ('LOCAL_QUEUED','UPLOADING','SUBMITTING','QUEUED','RUNNING','DOWNLOADING') ORDER BY created_at DESC LIMIT 1";

function assertNotLocked(p: ProjectContext, shotId: string): void {
  const shot = shotsMod.getShot(p, shotId);
  if (shot.status === 'LOCKED') throw new CanvasError('locked', '镜头已锁定，无法修改生成意图');
  if (p.db.get(ACTIVE_JOB_SQL, [shotId])) throw new CanvasError('locked', '镜头有进行中的渲染任务');
}

function needReplace(edgeId: string, label: string): never {
  throw new CanvasError('needs_replace', '该目标已有连接，确认后可替换', { existing: { edgeId, label } });
}

function requireReplace(replace: boolean | undefined, edgeId: string, label: string): void {
  if (!replace) needReplace(edgeId, label);
}

function bindingKind(node: CanvasNode): MediaKind {
  if (node.kind === 'media') return node.data.mediaKind;
  return 'image';
}

function bindingAssetId(node: CanvasNode): string {
  if (node.kind === 'entity') return node.data.imageAssetId ?? '';
  if (node.kind === 'character_state') return node.data.effectiveImageAssetId ?? '';
  return node.domainId;
}

function rolesForRule(ruleId: string, requested: ReferenceRole[] | undefined): ReferenceRole[] {
  if (requested && requested.length > 0) return requested;
  switch (ruleId) {
    case 'R5':
      return ['identity', 'costume'];
    case 'R10':
      return ['motion'];
    case 'R11':
      return ['audio'];
    case 'R6':
      return ['first_frame'];
    case 'R8':
      return ['first_frame'];
    case 'R9':
      return ['last_frame'];
    default:
      return ['style'];
  }
}

function suggestedModeForPort(port: CanvasPortId): H3Mode | null {
  if (port === 'refs') return 'ref2va';
  if (port === 'video_ref') return 'vref2va';
  return null;
}

export async function connectCanvas(
  p: ProjectContext,
  request: CanvasConnectRequest,
  deps: CanvasConnectDeps = {},
): Promise<CanvasConnectResult> {
  const storyId = resolveActiveStory(p, request.storyId);
  const graph = buildCanvasGraph(p);
  const source = graph.nodes.find((node) => node.id === request.source.nodeId);
  const target = graph.nodes.find((node) => node.id === request.target.nodeId);
  if (!source || !target) throw new CanvasError('not_found', '连接端点不存在');

  const sourcePort = source.ports.find((port) => port.id === request.source.port);
  const targetPort = target.ports.find((port) => port.id === request.target.port);
  if (!sourcePort || !sourcePort.visible) throw new CanvasError('invalid_connection', '源端口当前不可用');
  if (!targetPort || !targetPort.visible) throw new CanvasError('invalid_connection', '目标端口当前不可用');

  const verdict = canConnect(source, request.source.port, target, request.target.port);
  if (!verdict.ok) throw new CanvasError('invalid_connection', verdict.reason);
  const rule = verdict.rule;
  const options = request.options ?? {};
  const affected = [source.id, target.id];

  switch (rule.effect) {
    case 'set_shot_beat': {
      const shotId = target.domainId;
      assertNotLocked(p, shotId);
      const shot = shotsMod.getShot(p, shotId);
      const previous = shot.storyBeatId;
      if (previous === source.domainId) {
        return { ok: true, edgeId: `beat_shot:${shotId}`, affectedNodeIds: affected, undo: { method: 'DELETE', edgeId: `beat_shot:${shotId}` } };
      }
      if (previous) requireReplace(options.replace, `beat_shot:${shotId}`, '已有归属节拍');
      shotsMod.updateShot(p, shotId, { storyBeatId: source.domainId });
      return {
        ok: true,
        edgeId: `beat_shot:${shotId}`,
        affectedNodeIds: affected,
        undo: previous
          ? { method: 'POST', request: { storyId, source: { nodeId: canvasNodeId('beat', previous), port: 'beat' }, target: { nodeId: canvasNodeId('shot', shotId), port: 'beat' }, options: { replace: true } } }
          : { method: 'DELETE', edgeId: `beat_shot:${shotId}` },
      };
    }

    case 'set_shot_primary_character':
    case 'set_shot_scene': {
      const shotId = target.domainId;
      assertNotLocked(p, shotId);
      const shot = shotsMod.getShot(p, shotId);
      const isScene = rule.effect === 'set_shot_scene';
      const current = isScene ? shot.sceneId : shot.primaryCharacterId;
      const edgeId = `cast:${shotId}:${source.domainId}`;
      if (current === source.domainId) {
        return { ok: true, edgeId, affectedNodeIds: affected, undo: { method: 'DELETE', edgeId } };
      }
      if (current) requireReplace(options.replace, `cast:${shotId}:${current}`, isScene ? '已有场景' : '已有主角色');
      p.db.tx(() => {
        shotsMod.updateShot(p, shotId, isScene ? { sceneId: source.domainId } : { primaryCharacterId: source.domainId });
        assetsMod.ensureShotEntityImageBindings(p, shotsMod.getShot(p, shotId));
      });
      return {
        ok: true,
        edgeId,
        affectedNodeIds: affected,
        undo: current
          ? { method: 'POST', request: { storyId, source: { nodeId: canvasNodeId('entity', current), port: 'entity' }, target: { nodeId: canvasNodeId('shot', shotId), port: 'cast' }, options: { replace: true } } }
          : { method: 'DELETE', edgeId },
      };
    }

    case 'create_binding':
    case 'create_first_frame_binding':
    case 'create_last_frame_binding': {
      const shotId = target.domainId;
      assertNotLocked(p, shotId);
      const shot = shotsMod.getShot(p, shotId);
      const assetId = bindingAssetId(source);
      if (!assetId) throw new CanvasError('invalid_connection', '源素材没有可绑定的图片');
      const kind = bindingKind(source);
      const roles = rolesForRule(rule.id, options.roles);
      const singleRole = rule.effect === 'create_first_frame_binding' ? 'first_frame' : rule.effect === 'create_last_frame_binding' ? 'last_frame' : null;

      let replaceBindingId: string | null = null;
      let replacedBinding: import('@h3mise/shared').ReferenceBinding | null = null;
      if (singleRole) {
        const existing = assetsMod.listBindings(p, shotId).find((binding) => binding.roles.includes(singleRole));
        if (existing) {
          requireReplace(options.replace, `binding:${existing.id}`, singleRole === 'first_frame' ? '已有首帧绑定' : '已有尾帧绑定');
          replaceBindingId = existing.id;
          replacedBinding = existing;
        }
      }

      let mode = options.switchMode ?? shot.h3Mode;
      const suggested = suggestedModeForPort(request.target.port);
      if (suggested && mode !== suggested && !options.switchMode) {
        const accepts = request.target.port === 'refs' ? mode === 'ref2va' || mode === 'vref2va' : mode === suggested;
        if (!accepts) throw new CanvasError('needs_mode_switch', '当前模式不接受该参考端口', { suggestedMode: suggested });
      }
      mode = mode ?? 't2va';

      const providerId = deps.providerId ?? p.config.default_provider;
      const caps = deps.capabilities ? await deps.capabilities(providerId, mode) : undefined;
      const prospective = [...assetsMod.listBindings(p, shotId).map((binding) => ({ kind: binding.type })), { kind }];
      const violations = referenceCountViolations(mode, prospective, caps ?? null);
      if (violations.length > 0) throw new CanvasError('reference_limit', violations[0]!.message);

      let bindingId = '';
      p.db.tx(() => {
        if (options.switchMode) shotsMod.updateShot(p, shotId, { h3Mode: options.switchMode });
        if (replaceBindingId) assetsMod.deleteBinding(p, replaceBindingId);
        const created = assetsMod.createBinding(p, {
          assetId,
          roles,
          shotId,
          preserve: options.preserve,
          ignore: options.ignore,
          sourceEntityId: source.kind === 'entity' ? source.domainId : null,
        });
        bindingId = created.id;
      });
      const prior = replacedBinding;
      return {
        ok: true,
        edgeId: `binding:${bindingId}`,
        affectedNodeIds: affected,
        undo: prior
          ? {
              method: 'POST',
              request: {
                storyId,
                source: prior.sourceEntityId
                  ? { nodeId: canvasNodeId('entity', prior.sourceEntityId), port: 'entity' }
                  : { nodeId: canvasNodeId('media', prior.assetId), port: prior.type },
                target: { nodeId: canvasNodeId('shot', shotId), port: request.target.port },
                options: { roles: prior.roles, replace: true },
              },
            }
          : { method: 'DELETE', edgeId: `binding:${bindingId}` },
      };
    }

    case 'set_frame_chain': {
      const targetShotId = target.domainId;
      const sourceShotId = source.domainId;
      if (targetShotId === sourceShotId) throw new CanvasError('invalid_connection', '镜头不能连接自己');
      assertNotLocked(p, targetShotId);
      const shot = shotsMod.getShot(p, targetShotId);
      const frameBindings = assetsMod.listBindings(p, targetShotId).filter((binding) => binding.roles.includes('first_frame'));
      const alreadyChained = shot.renderDependencyMode === 'previous_take' && shot.dependsOnShotId === sourceShotId;
      if (alreadyChained && frameBindings.length === 0) {
        return { ok: true, edgeId: `frame_chain:${targetShotId}`, affectedNodeIds: affected, undo: { method: 'DELETE', edgeId: `frame_chain:${targetShotId}` } };
      }
      if (frameBindings.length > 0 || (shot.renderDependencyMode !== 'auto' && shot.dependsOnShotId)) {
        requireReplace(options.replace, `frame_chain:${targetShotId}`, '目标已有首帧或依赖设置');
      }
      const priorChain = shot.renderDependencyMode === 'previous_take' && shot.dependsOnShotId && shot.dependsOnShotId !== sourceShotId ? shot.dependsOnShotId : null;
      try {
        p.db.tx(() => {
          if (options.replace) for (const binding of frameBindings) assetsMod.deleteBinding(p, binding.id);
          shotsMod.updateShot(p, targetShotId, { renderDependencyMode: 'previous_take', dependsOnShotId: sourceShotId });
        });
      } catch (error) {
        if (error instanceof Error && /cycle/i.test(error.message)) throw new CanvasError('cycle', '帧链不能成环');
        throw error;
      }
      return {
        ok: true,
        edgeId: `frame_chain:${targetShotId}`,
        affectedNodeIds: affected,
        undo: priorChain
          ? { method: 'POST', request: { storyId, source: { nodeId: canvasNodeId('shot', priorChain), port: 'tail_frame' }, target: { nodeId: canvasNodeId('shot', targetShotId), port: 'first_frame' } } }
          : { method: 'DELETE', edgeId: `frame_chain:${targetShotId}` },
      };
    }

    case 'add_timeline_clip': {
      if (source.kind !== 'takes' || target.kind !== 'timeline') throw new CanvasError('invalid_connection', '片段只能从 Takes 连到时间线');
      const selected = source.data.takes.find((take) => take.status === 'selected');
      if (!selected) throw new CanvasError('invalid_connection', '尚未选片');
      const clip = timelineMod.addClip(p, { shotId: source.data.shotId, takeId: selected.id });
      return { ok: true, edgeId: `take_clip:${clip.id}`, affectedNodeIds: affected, undo: { method: 'DELETE', edgeId: `take_clip:${clip.id}` } };
    }
  }
}

export function disconnectCanvas(p: ProjectContext, edgeId: string, requestedStoryId?: string): { ok: true; affectedNodeIds: CanvasNodeId[]; undo: CanvasConnectResult['undo'] } {
  const storyId = resolveActiveStory(p, requestedStoryId);
  const separator = edgeId.indexOf(':');
  const prefix = separator < 0 ? edgeId : edgeId.slice(0, separator);
  const rest = separator < 0 ? '' : edgeId.slice(separator + 1);

  if (prefix === 'beat_shot') {
    assertNotLocked(p, rest);
    const beatId = shotsMod.getShot(p, rest).storyBeatId;
    shotsMod.updateShot(p, rest, { storyBeatId: null });
    return {
      ok: true,
      affectedNodeIds: [canvasNodeId('shot', rest)],
      undo: beatId
        ? { method: 'POST', request: { storyId, source: { nodeId: canvasNodeId('beat', beatId), port: 'beat' }, target: { nodeId: canvasNodeId('shot', rest), port: 'beat' } } }
        : null,
    };
  }
  if (prefix === 'cast') {
    const [shotId, entityId] = rest.split(':');
    if (!shotId || !entityId) throw new CanvasError('invalid_connection', '连线 id 无效');
    assertNotLocked(p, shotId);
    const shot = shotsMod.getShot(p, shotId);
    p.db.tx(() => {
      shotsMod.updateShot(p, shotId, shot.sceneId === entityId ? { sceneId: null } : { primaryCharacterId: null });
      assetsMod.ensureShotEntityImageBindings(p, shotsMod.getShot(p, shotId));
    });
    return {
      ok: true,
      affectedNodeIds: [canvasNodeId('shot', shotId)],
      undo: { method: 'POST', request: { storyId, source: { nodeId: canvasNodeId('entity', entityId), port: 'entity' }, target: { nodeId: canvasNodeId('shot', shotId), port: 'cast' }, options: { replace: true } } },
    };
  }
  if (prefix === 'binding') {
    const binding = assetsMod.listBindings(p).find((item) => item.id === rest);
    if (!binding) throw new CanvasError('not_found', '绑定不存在');
    if (binding.shotId) assertNotLocked(p, binding.shotId);
    const targetPort: CanvasPortId = binding.roles.includes('first_frame')
      ? 'first_frame'
      : binding.roles.includes('last_frame')
        ? 'last_frame'
        : binding.type === 'video'
          ? 'video_ref'
          : binding.type === 'audio'
            ? 'audio_ref'
            : 'refs';
    assetsMod.deleteBinding(p, rest);
    return {
      ok: true,
      affectedNodeIds: binding.shotId ? [canvasNodeId('shot', binding.shotId)] : [],
      undo: binding.shotId
        ? {
            method: 'POST',
            request: {
              storyId,
              source: binding.sourceEntityId
                ? { nodeId: canvasNodeId('entity', binding.sourceEntityId), port: 'entity' }
                : { nodeId: canvasNodeId('media', binding.assetId), port: binding.type },
              target: { nodeId: canvasNodeId('shot', binding.shotId), port: targetPort },
              options: { roles: binding.roles, replace: true },
            },
          }
        : null,
    };
  }
  if (prefix === 'frame_chain') {
    assertNotLocked(p, rest);
    const sourceShotId = shotsMod.getShot(p, rest).dependsOnShotId;
    shotsMod.updateShot(p, rest, { renderDependencyMode: 'auto', dependsOnShotId: null });
    return {
      ok: true,
      affectedNodeIds: [canvasNodeId('shot', rest)],
      undo: sourceShotId
        ? { method: 'POST', request: { storyId, source: { nodeId: canvasNodeId('shot', sourceShotId), port: 'tail_frame' }, target: { nodeId: canvasNodeId('shot', rest), port: 'first_frame' } } }
        : null,
    };
  }
  if (prefix === 'take_clip') {
    const clip = p.db.get<{ shot_id: string; take_id: string }>('SELECT shot_id, take_id FROM timeline_clips WHERE id = ?', [rest]);
    const timeline = p.db.get<{ id: string }>('SELECT id FROM timeline LIMIT 1');
    timelineMod.removeClip(p, rest);
    return {
      ok: true,
      affectedNodeIds: [],
      undo: clip && timeline
        ? { method: 'POST', request: { storyId, source: { nodeId: canvasNodeId('takes', clip.shot_id), port: 'selected' }, target: { nodeId: canvasNodeId('timeline', timeline.id), port: 'clips' } } }
        : null,
    };
  }
  throw new CanvasError('invalid_connection', '派生连线不可断开');
}
