import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeStore, makeProject, fakeTake, cleanupTempRoot } from './helpers.js';
import { createShot } from '../src/modules/shots.js';
import { Ffmpeg } from '../src/ffmpeg.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { planRenderBatch, prepareRenderBatch } from '../src/modules/render-batch.js';

const roots: string[] = [];
after(() => { for (const root of roots) cleanupTempRoot(root); });

test('batch preparation creates prompt and preflight without submitting a provider task', async () => {
  const { root, store } = await makeStore('render-batch');
  roots.push(root);
  const p = await makeProject(store, 'batch');
  const shot = createShot(p, { title: 'Independent', h3Mode: 't2va', renderDependencyMode: 'independent' });
  const registry = new ProviderRegistry(() => store.current, () => store.registry, new Ffmpeg(), null, 'mock', undefined, join(root, 'mock'));
  registry.refresh();

  const before = await planRenderBatch(p, registry, { providerId: 'mock' });
  assert.equal(before.shots.find((item) => item.shotId === shot.id)?.stage, 'needs_prompt');

  const result = await prepareRenderBatch(p, registry, { providerId: 'mock' });
  const prepared = result.prepared.find((item) => item.shotId === shot.id);
  assert.ok(prepared);
  assert.equal(prepared?.blocked, false);
  assert.equal(result.plan.shots.find((item) => item.shotId === shot.id)?.stage, 'ready');
  assert.equal(p.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM prompt_versions')?.n, 1);
  assert.equal(p.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM preflight_reports')?.n, 1);
  assert.equal(p.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM render_jobs')?.n, 0);
});

test('batch plan never regenerates a shot that already has a candidate Take awaiting selection', async () => {
  const { root, store } = await makeStore('render-batch-selection');
  roots.push(root);
  const p = await makeProject(store, 'batch-selection');
  const shot = createShot(p, { title: 'Review first', h3Mode: 't2va' });
  const prompt = (await import('../src/modules/prompt.js')).importRawPrompt(p, shot.id, 'review me', 't2va');
  await fakeTake(p, shot.id, prompt.id, 'candidate');
  const registry = new ProviderRegistry(() => store.current, () => store.registry, new Ffmpeg(), null, 'mock', undefined, join(root, 'mock'));
  registry.refresh();

  const plan = await planRenderBatch(p, registry, { providerId: 'mock' });
  const item = plan.shots.find((entry) => entry.shotId === shot.id);
  assert.equal(item?.stage, 'needs_selection');
  assert.match(item?.reason ?? '', /选片/);
});
