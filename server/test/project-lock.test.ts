import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { ProjectMeta } from '@h3mise/shared';
import { buildRoutes, type AppServices } from '../src/http/routes.js';
import { cleanupTempRoot, makeStore } from './helpers.js';
import { createShot } from '../src/modules/shots.js';
import { access } from 'node:fs/promises';

const roots: string[] = [];
after(() => roots.forEach((root) => cleanupTempRoot(root)));

function projectApi(store: Awaited<ReturnType<typeof makeStore>>['store']) {
  return buildRoutes({
    store,
    providers: { refresh() {} },
    queue: { async recover() {} },
  } as unknown as AppServices);
}

async function createMeta(store: Awaited<ReturnType<typeof makeStore>>['store'], title: string): Promise<ProjectMeta> {
  return store.create({ title, format: 'single_shot' });
}

test('opening another project is locked until an explicit force switch', async () => {
  const { root, store } = await makeStore('project-lock-open');
  roots.push(root);
  const first = await createMeta(store, 'First');
  const second = await createMeta(store, 'Second');
  await store.open(first.id);
  const app = projectApi(store);

  const blocked = await app.request(`/api/projects/${second.id}/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(blocked.status, 409);
  assert.deepEqual(await blocked.json(), {
    error: '当前项目还在进行',
    code: 'PROJECT_LOCKED',
    currentProject: { id: first.id, title: 'First' },
    requestedProjectId: second.id,
  });
  assert.equal(store.current?.meta.id, first.id);

  const switched = await app.request(`/api/projects/${second.id}/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ force: true }),
  });
  assert.equal(switched.status, 200);
  assert.equal(store.current?.meta.id, second.id);
});

test('two tabs racing to open projects cannot both acquire the project lock', async () => {
  const { root, store } = await makeStore('project-lock-race');
  roots.push(root);
  const first = await createMeta(store, 'First');
  const second = await createMeta(store, 'Second');
  const app = projectApi(store);

  const open = (id: string) => app.request(`/api/projects/${id}/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const responses = await Promise.all([open(first.id), open(second.id)]);
  assert.deepEqual(responses.map((res) => res.status).sort(), [200, 409]);
  assert.ok(store.current && [first.id, second.id].includes(store.current.meta.id));
});

test('blocked project creation does not leave an unused project behind', async () => {
  const { root, store } = await makeStore('project-lock-create');
  roots.push(root);
  const first = await createMeta(store, 'First');
  await store.open(first.id);
  const app = projectApi(store);
  const before = (await store.list()).length;
  const input = { title: 'Second', format: 'single_shot' };

  const blocked = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  assert.equal(blocked.status, 409);
  assert.equal((await store.list()).length, before);

  const created = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, force: true }),
  });
  assert.equal(created.status, 201);
  assert.equal(store.current?.config.title, 'Second');
  assert.equal((await store.list()).length, before + 1);
});

test('demo installation creates an independent editable project copy', async () => {
  const { root, store } = await makeStore('project-demo-install');
  roots.push(root);
  const sourceMeta = await store.create({ title: 'Bundled Demo', format: 'story' });
  const source = await store.open(sourceMeta.id);
  createShot(source, { title: 'Demo Shot' });
  source.close();

  const installed = await store.installDemo(source.root);
  assert.notEqual(installed.id, sourceMeta.id);
  assert.notEqual(installed.dirPath, sourceMeta.dirPath);
  assert.equal(installed.title, 'Bundled Demo');
  await access(`${installed.dirPath}/cache`);

  const copy = await store.openDetached(installed.id);
  assert.equal(copy.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM shots')?.n, 1);
  copy.close();
});
