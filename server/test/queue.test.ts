// Render queue invariants — P0-1 multi-project isolation.
// Jobs are bound to their owning project; recovery spans every project; the
// worker never depends on `store.current`.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeStore, makeProject, makeProjectDetached, makeShotWithPrompt, fakeTake, cleanupTempRoot, bus } from './helpers.js';
import { advanceTo } from '../src/modules/shots.js';
import { RenderQueue } from '../src/modules/render.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { Ffmpeg } from '../src/ffmpeg.js';
import type { ProjectStore } from '../src/project-store.js';
import type { Db } from '../src/db/sqlite.js';
import { getTimeline } from '../src/modules/timeline.js';

const roots: string[] = [];
after(() => { for (const r of roots) cleanupTempRoot(r); });

function makeRegistry(registryDb: Db) {
  // mock mode: no network, real ffmpeg synthetic rendering
  const r = new ProviderRegistry(() => null, () => registryDb, new Ffmpeg(), null, 'mock');
  r.refresh(); // production wires providers on boot; tests must too
  return r;
}

function makeQueue(store: ProjectStore, registry: ProviderRegistry, pollMs: number) {
  return new RenderQueue(() => store, registry, new Ffmpeg(), bus(), pollMs);
}

function waitFor(predicate: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      const done = (v: boolean) => {
        if (v) { clearInterval(iv); resolve(); }
        else if (Date.now() - start > ms) { clearInterval(iv); reject(new Error('timeout waiting for condition')); }
      };
      const r = predicate();
      if (r instanceof Promise) r.then(done);
      else done(r);
    }, 100);
  });
}

test('jobs live in the owning project DB and submit in the open project', async () => {
  const { root, store } = await makeStore('queue');
  roots.push(root);
  const pA = await makeProjectDetached(store, 'projA');
  const pB = await makeProjectDetached(store, 'projB');
  const { shotId, promptVersionId } = makeShotWithPrompt(pA, 't2va');
  advanceTo(pA, shotId, 'PREFLIGHT_READY');
  const registry = makeRegistry(store.registry);
  const queue = makeQueue(store, registry, 999_999); // never poll in this test

  // open project is pB — submitting for pA must be rejected (P0-1)
  await store.open(pB.meta.id);
  assert.throws(() =>
    queue.submit({
      projectId: pA.meta.id,
      shotId,
      promptVersionId,
      provider: 'mock',
      request: { provider: 'mock', aiAppId: 'x', mode: 't2va', promptVersionId, durationSeconds: 1, aspectRatio: '16:9', references: [], providerParams: {} },
      intentHash: 'h',
    }),
    /open project/,
  );

  // open pA and submit — job row goes into pA's DB with project_id set
  const cur = await store.open(pA.meta.id);
  pA.close(); // queue keeps its own detached ctx for pA after this
  assert.equal(cur.meta.id, pA.meta.id);
  const job = queue.submit({
    projectId: pA.meta.id,
    shotId,
    promptVersionId,
    provider: 'mock',
    request: { provider: 'mock', aiAppId: 'x', mode: 't2va', promptVersionId, durationSeconds: 1, aspectRatio: '16:9', references: [], providerParams: {} },
    intentHash: 'h',
  });
  assert.ok(job.id.startsWith('job-'));
  const row = cur.db.get<{ project_id: string }>('SELECT project_id FROM render_jobs WHERE id = ?', [job.id]);
  assert.equal(row?.project_id, pA.meta.id);
  assert.equal(pB.db.get<{ c: number }>('SELECT COUNT(*) as c FROM render_jobs')!.c, 0);

  // cancel is scoped to the owning project and works with a different project open
  await store.open(pB.meta.id);
  queue.cancel(job.id);
  await waitFor(async () => {
    const d = await store.openDetached(pA.meta.id);
    const s = d.db.get<{ status: string }>('SELECT status FROM render_jobs WHERE id = ?', [job.id])?.status;
    d.close();
    return s === 'CANCELLED';
  }, 3000);
  queue.forgetProject(pA.meta.id);
  pB.close();
});

test('retry creates a NEW job and keeps the old failure record', async () => {
  const { root, store } = await makeStore('queue');
  roots.push(root);
  const p = await makeProjectDetached(store, 'retryP');
  const { shotId, promptVersionId } = makeShotWithPrompt(p, 't2va');
  advanceTo(p, shotId, 'PREFLIGHT_READY');
  const registry = makeRegistry(store.registry);
  const queue = makeQueue(store, registry, 999_999);
  const cur = await store.open(p.meta.id);
  p.close();

  const job = queue.submit({
    projectId: p.meta.id, shotId, promptVersionId, provider: 'mock',
    request: { provider: 'mock', aiAppId: 'x', mode: 't2va', promptVersionId, durationSeconds: 1, aspectRatio: '16:9', references: [], providerParams: {} },
    intentHash: 'h',
  });
  // wait for the worker to persist its submission (job leaves SUBMITTING),
  // then fail it explicitly so retry is allowed
  await waitFor(() => cur.db.get<{ status: string }>('SELECT status FROM render_jobs WHERE id = ?', [job.id])?.status !== 'SUBMITTING', 5000);
  cur.db.run("UPDATE render_jobs SET status = 'FAILED' WHERE id = ?", [job.id]);
  queue.retry(job.id);
  await waitFor(() => cur.db.get<{ c: number }>('SELECT COUNT(*) as c FROM render_jobs')!.c >= 2, 2000);
  const jobs = cur.db.all<{ id: string; status: string }>('SELECT id, status FROM render_jobs ORDER BY created_at');
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0]!.status, 'FAILED'); // original stays as failure record
  assert.notEqual(jobs[1]!.id, jobs[0]!.id); // retry is a NEW job
  assert.notEqual(jobs[1]!.status, 'FAILED'); // worker picked it up (no failure)
  queue.forgetProject(p.meta.id);
  cur.close();
});

test('end-to-end mock render: upload -> success -> take created once', async () => {
  const { root, store } = await makeStore('queue');
  roots.push(root);
  const p = await makeProjectDetached(store, 'e2eP');
  const { shotId, promptVersionId } = makeShotWithPrompt(p, 't2va');
  advanceTo(p, shotId, 'PREFLIGHT_READY');
  const registry = makeRegistry(store.registry);
  const queue = makeQueue(store, registry, 150);
  const cur = await store.open(p.meta.id);
  p.close();

  const job = queue.submit({
    projectId: p.meta.id, shotId, promptVersionId, provider: 'mock',
    request: { provider: 'mock', aiAppId: 'x', mode: 't2va', promptVersionId, durationSeconds: 1, aspectRatio: '16:9', references: [], providerParams: {} },
    intentHash: 'h',
  });
  await waitFor(() => cur.db.get<{ status: string }>('SELECT status FROM render_jobs WHERE id = ?', [job.id])?.status === 'LOCAL_READY', 30_000);
  const takes = cur.db.all<{ id: string }>('SELECT id FROM takes');
  assert.equal(takes.length, 1); // exactly one take for one job
  // createTake idempotency: calling it again with the same render job returns
  // the SAME take (crash-window double-create must not double rows)
  const { createTake } = await import('../src/modules/takes.js');
  const dup = await createTake(cur, {
    shotId,
    renderJobId: job.id,
    promptVersionId,
    directorPlanVersionId: null,
    localVideoPath: 'never-written.mp4',
    duration: 1,
  });
  assert.equal(dup.id, takes[0]!.id);
  assert.equal(cur.db.get<{ c: number }>('SELECT COUNT(*) as c FROM takes')!.c, 1);
  // take file actually exists on disk (downloadAndCreateTake renamed .part)
  const row = cur.db.get<{ local_video_path: string }>('SELECT local_video_path FROM takes WHERE id = ?', [takes[0]!.id])!;
  const fs = await import('node:fs/promises');
  const ok = await fs.access(cur.resolveProjectPath(row.local_video_path)).then(() => true, () => false);
  assert.equal(ok, true);
  queue.forgetProject(p.meta.id);
  cur.close();
});

test('recover() scans ALL projects and does not touch store.current', async () => {
  const { root, store } = await makeStore('queue');
  roots.push(root);
  const pA = await makeProjectDetached(store, 'recA');
  const pB = await makeProjectDetached(store, 'recB');
  const { shotId, promptVersionId } = makeShotWithPrompt(pA, 't2va');
  advanceTo(pA, shotId, 'PREFLIGHT_READY');
  const bShot = makeShotWithPrompt(pB, 't2va');
  const registry = makeRegistry(store.registry);
  const queue = makeQueue(store, registry, 999_999);


  const curA = await store.open(pA.meta.id);
  const job = queue.submit({
    projectId: pA.meta.id, shotId, promptVersionId, provider: 'mock',
    request: { provider: 'mock', aiAppId: 'x', mode: 't2va', promptVersionId, durationSeconds: 1, aspectRatio: '16:9', references: [], providerParams: {} },
    intentHash: 'h',
  });
  // simulate a job mid-flight in pB as well (real FK targets)
  pB.db.run(
    `INSERT INTO render_jobs (id, project_id, shot_id, prompt_version_id, director_plan_version_id, provider, status, request_snapshot_json, render_intent_hash, created_at, updated_at)
     VALUES ('job-b', ?, ?, ?, NULL, 'mock', 'QUEUED', '{}', NULL, datetime('now'), datetime('now'))`,
    [pB.meta.id, bShot.shotId, bShot.promptVersionId],
  );
  pB.db.run("UPDATE render_jobs SET provider_task_id = 'mock-b' WHERE id = 'job-b'");
  pA.close(); // current switches below; queue keeps its own detached ctx

  // switch to pB — recover must pick up pA's pending job even so
  const before = curA.db.get<{ status: string }>('SELECT status FROM render_jobs WHERE id = ?', [job.id])!.status;
  await store.open(pB.meta.id);
  await queue.recover();
  const dA = await store.openDetached(pA.meta.id);
  const afterRow = dA.db.get<{ status: string; error: string | null }>('SELECT status, error FROM render_jobs WHERE id = ?', [job.id])!;
  dA.close();
  // a job submitted but never polled (no taskId) is NEVER resubmitted on
  // recovery — it is failed with a retry hint (no double cost)
  assert.equal(afterRow.status, 'FAILED');
  assert.match(afterRow.error ?? '', /retry/);
  assert.ok(before !== afterRow.status); // state actually changed
  // job-b (with a taskId) is re-enqueued and picked up by the worker — its
  // mock task file does not exist, so it fails with a provider error
  await waitFor(() => pB.db.get<{ status: string }>("SELECT status FROM render_jobs WHERE id = 'job-b'")?.status !== 'QUEUED', 3000);
  const bRow = pB.db.get<{ status: string; error: string | null }>("SELECT status, error FROM render_jobs WHERE id = 'job-b'")!;
  assert.equal(bRow.status, 'FAILED');
  assert.match(bRow.error ?? '', /mock|unknown/i);
  assert.equal(store.current?.meta.id, pB.meta.id); // store.current untouched
  queue.forgetProject(pA.meta.id);
  queue.forgetProject(pB.meta.id);
  pB.close();
});

test('exportTimeline refuses clips whose take is no longer selected', async () => {
  const { root, store } = await makeStore('queue');
  roots.push(root);
  const p = await makeProjectDetached(store, 'tlP');
  const { shotId, promptVersionId } = makeShotWithPrompt(p, 't2va');
  advanceTo(p, shotId, 'PREFLIGHT_READY');
  const registry = makeRegistry(store.registry);
  const queue = makeQueue(store, registry, 999_999);
  const cur = await store.open(p.meta.id);
  p.close();
  const job = queue.submit({
    projectId: p.meta.id, shotId, promptVersionId, provider: 'mock',
    request: { provider: 'mock', aiAppId: 'x', mode: 't2va', promptVersionId, durationSeconds: 1, aspectRatio: '16:9', references: [], providerParams: {} },
    intentHash: 'h',
  });
  cur.db.run("UPDATE render_jobs SET status = 'SUCCEEDED' WHERE id = ?", [job.id]);
  const take = await fakeTake(cur, shotId, promptVersionId, 'e');
  // add a valid clip first, THEN demote the take — export must refuse
  const { selectTake } = await import('../src/modules/takes.js');
  selectTake(cur, take.id);
  const { addClip, exportTimeline } = await import('../src/modules/timeline.js');
  addClip(cur, { shotId, takeId: take.id });
  cur.db.run("UPDATE takes SET status = 'candidate' WHERE id = ?", [take.id]);
  await assert.rejects(() => exportTimeline(cur, new Ffmpeg()), /no longer selected/);
  queue.forgetProject(p.meta.id);
  cur.close();
});
