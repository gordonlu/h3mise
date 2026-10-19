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
  story: { width: 280, height: 200 },
  beat: { width: 240, height: 120 },
  sequence: { width: 240, height: 96 },
  storyboard: { width: 320, height: 200 },
  entity: { width: 170, height: 178 },
  character_state: { width: 170, height: 110 },
  media: { width: 190, height: 150 },
  shot: { width: 300, height: 220 },
  takes: { width: 260, height: 160 },
  timeline: { width: 300, height: 170 },
  export: { width: 260, height: 150 },
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
  let focusNonce = 0;

  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const [nextGraph, nextLayout] = await Promise.all([
        get<CanvasGraph>('/api/canvas/graph'),
        get<CanvasLayoutDoc>('/api/canvas/layout'),
      ]);
      graph.value = nextGraph;
      layout.value = nextLayout;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  /** Re-fetch the projection using the current revision as an ETag. A 304 is a
   * no-op, so untouched projects do not churn the store. */
  async function refreshGraph(): Promise<void> {
    const current = graph.value;
    try {
      const { status, data } = await getConditional<CanvasGraph>(
        '/api/canvas/graph',
        current ? `"${current.revision}"` : undefined,
      );
      if (status === 304 || !data) return;
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
    const auto = laneLayout(graph.value.nodes, pinned, {
      ...defaultLaneLayoutOptions(studioNodeSize),
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
        hidden: hiddenLanes.value.includes(node.lane) && node.kind !== 'note' && node.kind !== 'frame',
      };
    }),
  );

  const flowEdges = computed(() =>
    (graph.value?.edges ?? [])
      // Asset bindings are focusOnly: hidden by default, shown when one of
      // their endpoints is selected (design §7.5 — avoids spaghetti). The view
      // menu can reveal every edge.
      .filter((edge) => layout.value?.view.edgeVisibility === 'all' || !edge.focusOnly || selection.value.includes(edge.source) || selection.value.includes(edge.target))
      .map((edge) => ({
        id: edge.id,
        type: 'typed',
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourcePort,
        targetHandle: edge.targetPort,
        data: { edge },
      })),
  );

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
    load,
    refreshGraph,
    select,
    clearSelection,
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
  'media', 'shot', 'takes', 'timeline', 'export', 'note', 'frame',
];
