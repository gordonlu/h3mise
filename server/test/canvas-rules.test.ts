// Studio Canvas connection rules (spec §8 R1–R13) + shot port visibility.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  BeatNodeData,
  CanvasNode,
  CharacterStateNodeData,
  EntityNodeData,
  MediaNodeData,
  ShotNodeData,
  TakesNodeData,
  TimelineNodeData,
} from '@h3mise/shared';
import {
  CANVAS_CONNECTION_RULES,
  canConnect,
  canvasNodeId,
  shotNodePorts,
} from '@h3mise/shared';
import type { EntityKind, H3Mode, MediaKind, TakeStatus } from '@h3mise/shared';

function shotData(overrides: Partial<ShotNodeData> = {}): ShotNodeData {
  return {
    order: 1,
    status: 'DRAFT',
    userStatus: 'draft',
    h3Mode: 't2va',
    durationSeconds: 5,
    aspectRatio: '16:9',
    storyBeatId: null,
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
    ...overrides,
  };
}

function shot(id: string, overrides: Partial<ShotNodeData> = {}): CanvasNode {
  return {
    id: canvasNodeId('shot', id),
    kind: 'shot',
    domainId: id,
    title: id,
    lane: 'shots',
    rowKey: 0,
    ports: shotNodePorts(overrides.h3Mode ?? 't2va'),
    badges: [],
    groupId: null,
    data: shotData(overrides),
  };
}

function beat(id: string): CanvasNode {
  const data: BeatNodeData = { order: 1, category: 'action', summary: '', durationSeconds: 4, shotIds: [] };
  return { id: canvasNodeId('beat', id), kind: 'beat', domainId: id, title: id, lane: 'beats', rowKey: 0, ports: [], badges: [], groupId: null, data };
}

function entity(id: string, kind: EntityKind, imageAssetId: string | null): CanvasNode {
  const data: EntityNodeData = { entityKind: kind, imageAssetId, stateCount: 0, usageShotIds: [] };
  return { id: canvasNodeId('entity', id), kind: 'entity', domainId: id, title: id, lane: 'cast', rowKey: 0, ports: [], badges: [], groupId: null, data };
}

function characterState(id: string, characterId: string, image: string | null): CanvasNode {
  const data: CharacterStateNodeData = { characterId, effectiveImageAssetId: image };
  return { id: canvasNodeId('character_state', id), kind: 'character_state', domainId: id, title: id, lane: 'cast', rowKey: 0, ports: [], badges: [], groupId: canvasNodeId('entity', characterId), data };
}

function media(id: string, kind: MediaKind): CanvasNode {
  const data: MediaNodeData = { mediaKind: kind, posterPath: null, userPlaced: false };
  return { id: canvasNodeId('media', id), kind: 'media', domainId: id, title: id, lane: 'free', rowKey: 0, ports: [], badges: [], groupId: null, data };
}

function takes(id: string, statuses: TakeStatus[]): CanvasNode {
  const data: TakesNodeData = {
    shotId: id,
    takes: statuses.map((status, index) => ({ id: `take-${index}`, status, posterPath: null, rating: null, failureTags: [], duration: 3, createdAt: '2026-01-01T00:00:00Z' })),
  };
  return { id: canvasNodeId('takes', id), kind: 'takes', domainId: id, title: id, lane: 'takes', rowKey: 0, ports: [], badges: [], groupId: null, data };
}

function timeline(id: string): CanvasNode {
  const data: TimelineNodeData = { clipCount: 0, durationSeconds: 0, clips: [] };
  return { id: canvasNodeId('timeline', id), kind: 'timeline', domainId: id, title: id, lane: 'edit', rowKey: 0, ports: [], badges: [], groupId: null, data };
}

function ok(source: CanvasNode, sourcePort: Parameters<typeof canConnect>[1], target: CanvasNode, targetPort: Parameters<typeof canConnect>[3]): void {
  const result = canConnect(source, sourcePort, target, targetPort);
  assert.equal(result.ok, true, `expected ok: ${!result.ok ? result.reason : ''}`);
}

function rejected(source: CanvasNode, sourcePort: Parameters<typeof canConnect>[1], target: CanvasNode, targetPort: Parameters<typeof canConnect>[3], needle?: string): void {
  const result = canConnect(source, sourcePort, target, targetPort);
  assert.equal(result.ok, false, 'expected rejection');
  if (needle && !result.ok) assert.match(result.reason, new RegExp(needle));
}

test('R1 beat → shot.beat sets the beat', () => {
  ok(beat('beat-1'), 'beat', shot('shot-1'), 'beat');
  rejected(beat('beat-1'), 'beat', timeline('tl-1'), 'clips');
});

test('R2/R3 entity → shot.cast depends on entity kind', () => {
  ok(entity('ben', 'character', null), 'entity', shot('s1'), 'cast');
  ok(entity('ben', 'creature', null), 'entity', shot('s1'), 'cast');
  ok(entity('street', 'scene', null), 'entity', shot('s1'), 'cast');
  rejected(entity('hammer', 'prop', null), 'entity', shot('s1'), 'cast');
});

test('R4 entity → shot.refs needs prop/vehicle with a main image', () => {
  ok(entity('hammer', 'prop', 'asset-1'), 'entity', shot('s1'), 'refs');
  ok(entity('car', 'vehicle', 'asset-1'), 'entity', shot('s1'), 'refs');
  rejected(entity('hammer', 'prop', null), 'entity', shot('s1'), 'refs', '主图');
  rejected(entity('ben', 'character', 'asset-1'), 'entity', shot('s1'), 'refs');
});

test('R5/R6 character_state → refs / first_frame', () => {
  const state = characterState('state-1', 'ben', 'asset-9');
  ok(state, 'image', shot('s1'), 'refs');
  ok(state, 'image', shot('s1'), 'first_frame');
  rejected(characterState('state-2', 'ben', null), 'image', shot('s1'), 'refs');
});

test('R7/R8 media image → refs / first_frame', () => {
  ok(media('m1', 'image'), 'image', shot('s1'), 'refs');
  ok(media('m1', 'image'), 'image', shot('s1'), 'first_frame');
  rejected(media('m2', 'video'), 'image', shot('s1'), 'refs');
});

test('R9 media image → last_frame only for fl2va/l2va', () => {
  ok(media('m1', 'image'), 'image', shot('s1', { h3Mode: 'fl2va' }), 'last_frame');
  ok(media('m1', 'image'), 'image', shot('s2', { h3Mode: 'l2va' }), 'last_frame');
  rejected(media('m1', 'image'), 'image', shot('s3', { h3Mode: 't2va' }), 'last_frame', '尾帧');
});

test('R10/R11 media video/audio → shot video_ref/audio_ref', () => {
  ok(media('v1', 'video'), 'video', shot('s1', { h3Mode: 'vref2va' }), 'video_ref');
  ok(media('a1', 'audio'), 'audio', shot('s1'), 'audio_ref');
  rejected(media('a1', 'audio'), 'audio', shot('s1'), 'video_ref');
});

test('R12 shot tail_frame → shot first_frame rejects self, allows others', () => {
  ok(shot('a'), 'tail_frame', shot('b'), 'first_frame');
  rejected(shot('a'), 'tail_frame', shot('a'), 'first_frame', '自己');
});

test('R13 takes.selected → timeline.clips needs a selected take', () => {
  ok(takes('s1', ['candidate', 'selected']), 'selected', timeline('tl-1'), 'clips');
  rejected(takes('s1', ['candidate']), 'selected', timeline('tl-1'), 'clips', '选片');
  rejected(takes('s1', []), 'selected', timeline('tl-1'), 'clips');
});

test('unknown connections are rejected', () => {
  rejected(beat('beat-1'), 'beat', timeline('tl-1'), 'clips');
  rejected(shot('s1'), 'takes', timeline('tl-1'), 'clips');
});

test('rule table covers R1–R13 exactly once each', () => {
  const ids = CANVAS_CONNECTION_RULES.map((rule) => rule.id);
  for (let index = 1; index <= 13; index++) assert.ok(ids.includes(`R${index}`), `missing R${index}`);
});

test('shot port visibility follows h3 mode', () => {
  const visible = (mode: H3Mode | null, id: string) => shotNodePorts(mode).some((port) => port.id === id && port.visible);
  assert.equal(visible('t2va', 'last_frame'), false);
  assert.equal(visible('i2va', 'last_frame'), false);
  assert.equal(visible('fl2va', 'last_frame'), true);
  assert.equal(visible('l2va', 'last_frame'), true);
  assert.equal(visible('t2va', 'video_ref'), false);
  assert.equal(visible('vref2va', 'video_ref'), true);
  assert.equal(visible('t2va', 'refs'), true);
  assert.equal(visible(null, 'first_frame'), true);
});
