import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPinia, setActivePinia } from 'pinia';
import { useStudioStore } from '../src/stores/studio';
import type { CanvasGraph, CanvasLayoutDoc } from '@h3mise/shared';

test('viewport motion reuses node/edge projections and pinned positions', () => {
  setActivePinia(createPinia());
  const store = useStudioStore();
  store.graph = { storyId: 's', nodes: Array.from({ length: 200 }, (_, i) => ({
    id: `shot:${i}`, kind: 'shot', domainId: `${i}`, title: 'Shot', lane: 'shot',
    rowKey: i, ports: [], badges: [], groupId: null, data: {},
  })), edges: [] } as unknown as CanvasGraph;
  store.layout = { storyId: 's', nodes: [{ nodeId: 'shot:0', x: 42, y: 99, pinned: true }], annotations: [],
    view: { viewport: { x: 0, y: 0, zoom: 1 }, hiddenLanes: [], edgeVisibility: 'all' },
  } as unknown as CanvasLayoutDoc;
  const nodes = store.flowNodes, edges = store.flowEdges, positions = store.positions;
  for (let i = 1; i <= 120; i++) {
    store.setView({ ...store.layout.view, viewport: { x: i, y: i, zoom: 0.8 } });
    assert.strictEqual(store.flowNodes, nodes);
    assert.strictEqual(store.flowEdges, edges);
    assert.strictEqual(store.positions, positions);
  }
  assert.deepEqual(store.positions.get('shot:0'), { x: 42, y: 99 });
  store.setHiddenLanes(['shot']);
  assert.notStrictEqual(store.flowNodes, nodes);
  assert.ok(store.flowNodes.every(node => node.hidden));
});
