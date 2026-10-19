// Studio Canvas deterministic lane layout (docs/studio-canvas/02-prd-tech.md §12).
// Pure function, shared so it can be unit-tested in server/test with node:test
// (the web package has no test runner and we do not add one).
// ---------------------------------------------------------------------------

import type { CanvasLane, CanvasNode, CanvasNodeId, ShotNodeData } from './canvas.js';
import { canvasNodeId } from './canvas.js';

export interface LaneLayoutOptions {
  laneOrder: CanvasLane[];
  laneWidth: Record<CanvasLane, number>;
  laneGap: number;
  rowGap: number;
  nodeSize: (node: CanvasNode) => { width: number; height: number };
  hiddenLanes?: CanvasLane[];
}

export interface CanvasPoint {
  x: number;
  y: number;
}

export const DEFAULT_LANE_ORDER: CanvasLane[] = [
  'cast',
  'media',
  'reference',
  'story',
  'beats',
  'storyboard',
  'shots',
  'takes',
  'edit',
  'free',
];

export const DEFAULT_LANE_WIDTH: Record<CanvasLane, number> = {
  cast: 240,
  media: 220,
  reference: 240,
  story: 260,
  beats: 300,
  storyboard: 300,
  shots: 340,
  takes: 240,
  edit: 320,
  free: 0,
};

export function defaultLaneLayoutOptions(
  nodeSize: (node: CanvasNode) => { width: number; height: number },
): LaneLayoutOptions {
  return {
    laneOrder: [...DEFAULT_LANE_ORDER],
    laneWidth: { ...DEFAULT_LANE_WIDTH },
    laneGap: 80,
    rowGap: 32,
    nodeSize,
  };
}

interface Row {
  beat: CanvasNode | null;
  shots: CanvasNode[];
  storyboards: CanvasNode[];
}

function compareNodes(a: CanvasNode, b: CanvasNode): number {
  return a.rowKey - b.rowKey || a.id.localeCompare(b.id);
}

function stackHeight(
  nodes: CanvasNode[],
  rowGap: number,
  nodeSize: LaneLayoutOptions['nodeSize'],
): number {
  if (nodes.length === 0) return 0;
  let height = 0;
  for (let i = 0; i < nodes.length; i++) {
    height += nodeSize(nodes[i]!).height;
    if (i < nodes.length - 1) height += rowGap;
  }
  return height;
}

/**
 * Positions every node that is NOT pinned and NOT in a hidden lane. Pinned
 * positions are returned untouched by the caller, so they are skipped here.
 * The result is deterministic: identical input yields identical positions.
 */
export function laneLayout(
  nodes: CanvasNode[],
  pinned: Map<CanvasNodeId, CanvasPoint>,
  opts: LaneLayoutOptions,
): Map<CanvasNodeId, CanvasPoint> {
  const hidden = new Set(opts.hiddenLanes ?? []);
  const visibleOrder = opts.laneOrder.filter((lane) => !hidden.has(lane));

  const laneX = new Map<CanvasLane, number>();
  let cursorX = 0;
  for (const lane of visibleOrder) {
    laneX.set(lane, cursorX);
    cursorX += (opts.laneWidth[lane] ?? 0) + opts.laneGap;
  }

  const result = new Map<CanvasNodeId, CanvasPoint>();
  const active = nodes.filter((node) => !pinned.has(node.id) && !hidden.has(node.lane));
  const place = (node: CanvasNode, y: number, xOffset = 0): void => {
    result.set(node.id, { x: (laneX.get(node.lane) ?? 0) + xOffset, y });
  };

  const beats = active.filter((node) => node.kind === 'beat').sort(compareNodes);
  const rows: Row[] = beats.map((beat) => ({ beat, shots: [], storyboards: [] }));
  const rowByBeatNodeId = new Map<CanvasNodeId, number>();
  beats.forEach((beat, index) => rowByBeatNodeId.set(beat.id, index));

  const unassignedShots: CanvasNode[] = [];
  for (const shot of active.filter((node) => node.kind === 'shot')) {
    const beatId = (shot.data as ShotNodeData).storyBeatId;
    const rowIndex = beatId ? rowByBeatNodeId.get(canvasNodeId('beat', beatId)) : undefined;
    if (rowIndex === undefined) unassignedShots.push(shot);
    else rows[rowIndex]!.shots.push(shot);
  }
  for (const row of rows) row.shots.sort(compareNodes);
  unassignedShots.sort(compareNodes);

  const storyboards = active
    .filter((node) => node.kind === 'storyboard')
    .sort((a, b) => {
      const an = a.kind === 'storyboard' ? a.data.pageNumber : 0;
      const bn = b.kind === 'storyboard' ? b.data.pageNumber : 0;
      return an - bn || a.id.localeCompare(b.id);
    });
  if (rows.length > 0) {
    storyboards.forEach((board, index) => {
      rows[Math.min(index, rows.length - 1)]!.storyboards.push(board);
    });
  }

  const rowHeights = rows.map((row) => {
    const shotHeight = stackHeight(row.shots, opts.rowGap, opts.nodeSize);
    const boardHeight = stackHeight(row.storyboards, opts.rowGap, opts.nodeSize);
    return Math.max(
      row.beat ? opts.nodeSize(row.beat).height : 0,
      shotHeight,
      boardHeight,
    );
  });

  const shotY = new Map<CanvasNodeId, number>();
  let cursorY = 0;
  rows.forEach((row, index) => {
    if (row.beat) place(row.beat, cursorY);
    let sy = cursorY;
    for (const shot of row.shots) {
      place(shot, sy);
      shotY.set(shot.id, sy);
      sy += opts.nodeSize(shot).height + opts.rowGap;
    }
    let by = cursorY;
    for (const board of row.storyboards) {
      place(board, by);
      by += opts.nodeSize(board).height + opts.rowGap;
    }
    cursorY += rowHeights[index]! + opts.rowGap;
  });

  for (const shot of unassignedShots) {
    place(shot, cursorY);
    shotY.set(shot.id, cursorY);
    cursorY += opts.nodeSize(shot).height + opts.rowGap;
  }
  if (rows.length === 0) {
    for (const board of storyboards) {
      place(board, cursorY);
      cursorY += opts.nodeSize(board).height + opts.rowGap;
    }
  }

  for (const takes of active.filter((node) => node.kind === 'takes')) {
    const shotId = takes.kind === 'takes' ? takes.data.shotId : '';
    const sourceId = canvasNodeId('shot', shotId);
    const y = shotY.get(sourceId) ?? pinned.get(sourceId)?.y;
    if (y !== undefined) place(takes, y);
  }

  // Cast lane: entities sorted by kind then title, each entity followed by its
  // character-state children. Callers exclude collapsed children beforehand.
  const entities = active
    .filter((node) => node.kind === 'entity')
    .sort((a, b) => {
      const ak = a.kind === 'entity' ? a.data.entityKind : '';
      const bk = b.kind === 'entity' ? b.data.entityKind : '';
      return ak.localeCompare(bk) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
    });
  const states = active.filter((node) => node.kind === 'character_state');
  let castY = 0;
  for (const entity of entities) {
    place(entity, castY);
    castY += opts.nodeSize(entity).height + opts.rowGap;
    const children = states
      .filter((state) => state.groupId === entity.id)
      .sort(compareNodes);
    for (const child of children) {
      place(child, castY, 20);
      castY += opts.nodeSize(child).height + opts.rowGap;
    }
  }
  for (const orphan of states.filter((state) => !state.groupId)) {
    place(orphan, castY);
    castY += opts.nodeSize(orphan).height + opts.rowGap;
  }

  // Media references: stacked separately from entities so unpinned media
  // can never collide with the cast lane.
  let mediaY = 0;
  for (const media of active.filter((node) => node.kind === 'media').sort(compareNodes)) {
    place(media, mediaY);
    mediaY += opts.nodeSize(media).height + opts.rowGap;
  }

  // Reference breakdowns: one stacked card per analyzed media asset.
  let referenceY = 0;
  for (const reference of active.filter((node) => node.kind === 'breakdown').sort(compareNodes)) {
    place(reference, referenceY);
    referenceY += opts.nodeSize(reference).height + opts.rowGap;
  }

  for (const story of active.filter((node) => node.kind === 'story')) place(story, 0);

  const timeline = active.find((node) => node.kind === 'timeline');
  if (timeline) {
    place(timeline, 0);
    const exports = active.filter((node) => node.kind === 'export').sort(compareNodes);
    let exportY = opts.nodeSize(timeline).height + opts.rowGap;
    for (const node of exports) {
      place(node, exportY);
      exportY += opts.nodeSize(node).height + opts.rowGap;
    }
  } else {
    const exports = active.filter((node) => node.kind === 'export').sort(compareNodes);
    let exportY = 0;
    for (const node of exports) {
      place(node, exportY);
      exportY += opts.nodeSize(node).height + opts.rowGap;
    }
  }

  for (const sequence of active.filter((node) => node.kind === 'sequence').sort(compareNodes)) {
    place(sequence, 0);
  }

  return result;
}
