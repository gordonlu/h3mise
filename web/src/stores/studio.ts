// Studio Canvas store — merges the server graph projection with the persisted
// layout and the deterministic lane layout. Read-only in WP-05: positions come
// from laneLayout (unpinned) plus stored pinned positions; no writes yet.

import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import type {
  CanvasAnnotation,
  CanvasGraph,
  CanvasLayoutDoc,
  CanvasNode,
  CanvasNodeId,
  CanvasNodeLayout,
  CanvasNodeKind,
  CanvasViewState,
} from '@h3mise/shared';
import { defaultLaneLayoutOptions, laneLayout } from '@h3mise/shared';
import { get, getConditional, post, put } from '../api/client';

export type StudioLod = 'overview' | 'card' | 'detail';

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
  const lod = ref<StudioLod>('card');
  const loading = ref(false);
  const error = ref<string | null>(null);
  /** SSE live patch: shotId → in-flight render job (before the graph refresh). */
  const liveJobs = ref<Record<string, { jobId: string; status: string }>>({});

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
      // their endpoints is selected (design §7.5 — avoids spaghetti).
      .filter((edge) => !edge.focusOnly || selection.value.includes(edge.source) || selection.value.includes(edge.target))
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
  }

  function setLod(next: StudioLod): void {
    lod.value = next;
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

  return {
    graph,
    layout,
    selection,
    lod,
    loading,
    error,
    liveJobs,
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
    setLod,
    setNodePosition,
    toggleCollapse,
    setView,
    saveLayout,
    resetLayout,
    setLiveJob,
  };
});

export const STUDIO_NODE_KINDS: CanvasNodeKind[] = [
  'story', 'beat', 'sequence', 'storyboard', 'entity', 'character_state',
  'media', 'shot', 'takes', 'timeline', 'export', 'note', 'frame',
];
