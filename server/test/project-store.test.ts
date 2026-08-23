// ProjectStore.readConfig — per-field merge over defaults (P2).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectStore } from '../src/project-store.js';
import { Db } from '../src/db/sqlite.js';
import { REGISTRY_MIGRATIONS } from '../src/db/schema.js';
import { migrate } from '../src/db/migrate.js';

const live: Array<{ root: string; registry: Db }> = [];
after(() => {
  for (const { root, registry } of live) {
    // Close before rm: Windows keeps -wal/-shm locked while handles are open.
    try {
      registry.close();
    } catch {
      /* already closed */
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function storeWithConfig(configJson: string | null) {
  const root = mkdtempSync(join(tmpdir(), 'h3mise-config-'));
  if (configJson !== null) writeFileSync(join(root, 'project.json'), configJson, 'utf8');
  const registry = new Db(join(root, 'registry.db'));
  migrate(registry, REGISTRY_MIGRATIONS);
  const store = new ProjectStore(registry, join(root, 'projects'));
  live.push({ root, registry });
  return { root, store };
}

test('a partial project.json keeps its good fields and defaults the rest', async () => {
  const { root, store } = storeWithConfig(JSON.stringify({ title: '我的项目', visual_style: '胶片感' }));
  const cfg = await store.readConfig(root);
  assert.equal(cfg.title, '我的项目');
  assert.equal(cfg.visual_style, '胶片感');
  assert.equal(cfg.default_aspect_ratio, '16:9');
  assert.equal(cfg.default_duration_seconds, 5);
});

test('missing default_duration_seconds no longer discards the whole file', async () => {
  const { root, store } = storeWithConfig(JSON.stringify({ title: 'Kept', default_aspect_ratio: '9:16' }));
  const cfg = await store.readConfig(root);
  assert.equal(cfg.title, 'Kept');
  assert.equal(cfg.default_aspect_ratio, '9:16');
  assert.equal(cfg.default_duration_seconds, 5);
});

test('invalid duration falls back per-field; garbage file yields pure defaults', async () => {
  const bad = storeWithConfig(JSON.stringify({ title: 'X', default_duration_seconds: 0 }));
  const cfgBad = await bad.store.readConfig(bad.root);
  assert.equal(cfgBad.title, 'X');
  assert.equal(cfgBad.default_duration_seconds, 5);

  const none = storeWithConfig(null);
  const cfgNone = await none.store.readConfig(none.root);
  assert.equal(cfgNone.title, 'Untitled');
});
