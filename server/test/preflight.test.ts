// Preflight gate tests — P0-2: the gate runs on the EXACT render intent
// (client overrides included), never on shot defaults, and the intent hash
// is deterministic and stable.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, makeProject, makeShotWithPrompt, cleanupTempRoot } from './helpers.js';
import { renderIntentHash, intentFromInput, runBasicPreflightIntent } from '../src/modules/preflight.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { Ffmpeg } from '../src/ffmpeg.js';
import type { Db } from '../src/db/sqlite.js';

const roots: string[] = [];
after(() => { for (const r of roots) cleanupTempRoot(r); });

function makeRegistry(registryDb: Db) {
  const r = new ProviderRegistry(() => null, () => registryDb, new Ffmpeg(), null, 'mock');
  r.refresh();
  return r;
}

test('renderIntentHash is deterministic and input-sensitive', () => {
  const base = {
    shotId: 'shot-001',
    promptVersionId: 'prompt-001',
    providerId: 'mock',
    mode: 't2va' as const,
    durationSeconds: 5,
    aspectRatio: '16:9',
    references: [
      { bindingId: 'b-2', assetId: 'a-2', kind: 'image' as const },
      { bindingId: 'b-1', assetId: 'a-1', kind: 'image' as const },
    ],
    providerParams: { b: 1, a: 2 },
  };
  const ref = { appId: 'app', checkedAt: '2026-01-01T00:00:00.000Z' };
  const h1 = renderIntentHash(base, ref);
  const h2 = renderIntentHash({ ...base, references: [...base.references].reverse() }, ref); // order-insensitive
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{16}$/);
  // duration override MUST change the hash (that is the paid-gate invariant)
  assert.notEqual(h1, renderIntentHash({ ...base, durationSeconds: 6 }, ref));
  // provider profile ref must participate
  assert.notEqual(h1, renderIntentHash(base, { appId: 'app2', checkedAt: ref.checkedAt }));
});

test('gate blocks duration overrides that bypass shot defaults', async () => {
  const { root, store } = await makeStore('preflight');
  roots.push(root);
  const p = await makeProject(store, 'gate');
  const { shotId, promptVersionId } = makeShotWithPrompt(p, 't2va');
  p.config.default_duration_seconds = 3; // shot default says 3s
  const registry = makeRegistry(store.registry);

  // Client overrides duration to 100s via the request body — the gate must
  // evaluate the INTENT (100s), not the shot default (3s).
  const intent = await intentFromInput(p, registry, { shotId, promptVersionId, providerId: 'mock', durationSeconds: 100 });
  assert.equal(intent.durationSeconds, 100);
  const report = await runBasicPreflightIntent(p, registry, intent);
  const dur = report.basic.find((s) => s.key === 'duration');
  assert.ok(dur!.checks.some((c) => c.severity === 'error' && c.key.startsWith('duration.')));
  assert.equal(report.blocked, true);
});

test('gate blocks unknown provider capabilities (P0-6)', async () => {
  const { root, store } = await makeStore('preflight');
  roots.push(root);
  const p = await makeProject(store, 'cap');
  const { shotId, promptVersionId } = makeShotWithPrompt(p, 't2va');
  // registry holds mock provider with full caps; simulate an UNVERIFIED
  // runninghub by requesting the runninghub id — registry has none → blocked
  const registry = makeRegistry(store.registry);
  const intent = await intentFromInput(p, registry, { shotId, promptVersionId, providerId: 'runninghub' });
  const report = await runBasicPreflightIntent(p, registry, intent);
  assert.equal(report.blocked, true);
  const prov = report.basic.find((s) => s.key === 'provider');
  assert.ok(prov!.checks.some((c) => c.severity === 'error'));
});

test('gate passes for a valid mock render (full caps, in-range duration)', async () => {
  const { root, store } = await makeStore('preflight');
  roots.push(root);
  const p = await makeProject(store, 'ok');
  const { shotId, promptVersionId } = makeShotWithPrompt(p, 't2va');
  const registry = makeRegistry(store.registry);
  const intent = await intentFromInput(p, registry, { shotId, promptVersionId, providerId: 'mock', durationSeconds: 3 });
  const report = await runBasicPreflightIntent(p, registry, intent);
  assert.equal(report.blocked, false);
});