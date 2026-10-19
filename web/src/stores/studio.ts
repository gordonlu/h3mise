// Studio Canvas store — merges the server graph projection with the persisted
// layout, deterministic lane positions, and transient UI state (selection,
// live jobs, focus requests). Domain mutations always go through the server.

import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import type {
  CanvasAnnotation,
  CanvasConnectRequest,
  CanvasConnectResult,
  CanvasGraph,
  CanvasLane,
  CanvasLayoutDoc,
  CanvasNode,
  CanvasNodeId,
  CanvasNodeLayout,
  CanvasNodeKind,
  CanvasPortId,
  CanvasViewState,
} from '@h3mise/shared';
import { canConnect, defaultLaneLayoutOptions, laneLayout } from '@h3mise/shared';
import { del, get, getConditional, post, put } from '../api/client';

export type StudioLod = 'overview' | 'card' | 'detail';

export interface KeyboardConnectTarget {
  nodeId: CanvasNodeId;
  port: CanvasPortId;
}

export interface KeyboardConnectState {
  sourceNodeId: CanvasNodeId;
  sourcePort: CanvasPortId;
  targets: KeyboardConnectTarget[];
  index: number;
}

export type StudioFocusRequest =
  | { kind: 'node'; value: CanvasNodeId; nonce: number }
  | { kind: 'lane'; value: CanvasLane; nonce: number }
  | { kind: 'all'; value: null; nonce: number }
  | { kind: 'selection'; value: null; nonce: number };

type StudioFocusInput =
  | { kind: 'node'; value: CanvasNodeId }
  | { kind: 'lane'; value: CanvasLane }
  | { kind: 'all'; value: null }
  | { kind: 'selection'; value: null };

const NODE_SIZE: Record<string, { width: number; height: number }> = {
  story: { width: 280, height: 220 },
  beat: { width: 240, height: 140 },
  sequence: { width: 240, height: 110 },
  storyboard: { width: 320, height: 220 },
  entity: { width: 180, height: 195 },
  character_state: { width: 155, height: 110 },
  media: { width: 195, height: 180 },
  breakdown: { width: 208, height: 195 },
  shot: { width: 305, height: 245 },
  takes: { width: 260, height: 180 },
  take: { width: 220, height: 190 },
  timeline: { width: 300, height: 190 },
  export: { width: 260, height: 170 },
  note: { width: 240, height: 160 },
  frame: { width: 320, height: 240 },
};

export function studioNodeSize(node: CanvasNode): { width: number; height: number } {
  return NODE_SIZE[node.kind] ?? { width: 240, height: 140 };
}

export const useStudioStore = defineStore('studio', () => {
  const graph = shallowRef<CanvasGraph | null>(null);
  const layout = ref<CanvasLayoutDoc | null>(null);
  const selection = ref<CanvasNodeId[]>([]);
  const selectedEdgeId = ref<string | null>(null);
  const lod = ref<StudioLod>('card');
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** SSE live patch: shotId → in-flight render job (before the graph refresh). */
  const liveJobs = ref<Record<string, { jobId: string; status: string }>>({});
  /** One-shot request for the canvas to fit a node, lane, or the whole graph. */
  const focusRequest = ref<StudioFocusRequest | null>(null);
  const keyboardConnect = ref<KeyboardConnectState | null>(null);
  const expandedEntities = ref<CanvasNodeId[]>([]);
  /** Real rendered card heights, supplied by BaseNode's ResizeObserver. */
  const measuredHeights = ref<Record<CanvasNodeId, number>>({});
  let focusNonce = 0;
  let loadSeq = 0;

  function reset(): void {
    loadSeq += 1;
    graph.value = null;
    layout.value = null;
    selection.value = [];
    selectedEdgeId.value = null;
    liveJobs.value = {};
    keyboardConnect.value = null;
    expandedEntities.value = [];
    measuredHeights.value = {};
    loading.value = true;
    error.value = null;
  }

  async function load(): Promise<void> {
    const seq = ++loadSeq;
    loading.value = true;
    error.value = null;
    try {
      const [nextGraph, nextLayout] = await Promise.all([
        get<CanvasGraph>('/api/canvas/graph'),
        get<CanvasLayoutDoc>('/api/canvas/layout'),
      ]);
      if (seq !== loadSeq) return;
      graph.value = nextGraph;
      layout.value = nextLayout;
    } catch (e) {
      if (seq !== loadSeq) return;
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (seq === loadSeq) loading.value = false;
    }
  }

  /** Re-fetch the projection using the current revision as an ETag. A 304 is a
   * no-op, so untouched projects do not churn the store. */
  async function refreshGraph(): Promise<void> {
    const seq = loadSeq;
    const current = graph.value;
    try {
      const { status, data } = await getConditional<CanvasGraph>(
        '/api/canvas/graph',
        current ? `"${current.revision}"` : undefined,
      );
      if (status === 304 || !data || seq !== loadSeq) return;
      graph.value = data;
    } catch {
      /* a dropped refresh is retried by the next SSE milestone */
    }
  }

  const hiddenLanes = computed(() => layout.value?.view.hiddenLanes ?? []);

  const positions = computed<Map<CanvasNodeId, { x: number; y: number }>>(() => {
    const result = new Map<CanvasNodeId, { x: number; y: number }>();
    if (!graph.value) return result;
    const pinned = new Map<CanvasNodeId, { x: number; y: number }>();
    for (const stored of layout.value?.nodes ?? []) {
      if (stored.pinned) {
        pinned.set(stored.nodeId, { x: stored.x, y: stored.y });
        result.set(stored.nodeId, { x: stored.x, y: stored.y });
      }
    }
    const visible = graph.value.nodes.filter(
      (node) => node.kind !== 'character_state' || !node.groupId || expandedEntities.value.includes(node.groupId),
    );
    const auto = laneLayout(visible, pinned, {
      ...defaultLaneLayoutOptions((node) => {
        const fallback = studioNodeSize(node);
        return { width: fallback.width, height: measuredHeights.value[node.id] ?? fallback.height };
      }),
      hiddenLanes: hiddenLanes.value,
    });
    for (const [id, position] of auto) if (!result.has(id)) result.set(id, position);
    return result;
  });

  function annotationNode(annotation: CanvasAnnotation): CanvasNode {
    return {
      id: `${annotation.kind}:${annotation.id}`,
      kind: annotation.kind,
      domainId: annotation.id,
      title: annotation.text.split('\n')[0]?.slice(0, 40) || annotation.kind,
      lane: 'free',
      rowKey: 0,
      ports: [],
      badges: [],
      groupId: null,
      data: { text: annotation.text, color: annotation.color, width: annotation.width, height: annotation.height },
    };
  }

  const flowNodes = computed(() =>
    [
      ...(graph.value?.nodes ?? []).map((node) => ({ node, position: positions.value.get(node.id) ?? { x: 0, y: 0 } })),
      ...(layout.value?.annotations ?? []).map((annotation) => ({ node: annotationNode(annotation), position: { x: annotation.x, y: annotation.y } })),
    ].map(({ node, position }) => {
      const width = node.kind === 'note' || node.kind === 'frame'
        ? (node.data as { width: number }).width
        : studioNodeSize(node).width;
      return {
        id: node.id,
        type: node.kind,
        position,
        data: { node },
        style: { width: `${width}px` },
        hidden:
          (hiddenLanes.value.includes(node.lane) && node.kind !== 'note' && node.kind !== 'frame') ||
          (node.kind === 'character_state' && Boolean(node.groupId) && !expandedEntities.value.includes(node.groupId!)),
      };
    }),
  );

  const hiddenNodeIds = computed(() =>
    new Set(flowNodes.value.filter((node) => node.hidden).map((node) => node.id)),
  );

  const flowEdges = computed(() => {
    const kinds = new Map((graph.value?.nodes ?? []).map((node) => [node.id, node.kind]));
    const assetEdge = (source: string, target: string, kind: string): boolean =>
      kind === 'cast' || kind === 'binding' ||
      kinds.get(source) === 'entity' || kinds.get(target) === 'entity' ||
      kinds.get(source) === 'character_state' || kinds.get(target) === 'character_state';
    return (graph.value?.edges ?? [])
      // Character/cast relationships stay visible; generic media bindings are
      // focusOnly until an endpoint is selected (design §7.5 — avoids spaghetti).
      .filter((edge) => !hiddenNodeIds.value.has(edge.source) && !hiddenNodeIds.value.has(edge.target))
      .filter((edge) => layout.value?.view.edgeVisibility === 'all' || assetEdge(edge.source, edge.target, edge.kind) || !edge.focusOnly || selection.value.includes(edge.source) || selection.value.includes(edge.target))
      .map((edge) => ({
        id: edge.id,
        type: 'typed',
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourcePort,
        targetHandle: edge.targetPort,
        data: { edge },
      }));
  });

  const nodeById = computed<Map<CanvasNodeId, CanvasNode>>(
    () => new Map((graph.value?.nodes ?? []).map((node) => [node.id, node])),
  );

  const selectedNode = computed<CanvasNode | null>(() => {
    const id = selection.value[0];
    return id ? nodeById.value.get(id) ?? null : null;
  });

  function select(id: CanvasNodeId, additive = false): void {
    if (additive) {
      selection.value = selection.value.includes(id)
        ? selection.value.filter((item) => item !== id)
        : [...selection.value, id];
    } else {
      selection.value = [id];
    }
  }

  function clearSelection(): void {
    selection.value = [];
    selectedEdgeId.value = null;
  }

  function toggleEntity(nodeId: CanvasNodeId): void {
    expandedEntities.value = expandedEntities.value.includes(nodeId)
      ? expandedEntities.value.filter((id) => id !== nodeId)
      : [...expandedEntities.value, nodeId];
  }

  function setMeasuredHeight(nodeId: CanvasNodeId, height: number): void {
    if (!Number.isFinite(height) || height <= 0) return;
    // Keep the largest observed height so overview LOD never compresses or
    // overlaps the card layout when zooming back in.
    if (height <= (measuredHeights.value[nodeId] ?? 0) + 0.5) return;
    measuredHeights.value = { ...measuredHeights.value, [nodeId]: height };
  }

  function selectEdge(id: string | null): void {
    selectedEdgeId.value = id;
    if (id) selection.value = [];
  }

  function setLod(next: StudioLod): void {
    lod.value = next;
  }

  function requestFocus(request: StudioFocusInput): void {
    focusRequest.value = { ...request, nonce: ++focusNonce };
  }

  function focusNode(id: CanvasNodeId): void {
    requestFocus({ kind: 'node', value: id });
  }

  function focusLane(lane: CanvasLane): void {
    requestFocus({ kind: 'lane', value: lane });
  }

  function fitAll(): void {
    requestFocus({ kind: 'all', value: null });
  }

  function fitSelection(): void {
    requestFocus({ kind: 'selection', value: null });
  }

  /** Start keyboard linking from a focused output port. Returns false when no
   * compatible input port exists, so the caller can explain why. */
  function startKeyboardConnect(nodeId: CanvasNodeId, port: CanvasPortId): boolean {
    const source = nodeById.value.get(nodeId);
    if (!source) return false;
    const targets: KeyboardConnectTarget[] = [];
    for (const target of graph.value?.nodes ?? []) {
      for (const candidate of target.ports) {
        if (candidate.direction !== 'in' || !candidate.visible || !candidate.userConnectable) continue;
        if (canConnect(source, port, target, candidate.id).ok) targets.push({ nodeId: target.id, port: candidate.id });
      }
    }
    if (targets.length === 0) {
      keyboardConnect.value = null;
      return false;
    }
    keyboardConnect.value = { sourceNodeId: nodeId, sourcePort: port, targets, index: 0 };
    return true;
  }

  function moveKeyboardConnect(delta: number): void {
    const state = keyboardConnect.value;
    if (!state || state.targets.length === 0) return;
    const index = (state.index + delta + state.targets.length) % state.targets.length;
    keyboardConnect.value = { ...state, index };
  }

  function cancelKeyboardConnect(): void {
    keyboardConnect.value = null;
  }

  function upsertLocalLayout(node: CanvasNodeLayout): void {
    if (!layout.value) return;
    const index = layout.value.nodes.findIndex((item) => item.nodeId === node.nodeId);
    if (index >= 0) layout.value.nodes[index] = node;
    else layout.value.nodes.push(node);
  }

  /** Record a user-moved node (pinned) locally; persistence is debounced by
   * `useLayoutPersist` so a drag burst produces one PUT. */
  function setNodePosition(id: CanvasNodeId, x: number, y: number, pinned = true): CanvasNodeLayout {
    const existing = layout.value?.nodes.find((item) => item.nodeId === id);
    const record: CanvasNodeLayout = {
      nodeId: id,
      x,
      y,
      width: existing?.width ?? null,
      height: existing?.height ?? null,
      collapsed: existing?.collapsed ?? false,
      pinned,
      userPlaced: existing?.userPlaced ?? false,
    };
    upsertLocalLayout(record);
    return record;
  }

  function toggleCollapse(id: CanvasNodeId, collapsed: boolean): CanvasNodeLayout | null {
    const existing = layout.value?.nodes.find((item) => item.nodeId === id);
    if (!existing) return null;
    existing.collapsed = collapsed;
    return { ...existing };
  }

  function setView(view: CanvasViewState): void {
    if (!layout.value) return;
    layout.value.view = view;
  }

  function setEdgeVisibility(mode: CanvasViewState['edgeVisibility']): CanvasViewState | null {
    if (!layout.value) return null;
    layout.value.view = { ...layout.value.view, edgeVisibility: mode };
    return layout.value.view;
  }

  function setHiddenLanes(lanes: CanvasLane[]): CanvasViewState | null {
    if (!layout.value) return null;
    layout.value.view = { ...layout.value.view, hiddenLanes: [...lanes] };
    return layout.value.view;
  }

  /** Persist view-only changes immediately (lanes / edge visibility / reset). */
  async function saveView(): Promise<void> {
    if (!graph.value || !layout.value) return;
    try {
      await saveLayout({ storyId: graph.value.storyId, nodes: [], view: layout.value.view });
    } catch {
      /* layout is a local view; a dropped write is not fatal */
    }
  }

  async function saveLayout(input: {
    storyId: string;
    nodes: CanvasNodeLayout[];
    removeNodeIds?: CanvasNodeId[];
    view?: CanvasViewState;
  }): Promise<void> {
    await put<CanvasLayoutDoc>('/api/canvas/layout', input);
  }

  async function resetLayout(): Promise<void> {
    if (!graph.value) return;
    const doc = await post<CanvasLayoutDoc>('/api/canvas/layout/reset', { storyId: graph.value.storyId });
    layout.value = doc;
  }

  function setLiveJob(shotId: string, job: { jobId: string; status: string } | null): void {
    if (job) liveJobs.value = { ...liveJobs.value, [shotId]: job };
    else {
      const next = { ...liveJobs.value };
      delete next[shotId];
      liveJobs.value = next;
    }
  }

  /** Drag-to-connect: the server validates + applies the domain change. The
   * caller handles the 409 branches (replace / mode switch) and retries. */
  async function connect(request: CanvasConnectRequest): Promise<CanvasConnectResult> {
    const result = await post<CanvasConnectResult>('/api/canvas/connections', request);
    await refreshGraph();
    return result;
  }

  async function disconnect(edgeId: string): Promise<{ undo: CanvasConnectResult['undo'] }> {
    const storyId = graph.value?.storyId;
    const result = await del<{ undo: CanvasConnectResult['undo'] }>(`/api/canvas/connections/${encodeURIComponent(edgeId)}${storyId ? `?storyId=${encodeURIComponent(storyId)}` : ''}`);
    await refreshGraph();
    return result;
  }

  return {
    graph,
    layout,
    selection,
    selectedEdgeId,
    lod,
    loading,
    error,
    liveJobs,
    focusRequest,
    keyboardConnect,
    hiddenLanes,
    positions,
    flowNodes,
    flowEdges,
    nodeById,
    selectedNode,
    expandedEntities,
    measuredHeights,
    reset,
    load,
    refreshGraph,
    select,
    clearSelection,
    toggleEntity,
    setMeasuredHeight,
    selectEdge,
    setLod,
    focusNode,
    focusLane,
    fitAll,
    fitSelection,
    startKeyboardConnect,
    moveKeyboardConnect,
    cancelKeyboardConnect,
    setNodePosition,
    toggleCollapse,
    setView,
    setEdgeVisibility,
    setHiddenLanes,
    saveLayout,
    saveView,
    resetLayout,
    setLiveJob,
    connect,
    disconnect,
  };
});

export const STUDIO_NODE_KINDS: CanvasNodeKind[] = [
  'story', 'beat', 'sequence', 'storyboard', 'entity', 'character_state',
  'media', 'breakdown', 'shot', 'takes', 'take', 'timeline', 'export', 'note', 'frame',
];
