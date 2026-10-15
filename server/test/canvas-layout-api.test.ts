// Studio Canvas layout/annotation API + migration v22 (spec §9–§10, §16.2 WP-02).

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { join } from 'node:path';
import { Db } from '../src/db/sqlite.js';
import { migrate } from '../src/db/migrate.js';
import { PROJECT_MIGRATIONS } from '../src/db/schema.js';
import { buildApp } from '../src/http/app.js';
import { SessionManager } from '../src/http/security.js';
import type { AppServices } from '../src/http/routes.js';
import type { CanvasNodeLayout } from '@h3mise/shared';
import { cleanupTempRoot, makeProject, makeStore, makeTempRoot } from './helpers.js';
import { createShot } from '../src/modules/shots.js';
import { activeEpisodeId } from '../src/modules/story.js';
import * as canvasMod from '../src/modules/canvas.js';

const roots: string[] = [];
after(() => roots.forEach((root) => cleanupTempRoot(root)));

function layout(nodeId: string, x: number, y: number, extra: Partial<CanvasNodeLayout> = {}): CanvasNodeLayout {
  return { nodeId, x, y, collapsed: false, pinned: false, userPlaced: false, ...extra };
}

function schemaVersion(db: Db): number {
  return Number(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'")?.value ?? 0);
}

test('migration v22 applies on a fresh project', async () => {
  const { root, store } = await makeStore('canvas-fresh');
  roots.push(root);
  const ctx = await makeProject(store, 'Fresh');
  const tables = ctx.db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .map((row) => row.name);
  for (const table of ['canvas_node_layouts', 'canvas_views', 'canvas_annotations']) {
    assert.ok(tables.includes(table), `missing ${table}`);
  }
  assert.equal(schemaVersion(ctx.db), 22);
});

test('migration v22 upgrades an existing v21 database additively', () => {
  const root = makeTempRoot('canvas-upgrade');
  roots.push(root);
  const db = new Db(join(root, 'upgrade.db'));
  migrate(db, PROJECT_MIGRATIONS.filter((migration) => migration.version <= 21));
  assert.equal(schemaVersion(db), 21);
  assert.equal(db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='canvas_node_layouts'").length, 0);

  migrate(db, PROJECT_MIGRATIONS);
  assert.equal(schemaVersion(db), 22);
  assert.equal(db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='canvas_node_layouts'").length, 1);
  db.close();
});

test('layout round-trips, prunes orphans, and is scoped per episode', async () => {
  const { root, store } = await makeStore('canvas-layout');
  roots.push(root);
  const ctx = await makeProject(store, 'Canvas');
  const storyId = activeEpisodeId(ctx);
  const shot = createShot(ctx, { title: 'S1' });

  const saved = canvasMod.saveLayout(ctx, {
    storyId,
    nodes: [layout(`shot:${shot.id}`, 100, 200, { pinned: true }), layout('shot:deleted', 5, 5)],
    view: { viewport: { x: 0, y: 0, zoom: 0.8 }, layoutMode: 'lanes', edgeVisibility: 'default', hiddenLanes: [] },
  });
  assert.equal(saved.nodes.length, 1, 'deleted domain object is pruned lazily');
  assert.equal(saved.nodes[0]!.nodeId, `shot:${shot.id}`);
  assert.equal(saved.nodes[0]!.pinned, true);

  const reread = canvasMod.getLayout(ctx, storyId);
  assert.deepEqual(reread.nodes, saved.nodes);
  assert.equal(reread.view.viewport.zoom, 0.8);

  assert.throws(
    () => canvasMod.getLayout(ctx, 'story-missing'),
    (error: unknown) => error instanceof canvasMod.CanvasError && error.code === 'stale_episode',
  );
});

test('layout upsert is last-write-wins and removeNodeIds deletes rows', async () => {
  const { root, store } = await makeStore('canvas-layout-upsert');
  roots.push(root);
  const ctx = await makeProject(store, 'Canvas');
  const storyId = activeEpisodeId(ctx);
  const shot = createShot(ctx, { title: 'S1' });
  const nodeId = `shot:${shot.id}`;

  canvasMod.saveLayout(ctx, { storyId, nodes: [layout(nodeId, 1, 1)] });
  const moved = canvasMod.saveLayout(ctx, { storyId, nodes: [layout(nodeId, 42, 43, { pinned: true })] });
  assert.equal(moved.nodes.length, 1);
  assert.deepEqual({ x: moved.nodes[0]!.x, y: moved.nodes[0]!.y }, { x: 42, y: 43 });

  const removed = canvasMod.saveLayout(ctx, { storyId, nodes: [], removeNodeIds: [nodeId] });
  assert.equal(removed.nodes.length, 0);
});

test('layout rejects more than 500 nodes', async () => {
  const { root, store } = await makeStore('canvas-layout-limit');
  roots.push(root);
  const ctx = await makeProject(store, 'Canvas');
  const storyId = activeEpisodeId(ctx);
  const nodes = Array.from({ length: canvasMod.MAX_LAYOUT_NODES + 1 }, (_, index) => layout(`shot:x${index}`, index, 0));
  assert.throws(
    () => canvasMod.saveLayout(ctx, { storyId, nodes }),
    (error: unknown) => error instanceof canvasMod.CanvasError && error.code === 'payload_too_large',
  );
});

test('resetLayout drops positions but keeps annotations', async () => {
  const { root, store } = await makeStore('canvas-reset');
  roots.push(root);
  const ctx = await makeProject(store, 'Canvas');
  const storyId = activeEpisodeId(ctx);
  const shot = createShot(ctx, { title: 'S1' });
  canvasMod.saveLayout(ctx, { storyId, nodes: [layout(`shot:${shot.id}`, 9, 9)] });
  const note = canvasMod.createAnnotation(ctx, { storyId, kind: 'note', x: 1, y: 2, text: 'hello' });

  const reset = canvasMod.resetLayout(ctx, storyId);
  assert.equal(reset.nodes.length, 0);
  assert.equal(reset.annotations.length, 1);
  assert.equal(reset.annotations[0]!.id, note.id);
});

test('annotation CRUD persists text/kind and rejects unknown ids', async () => {
  const { root, store } = await makeStore('canvas-annotations');
  roots.push(root);
  const ctx = await makeProject(store, 'Canvas');
  const storyId = activeEpisodeId(ctx);

  const frame = canvasMod.createAnnotation(ctx, { storyId, kind: 'frame', x: 0, y: 0, width: 480, height: 320 });
  assert.equal(frame.kind, 'frame');
  const updated = canvasMod.updateAnnotation(ctx, frame.id, { text: '框选', color: '#FF6C37', x: 10 });
  assert.equal(updated.text, '框选');
  assert.equal(updated.color, '#FF6C37');
  assert.equal(updated.x, 10);

  canvasMod.deleteAnnotation(ctx, frame.id);
  assert.equal(canvasMod.listAnnotations(ctx, storyId).length, 0);
  assert.throws(
    () => canvasMod.updateAnnotation(ctx, 'note-missing', { text: 'x' }),
    (error: unknown) => error instanceof canvasMod.CanvasError && error.code === 'not_found',
  );
});

test('canvas mutations require a session cookie', async () => {
  const { root, store } = await makeStore('canvas-session');
  roots.push(root);
  const meta = await store.create({ title: 'Canvas', format: 'single_shot' });
  const sessions = new SessionManager();
  const app = buildApp({ store, sessions } as unknown as AppServices, null);
  await store.open(meta.id);

  const put = (cookie?: string) =>
    app.request('/api/canvas/layout', {
      method: 'PUT',
      headers: { host: 'localhost', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ nodes: [] }),
    });

  assert.equal((await put()).status, 401);
  const token = sessions.issue();
  const allowed = await put(`h3mise_session=${token}`);
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json() as { nodes: unknown[] }).nodes.length, 0);
});
