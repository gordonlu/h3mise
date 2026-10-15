// Studio Canvas connection rules (docs/studio-canvas/02-prd-tech.md §8).
// Single source of truth: the web canvas uses it to decide which ports a drag
// may land on; the server uses it as the first validation pass before running
// domain-level checks (cycles, reference limits, locks). Pure — no I/O.
// ---------------------------------------------------------------------------

import type { CanvasNode, CanvasNodeKind, CanvasPortId } from './canvas.js';

export type CanvasConnectEffect =
  | 'set_shot_beat'
  | 'set_shot_primary_character'
  | 'set_shot_scene'
  | 'create_binding'
  | 'create_first_frame_binding'
  | 'create_last_frame_binding'
  | 'set_frame_chain'
  | 'add_timeline_clip';

export interface CanvasConnectionRule {
  /** Rule id from the spec table (R1…R13) — useful for tests and logging. */
  id: string;
  sourceKind: CanvasNodeKind;
  sourcePort: CanvasPortId;
  targetKind: CanvasNodeKind;
  targetPort: CanvasPortId;
  /** Pure predicate. `true` = applicable, a string is the user-facing reason. */
  when?: (source: CanvasNode, target: CanvasNode) => true | string;
  effect: CanvasConnectEffect;
  needsRolePicker?: boolean;
}

function entityKind(source: CanvasNode): string | null {
  return source.kind === 'entity' ? source.data.entityKind : null;
}

function hasEntityImage(source: CanvasNode): boolean {
  return source.kind === 'entity' ? Boolean(source.data.imageAssetId) : false;
}

function targetShotMode(target: CanvasNode): string | null {
  return target.kind === 'shot' ? target.data.h3Mode : null;
}

export const CANVAS_CONNECTION_RULES: CanvasConnectionRule[] = [
  {
    id: 'R1',
    sourceKind: 'beat',
    sourcePort: 'beat',
    targetKind: 'shot',
    targetPort: 'beat',
    effect: 'set_shot_beat',
  },
  {
    id: 'R2',
    sourceKind: 'entity',
    sourcePort: 'entity',
    targetKind: 'shot',
    targetPort: 'cast',
    when: (source) => {
      const kind = entityKind(source);
      if (kind === 'character' || kind === 'creature') return true;
      return '仅角色或生物可作为主角色';
    },
    effect: 'set_shot_primary_character',
  },
  {
    id: 'R3',
    sourceKind: 'entity',
    sourcePort: 'entity',
    targetKind: 'shot',
    targetPort: 'cast',
    when: (source) => (entityKind(source) === 'scene' ? true : '仅场景实体可设为场景'),
    effect: 'set_shot_scene',
  },
  {
    id: 'R4',
    sourceKind: 'entity',
    sourcePort: 'entity',
    targetKind: 'shot',
    targetPort: 'refs',
    when: (source) => {
      const kind = entityKind(source);
      if (kind !== 'prop' && kind !== 'vehicle') return '道具或载具可作参考图';
      return hasEntityImage(source) ? true : '该实体缺少主图，无法作参考';
    },
    effect: 'create_binding',
    needsRolePicker: true,
  },
  {
    id: 'R5',
    sourceKind: 'character_state',
    sourcePort: 'image',
    targetKind: 'shot',
    targetPort: 'refs',
    when: (source) =>
      source.kind === 'character_state' && source.data.effectiveImageAssetId
        ? true
        : '该角色状态没有可用图片',
    effect: 'create_binding',
    needsRolePicker: true,
  },
  {
    id: 'R6',
    sourceKind: 'character_state',
    sourcePort: 'image',
    targetKind: 'shot',
    targetPort: 'first_frame',
    when: (source) =>
      source.kind === 'character_state' && source.data.effectiveImageAssetId
        ? true
        : '该角色状态没有可用图片',
    effect: 'create_first_frame_binding',
  },
  {
    id: 'R7',
    sourceKind: 'media',
    sourcePort: 'image',
    targetKind: 'shot',
    targetPort: 'refs',
    when: (source) =>
      source.kind === 'media' && source.data.mediaKind === 'image' ? true : '仅图片可作参考图',
    effect: 'create_binding',
    needsRolePicker: true,
  },
  {
    id: 'R8',
    sourceKind: 'media',
    sourcePort: 'image',
    targetKind: 'shot',
    targetPort: 'first_frame',
    when: (source) =>
      source.kind === 'media' && source.data.mediaKind === 'image' ? true : '仅图片可作首帧',
    effect: 'create_first_frame_binding',
  },
  {
    id: 'R9',
    sourceKind: 'media',
    sourcePort: 'image',
    targetKind: 'shot',
    targetPort: 'last_frame',
    when: (source, target) => {
      if (source.kind !== 'media' || source.data.mediaKind !== 'image') return '仅图片可作尾帧';
      const mode = targetShotMode(target);
      return mode === 'fl2va' || mode === 'l2va' ? true : '尾帧仅用于首尾帧（FL2VA）或尾帧（L2VA）模式';
    },
    effect: 'create_last_frame_binding',
  },
  {
    id: 'R10',
    sourceKind: 'media',
    sourcePort: 'video',
    targetKind: 'shot',
    targetPort: 'video_ref',
    when: (source) =>
      source.kind === 'media' && source.data.mediaKind === 'video' ? true : '仅视频可作视频参考',
    effect: 'create_binding',
    needsRolePicker: true,
  },
  {
    id: 'R11',
    sourceKind: 'media',
    sourcePort: 'audio',
    targetKind: 'shot',
    targetPort: 'audio_ref',
    when: (source) =>
      source.kind === 'media' && source.data.mediaKind === 'audio' ? true : '仅音频可作音频参考',
    effect: 'create_binding',
  },
  {
    id: 'R12',
    sourceKind: 'shot',
    sourcePort: 'tail_frame',
    targetKind: 'shot',
    targetPort: 'first_frame',
    when: (source, target) => (source.id === target.id ? '镜头不能连接自己' : true),
    effect: 'set_frame_chain',
  },
  {
    id: 'R13',
    sourceKind: 'takes',
    sourcePort: 'selected',
    targetKind: 'timeline',
    targetPort: 'clips',
    when: (source) => {
      if (source.kind !== 'takes') return '无可用结果';
      return source.data.takes.some((take) => take.status === 'selected') ? true : '尚未选片';
    },
    effect: 'add_timeline_clip',
  },
];

export function canConnect(
  source: CanvasNode,
  sourcePort: CanvasPortId,
  target: CanvasNode,
  targetPort: CanvasPortId,
): { ok: true; rule: CanvasConnectionRule } | { ok: false; reason: string } {
  const candidates = CANVAS_CONNECTION_RULES.filter(
    (rule) =>
      rule.sourceKind === source.kind &&
      rule.sourcePort === sourcePort &&
      rule.targetKind === target.kind &&
      rule.targetPort === targetPort,
  );
  if (candidates.length === 0) return { ok: false, reason: '该连接不受支持' };

  let firstReason: string | null = null;
  for (const rule of candidates) {
    const result = rule.when ? rule.when(source, target) : true;
    if (result === true) return { ok: true, rule };
    if (firstReason === null) firstReason = result;
  }
  return { ok: false, reason: firstReason ?? '该连接不受支持' };
}
