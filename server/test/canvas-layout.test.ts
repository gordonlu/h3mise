// Studio Canvas deterministic lane layout (spec §12).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  BeatNodeData,
  BreakdownNodeData,
  CanvasNode,
  CanvasNodeId,
  ShotNodeData,
  TakesNodeData,
} from '@h3mise/shared';
import {
  DEFAULT_LANE_WIDTH,
  canvasNodeId,
  defaultLaneLayoutOptions,
  laneLayout,
  shotNodePorts,
} from '@h3mise/shared';

const SIZES: Record<string, number> = { beat: 100, shot: 150, takes: 80, timeline: 120, export: 100 };

function nodeSize(node: CanvasNode): { width: number; height: number } {
  return { width: 200, height: SIZES[node.kind] ?? 100 };
}

function shot(id: string, storyBeatId: string | null): CanvasNode {
  const data: ShotNodeData = {
    order: 1,
    status: 'DRAFT',
    userStatus: 'draft',
    h3Mode: 't2va',
    durationSeconds: 5,
    aspectRatio: '16:9',
    storyBeatId,
    primaryCharacterId: null,
    sceneId: null,
    renderDependencyMode: 'auto',
    dependsOnShotId: null,
    dependencyReady: true,
    castChips: [],
    missingRequired: [],
    coverPath: null,
    previewTakeId: null,
    hasPlan: false,
    latestPromptVersionId: null,
    latestPreflight: null,
    activeJob: null,
    takeCount: 0,
    candidateCount: 0,
    selectedTakeId: null,
    guideSteps: [],
    pendingAiRequestIds: [],
  };
  return { id: canvasNodeId('shot', id), kind: 'shot', domainId: id, title: id, lane: 'shots', rowKey: 1, ports: shotNodePorts('t2va'), badges: [], groupId: null, data };
}

function beat(id: string, order: number): CanvasNode {
  const data: BeatNodeData = { order, category: 'action', summary: '', durationSeconds: 4, shotIds: [] };
  return { id: canvasNodeId('beat', id), kind: 'beat', domainId: id, title: id, lane: 'beats', rowKey: order, ports: [], badges: [], groupId: null, data };
}

function takes(id: string): CanvasNode {
  const data: TakesNodeData = { shotId: id, takes: [] };
  return { id: canvasNodeId('takes', id), kind: 'takes', domainId: id, title: id, lane: 'takes', rowKey: 0, ports: [], badges: [], groupId: null, data };
}

function breakdown(id: string): CanvasNode {
  const data: BreakdownNodeData = { mediaId: id, mediaKind: 'video', posterPath: null, durationSeconds: 10, segmentCount: 1, frameCount: 1, hasAnalysis: false, revision: 1 };
  return { id: canvasNodeId('breakdown', id), kind: 'breakdown', domainId: id, title: id, lane: 'reference', rowKey: 0, ports: [], badges: [], groupId: null, data };
}

function media(id: string): CanvasNode {
  return {
    id: canvasNodeId('media', id),
    kind: 'media',
    domainId: id,
    title: id,
    lane: 'media',
    rowKey: 0,
    ports: [],
    badges: [],
    groupId: null,
    data: { mediaKind: 'image', posterPath: null, userPlaced: false },
  };
}

function ids(map: Map<CanvasNodeId, { x: number; y: number }>): Record<string, { x: number; y: number }> {
  return Object.fromEntries([...map.entries()].map(([key, value]) => [key, { x: value.x, y: value.y }]));
}

const opts = () => defaultLaneLayoutOptions(nodeSize);

test('layout is deterministic for the same input', () => {
  const nodes = [beat('b1', 1), shot('s1', 'b1'), shot('s2', 'b1'), beat('b2', 2), shot('s3', 'b2')];
  const a = laneLayout(nodes, new Map(), opts());
  const b = laneLayout(nodes, new Map(), opts());
  assert.deepEqual(ids(a), ids(b));
});

test('pinned nodes are not returned', () => {
  const nodes = [beat('b1', 1), shot('s1', 'b1'), shot('s2', 'b1')];
  const pinned = new Map([[canvasNodeId('shot', 's1'), { x: 999, y: 999 }]]);
  const result = laneLayout(nodes, pinned, opts());
  assert.equal(result.has(canvasNodeId('shot', 's1')), false);
  assert.equal(result.has(canvasNodeId('shot', 's2')), true);
});

test('hiding a lane tightens the x coordinates of later lanes', () => {
  const nodes = [shot('s1', null)];
  const visible = laneLayout(nodes, new Map(), opts());
  const hidden = laneLayout(nodes, new Map(), { ...opts(), hiddenLanes: ['cast'] });
  const expectedShift = DEFAULT_LANE_WIDTH.cast + opts().laneGap;
  assert.equal(visible.get(canvasNodeId('shot', 's1'))!.x - hidden.get(canvasNodeId('shot', 's1'))!.x, expectedShift);
});

test('media references stack in their own lane', () => {
  const result = laneLayout([media('m1'), media('m2')], new Map(), opts());
  const x = DEFAULT_LANE_WIDTH.cast + opts().laneGap;
  assert.equal(result.get(canvasNodeId('media', 'm1'))!.x, x);
  assert.equal(result.get(canvasNodeId('media', 'm2'))!.x, x);
  assert.equal(result.get(canvasNodeId('media', 'm2'))!.y, 100 + opts().rowGap);
});

test('reference breakdowns stack in the reference lane', () => {
  const result = laneLayout([breakdown('r1'), breakdown('r2')], new Map(), opts());
  const x = DEFAULT_LANE_WIDTH.cast + opts().laneGap + DEFAULT_LANE_WIDTH.media + opts().laneGap;
  assert.equal(result.get(canvasNodeId('breakdown', 'r1'))!.x, x);
  assert.equal(result.get(canvasNodeId('breakdown', 'r2'))!.x, x);
  assert.equal(result.get(canvasNodeId('breakdown', 'r2'))!.y, 100 + opts().rowGap);
});

test('two shots under one beat increase the row height used by the next beat', () => {
  const one = laneLayout([beat('b1', 1), shot('s1', 'b1'), beat('b2', 2)], new Map(), opts());
  const two = laneLayout([beat('b1', 1), shot('s1', 'b1'), shot('s2', 'b1'), beat('b2', 2)], new Map(), opts());
  const gap = opts().rowGap;
  assert.equal(one.get(canvasNodeId('beat', 'b2'))!.y, 150 + gap);
  assert.equal(two.get(canvasNodeId('beat', 'b2'))!.y, 150 + gap + 150 + gap);
});

test('unassigned shots are placed after beat rows', () => {
  const result = laneLayout([beat('b1', 1), shot('s1', 'b1'), shot('s9', null)], new Map(), opts());
  assert.ok(result.get(canvasNodeId('shot', 's9'))!.y > result.get(canvasNodeId('shot', 's1'))!.y);
});

test('takes align with their shot', () => {
  const result = laneLayout([beat('b1', 1), shot('s1', 'b1'), takes('s1')], new Map(), opts());
  assert.equal(result.get(canvasNodeId('takes', 's1'))!.y, result.get(canvasNodeId('shot', 's1'))!.y);
});
