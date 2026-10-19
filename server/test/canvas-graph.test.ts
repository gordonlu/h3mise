// Studio Canvas graph projection (spec §11, §16.2 WP-03).

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTempRoot, makeStore } from './helpers.js';
import { buildApp } from '../src/http/app.js';
import { SessionManager } from '../src/http/security.js';
import type { AppServices } from '../src/http/routes.js';
import { createShot } from '../src/modules/shots.js';
import { activeEpisodeId } from '../src/modules/story.js';
import * as canvasMod from '../src/modules/canvas.js';
import { listMedia } from '../src/modules/assets.js';
import type { BreakdownNodeData, MediaNodeData } from '@h3mise/shared';

const roots: string[] = [];
after(() => roots.forEach((root) => cleanupTempRoot(root)));

const demoDir = fileURLToPath(new URL('../../demo/good-boy.h3studio', import.meta.url));

async function openDemo() {
  const { root, store } = await makeStore('canvas-graph');
  roots.push(root);
  const meta = await store.installDemo(demoDir);
  const ctx = await store.open(meta.id);
  return { store, ctx };
}

function countByKind(nodes: { kind: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of nodes) counts[node.kind] = (counts[node.kind] ?? 0) + 1;
  return counts;
}

test('projects the Good Boy demo into story/beat/shot/takes/timeline nodes', async () => {
  const { ctx } = await openDemo();
  const graph = canvasMod.buildCanvasGraph(ctx);
  const counts = countByKind(graph.nodes);
  assert.equal(counts.story, 1);
  assert.equal(counts.beat, 3);
  assert.equal(counts.shot, 3);
  assert.equal(counts.takes, 3);
  assert.equal(counts.timeline, 1);
  assert.equal(counts.export, 1);
  assert.equal(graph.storyId, activeEpisodeId(ctx));

  const beatShotEdges = graph.edges.filter((edge) => edge.kind === 'beat_shot');
  assert.equal(beatShotEdges.length, 3);
  const shotTakes = graph.edges.filter((edge) => edge.kind === 'shot_takes');
  assert.equal(shotTakes.length, 3);
  assert.ok(graph.edges.some((edge) => edge.kind === 'timeline_export'));
});

test('revision is stable, ETag matches, and content changes move it', async () => {
  const { ctx } = await openDemo();
  const first = canvasMod.buildCanvasGraph(ctx);
  const second = canvasMod.buildCanvasGraph(ctx);
  assert.equal(first.revision, second.revision);
  assert.notEqual(first.generatedAt, undefined);

  const shot = createShot(ctx, { title: 'New Shot' });
  const third = canvasMod.buildCanvasGraph(ctx);
  assert.notEqual(third.revision, first.revision);
  assert.ok(third.nodes.some((node) => node.id === `shot:${shot.id}`));
});

test('graph is episode-scoped (stale storyId is rejected)', async () => {
  const { ctx } = await openDemo();
  assert.throws(
    () => canvasMod.resolveActiveStory(ctx, 'story-other'),
    (error: unknown) => error instanceof canvasMod.CanvasError && error.code === 'stale_episode',
  );
});

test('GET /api/canvas/graph returns an ETag and honors If-None-Match', async () => {
  const { store, ctx } = await openDemo();
  const sessions = new SessionManager();
  const app = buildApp({ store, sessions } as unknown as AppServices, null);
  const get = (headers: Record<string, string> = {}) => app.request('/api/canvas/graph', { headers: { host: 'localhost', ...headers } });

  const first = await get();
  assert.equal(first.status, 200);
  const graph = (await first.json()) as { revision: string; nodes: unknown[] };
  const etag = first.headers.get('etag');
  assert.equal(etag, `"${graph.revision}"`);

  const cached = await get({ 'if-none-match': etag! });
  assert.equal(cached.status, 304);

  const stale = await get({ 'if-none-match': '"deadbeef"' });
  assert.equal(stale.status, 200);
  assert.equal(ctx.meta.id, store.current?.meta.id);
});

test('user-placed media appears and reports userPlaced=true', async () => {
  const { ctx } = await openDemo();
  const media = listMedia(ctx, 'image')[0];
  assert.ok(media);
  canvasMod.saveLayout(ctx, {
    storyId: activeEpisodeId(ctx),
    nodes: [{
      nodeId: `media:${media.id}`,
      x: 42,
      y: 64,
      collapsed: false,
      pinned: true,
      userPlaced: true,
    }],
  });
  const graph = canvasMod.buildCanvasGraph(ctx);
  const node = graph.nodes.find((candidate) => candidate.id === `media:${media.id}`);
  assert.ok(node);
  assert.equal((node.data as MediaNodeData).userPlaced, true);
});

test('saved reference breakdowns project as reference-lane nodes', async () => {
  const { ctx } = await openDemo();
  const media = listMedia(ctx)[0];
  assert.ok(media);
  ctx.db.run(
    'INSERT OR REPLACE INTO reference_breakdowns (asset_id, document_json, analysis_json) VALUES (?, ?, NULL)',
    [media.id, JSON.stringify({
      assetId: media.id,
      duration: 12,
      fps: 25,
      width: 1920,
      height: 1080,
      cuts: [],
      frames: [{ relPath: 'a.jpg', timeSeconds: 0 }, { relPath: 'b.jpg', timeSeconds: 1 }],
      segments: [{ id: 'seg-1', start: 0, end: 6, label: 'A' }, { id: 'seg-2', start: 6, end: 12, label: 'B' }],
      revision: 3,
    })],
  );
  const graph = canvasMod.buildCanvasGraph(ctx);
  const node = graph.nodes.find((candidate) => candidate.id === `breakdown:${media.id}`);
  assert.ok(node);
  assert.equal(node.kind, 'breakdown');
  assert.equal(node.lane, 'reference');
  const data = node.data as BreakdownNodeData;
  assert.equal(data.segmentCount, 2);
  assert.equal(data.frameCount, 2);
  assert.equal(data.hasAnalysis, false);
  assert.equal(data.revision, 3);
  assert.ok(node.badges.some((badge) => badge.kind === 'warning'));
});

test('query count does not grow linearly with the number of shots', async () => {
  const { ctx } = await openDemo();
  const db = ctx.db as unknown as { all: (...a: unknown[]) => unknown; get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown };
  const counters = { n: 0 };
  const wrap = (name: 'all' | 'get' | 'run') => {
    const original = db[name].bind(db);
    db[name] = (...args: unknown[]) => {
      counters.n++;
      return (original as (...a: unknown[]) => unknown)(...args);
    };
  };
  (['all', 'get', 'run'] as const).forEach(wrap);

  counters.n = 0;
  canvasMod.buildCanvasGraph(ctx);
  const baseline = counters.n;

  for (let index = 0; index < 20; index++) createShot(ctx, { title: `Extra ${index}` });
  counters.n = 0;
  canvasMod.buildCanvasGraph(ctx);
  const enlarged = counters.n;

  assert.ok(
    enlarged <= baseline + 2,
    `expected a bounded query count, got baseline=${baseline} enlarged=${enlarged}`,
  );
});
