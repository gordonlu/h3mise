// Render queue invariants 鈥?P0-1 multi-project isolation.
// Jobs are bound to their owning project; recovery spans every project; the
// worker never depends on `store.current`.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeStore, makeProject, makeProjectDetached, makeShotWithPrompt, fakeTake, cleanupTempRoot, bus } from './helpers.js';
import { advanceTo, getShot } from '../src/modules/shots.js';
import { deleteShotAndFiles } from '../src/modules/shots.js';
import { RenderQueue } from '../src/modules/render.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { Ffmpeg } from '../src/ffmpeg.js';
import type { ProjectStore } from '../src/project-store.js';
import type { Db } from '../src/db/sqlite.js';
import { getTimeline } from '../src/modules/timeline.js';
import type { RenderJobHandle, RenderRequestInput, RenderResult, RenderStatus, VideoProvider } from '../src/providers/types.js';
import type { MediaAsset } from '@h3mise/shared';

const roots: string[] = [];
after(() => { for (const r of roots) cleanupTempRoot(r); });

function makeRegistry(registryDb: Db, mockWorkDir?: string) {
  // mock mode: no network, real ffmpeg synthetic rendering. The mock task dir
  // is global by design (P1); tests pin it under their temp root for isolation.
  const r = new ProviderRegistry(() => null, () => registryDb, new Ffmpeg(), null, 'mock', undefined, mockWorkDir);
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
  const registry = makeRegistry(store.registry, join(root, 'global-mock'));
  const queue = makeQueue(store, registry, 999_999); // never poll in this test

  // open project is pB 鈥?submitting for pA must be rejected (P0-1)
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

  // open pA and submit 鈥?job row goes into pA's DB with project_id set
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

test('submit rejects a duplicate active job for the same intent', async () => {
  const { root, store } = await makeStore('queue');
  roots.push(root);
  const p = await makeProjectDetached(store, 'dupP');
  const { shotId, promptVersionId } = makeShotWithPrompt(p, 't2va');
  advanceTo(p, shotId, 'PREFLIGHT_READY');
  const registry = makeRegistry(store.registry, join(root, 'global-mock'));
  const queue = makeQueue(store, registry, 999_999);
  const cur = await store.open(p.meta.id);
  p.close();

  const request = { provider: 'mock', aiAppId: 'x', mode: 't2va' as const, promptVersionId, durationSeconds: 1, aspectRatio: '16:9', references: [], providerParams: {} };
  queue.submit({ projectId: p.meta.id, shotId, promptVersionId, provider: 'mock', request, intentHash: 'same' });
  // exact same intent while the first job is active -> rejected (no double cost)
  assert.throws(() =>
    queue.submit({ projectId: p.meta.id, shotId, promptVersionId, provider: 'mock', request, intentHash: 'same' }),
    /already active/,
  );
  // a DIFFERENT intent (changed duration) is allowed
  const job2 = queue.submit({
    projectId: p.meta.id, shotId, promptVersionId, provider: 'mock',
    request: { ...request, durationSeconds: 2 }, intentHash: 'other',
  });
  assert.notEqual(job2.id, undefined);
  queue.forgetProject(p.meta.id);
  cur.close();
});

test('retry creates a NEW job and keeps the old failure record', async () => {
  const { root, store } = await makeStore('queue');
  roots.push(root);
  const p = await makeProjectDetached(store, 'retryP');
  const { shotId, promptVersionId } = makeShotWithPrompt(p, 't2va');
  advanceTo(p, shotId, 'PREFLIGHT_READY');
  const registry = makeRegistry(store.registry, join(root, 'global-mock'));
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
  cur.db.run("UPDATE render_jobs SET status = 'FAILED', provider_task_id = NULL WHERE id = ?", [job.id]);
  await queue.cancel(job.id);
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

test('retry with a provider task id reconciles the original paid task without creating another job', async () => {
  const { root, store } = await makeStore('queue-reconcile');
  roots.push(root);
  const p = await makeProjectDetached(store, 'reconcile');
  const cur = await store.open(p.meta.id);
  const { shotId, promptVersionId } = makeShotWithPrompt(cur);
  advanceTo(cur, shotId, 'PREFLIGHT_READY');
  const clipPath = join(root, 'reconcile.mp4');
  await new Ffmpeg().syntheticVideo(clipPath, 0.5, 'reconcile');
  let remoteReady = false;
  const provider: VideoProvider = {
    id: 'recoverable', name: 'recoverable', configured: true,
    async capabilities() { return { supportedModes: ['t2va'] }; },
    async uploadAsset() { return { providerRef: 'unused' }; },
    async submit() { return { providerTaskId: 'paid-task-1' }; },
    async status() { return remoteReady ? { status: 'SUCCEEDED', resultUrl: `mock://${clipPath}` } : { status: 'RUNNING' }; },
    async result() { return { url: `mock://${clipPath}`, cost: { coins: 113 } }; },
    async cancel() {},
  };
  const registry = { get: () => provider } as unknown as ProviderRegistry;
  const queue = new RenderQueue(() => store, registry, new Ffmpeg(), bus(), 20);
  const job = queue.submit({ projectId: cur.meta.id, shotId, promptVersionId, provider: provider.id, request: REQUEST(promptVersionId), intentHash: 'reconcile-intent' });

  await waitFor(() => Boolean(queue.get(job.id)?.providerTaskId), 5_000);
  const remoteId = queue.get(job.id)!.providerTaskId!;
  await queue.cancel(job.id);
  assert.equal(queue.get(job.id)?.status, 'CANCELLED');
  const before = cur.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM render_jobs')!.n;

  remoteReady = true;
  await queue.retry(job.id);
  await waitFor(() => queue.get(job.id)?.status === 'LOCAL_READY', 5_000);
  const recovered = queue.get(job.id)!;
  assert.equal(recovered.id, job.id);
  assert.equal(recovered.providerTaskId, remoteId);
  assert.equal(cur.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM render_jobs')!.n, before);
  assert.equal(cur.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM takes WHERE shot_id = ?', [shotId])!.n, 1);
  queue.forgetProject(cur.meta.id);
});

test('end-to-end mock render: upload -> success -> take created once', async () => {
  const { root, store } = await makeStore('queue');
  roots.push(root);
  const p = await makeProjectDetached(store, 'e2eP');
  const { shotId, promptVersionId } = makeShotWithPrompt(p, 't2va');
  advanceTo(p, shotId, 'PREFLIGHT_READY');
  const registry = makeRegistry(store.registry, join(root, 'global-mock'));
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
  const registry = makeRegistry(store.registry, join(root, 'global-mock'));
  const queue = makeQueue(store, registry, 999_999);


  const curA = await store.open(pA.meta.id);
  // Seed job A directly as SUBMITTING without a taskId. Going through
  // queue.submit() races the worker: the mock provider returns a taskId
  // synchronously, recover() would then see it as pollable (RUNNING) instead
  // of exercising the "interrupted before submit" branch under test.
  curA.db.run(
    `INSERT INTO render_jobs (id, project_id, shot_id, prompt_version_id, director_plan_version_id, provider, status, request_snapshot_json, render_intent_hash, created_at, updated_at)
     VALUES ('job-a', ?, ?, ?, NULL, 'mock', 'SUBMITTING', '{}', NULL, datetime('now'), datetime('now'))`,
    [pA.meta.id, shotId, promptVersionId],
  );
  advanceTo(curA, shotId, 'RENDERING');
  // simulate a job mid-flight in pB as well (real FK targets)
  pB.db.run(
    `INSERT INTO render_jobs (id, project_id, shot_id, prompt_version_id, director_plan_version_id, provider, status, request_snapshot_json, render_intent_hash, created_at, updated_at)
     VALUES ('job-b', ?, ?, ?, NULL, 'mock', 'QUEUED', '{}', NULL, datetime('now'), datetime('now'))`,
    [pB.meta.id, bShot.shotId, bShot.promptVersionId],
  );
  pB.db.run("UPDATE render_jobs SET provider_task_id = 'mock-b' WHERE id = 'job-b'");
  pA.close(); // current switches below; queue keeps its own detached ctx

  // switch to pB 鈥?recover must pick up pA's pending job even so
  const before = curA.db.get<{ status: string }>("SELECT status FROM render_jobs WHERE id = 'job-a'")!.status;
  await store.open(pB.meta.id);
  await queue.recover();
  const dA = await store.openDetached(pA.meta.id);
  const afterRow = dA.db.get<{ status: string; error: string | null }>("SELECT status, error FROM render_jobs WHERE id = 'job-a'")!;
  dA.close();
  // a job submitted but never polled (no taskId) is NEVER resubmitted on
  // recovery 鈥?it is failed with a retry hint (no double cost)
  assert.equal(afterRow.status, 'FAILED');
  assert.match(afterRow.error ?? '', /retry/);
  assert.ok(before !== afterRow.status); // state actually changed
  const recoveredShot = await store.openDetached(pA.meta.id);
  assert.equal(getShot(recoveredShot, shotId).status, 'PREFLIGHT_READY');
  recoveredShot.close();
  // job-b (with a taskId) is re-enqueued and picked up by the worker 鈥?its
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
  const registry = makeRegistry(store.registry, join(root, 'global-mock'));
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
  // add a valid clip first, THEN demote the take 鈥?export must refuse
  const { selectTake } = await import('../src/modules/takes.js');
  selectTake(cur, take.id);
  const { addClip, exportTimeline } = await import('../src/modules/timeline.js');
  addClip(cur, { shotId, takeId: take.id });
  cur.db.run("UPDATE takes SET status = 'candidate' WHERE id = ?", [take.id]);
  await assert.rejects(() => exportTimeline(cur, new Ffmpeg()), /no longer selected/);
  queue.forgetProject(p.meta.id);
  cur.close();
});

// --- P1 hardening -----------------------------------------------------------

const REQUEST = (promptVersionId: string, durationSeconds = 1) => ({
  provider: 'mock', aiAppId: 'x', mode: 't2va' as const, promptVersionId, durationSeconds, aspectRatio: '16:9', references: [], providerParams: {},
});

/** Provider whose status() hiccups a few times before succeeding 鈥?models a
 * network blip / unrecognized payload during a long paid render. */
class FlakyProvider implements VideoProvider {
  readonly id = 'flaky';
  readonly name = 'flaky';
  readonly configured = true;
  attempts = 0;
  constructor(private readonly failForever = false) {}
  async capabilities() { return { supportedModes: ['t2va' as const] }; }
  async uploadAsset(_a: MediaAsset, _p: string) { return { providerRef: 'x' }; }
  async submit(_r: RenderRequestInput): Promise<RenderJobHandle> { return { providerTaskId: 't1' }; }
  async status(): Promise<RenderStatus> {
    this.attempts++;
    if (this.failForever) return { status: 'RUNNING', transient: true, error: `garbage answer #${this.attempts}` };
    if (this.attempts <= 3) throw new Error('network blip');
    if (this.attempts <= 5) return { status: 'RUNNING', transient: true, error: 'unrecognized task status' };
    return { status: 'SUCCEEDED', resultUrl: `mock://${this.clipPath}` };
  }
  clipPath = '';
  async result(): Promise<RenderResult> { return { url: `mock://${this.clipPath}`, cost: { credits: 0, unit: 'mock' } }; }
  async cancel() {}
}

async function flakyFixture(tag: string, provider: FlakyProvider, pollMs: number) {
  const { root, store } = await makeStore(`queue-${tag}`);
  roots.push(root);
  const p = await makeProjectDetached(store, `${tag}P`);
  const { shotId, promptVersionId } = makeShotWithPrompt(p, 't2va');
  advanceTo(p, shotId, 'PREFLIGHT_READY');
  const registryStub = { get: () => provider } as unknown as ProviderRegistry;
  const queue = new RenderQueue(() => store, registryStub, new Ffmpeg(), bus(), pollMs);
  const cur = await store.open(p.meta.id);
  p.close();
  // A real (tiny) clip so the mock:// download + ffprobe path works. Lives
  // inside the tracked temp root so suite cleanup removes it.
  const clipPath = join(root, 'flaky-clip.mp4');
  await new Ffmpeg().syntheticVideo(clipPath, 0.5, 'flaky');
  provider.clipPath = clipPath;
  return { store, p, cur, queue, shotId, promptVersionId, clipPath };
}

test('polling survives transient provider errors and still delivers the take', async () => {
  const provider = new FlakyProvider(false);
  const { cur, queue, shotId, promptVersionId, clipPath, store, p } = await flakyFixture('recover', provider, 40);
  const job = queue.submit({ projectId: cur.meta.id, shotId, promptVersionId, provider: 'flaky', request: REQUEST(promptVersionId), intentHash: 'h' });
  await waitFor(() => cur.db.get<{ status: string }>('SELECT status FROM render_jobs WHERE id = ?', [job.id])?.status === 'LOCAL_READY', 30_000);
  assert.equal(provider.attempts >= 6, true); // actually went through the hiccup window
  assert.equal(cur.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM takes')!.c, 1);
  assert.equal(getShot(cur, shotId).status, 'HAS_TAKES');
  queue.forgetProject(cur.meta.id);
  cur.close();
  store.registry.close();
  void p;
});

test('sustained unusable provider answers eventually fail the job (no silent hang)', async () => {
  const provider = new FlakyProvider(true);
  const { cur, queue, shotId, promptVersionId } = await flakyFixture('dead', provider, 25);
  const job = queue.submit({ projectId: cur.meta.id, shotId, promptVersionId, provider: 'flaky', request: REQUEST(promptVersionId), intentHash: 'h' });
  await waitFor(() => cur.db.get<{ status: string }>('SELECT status FROM render_jobs WHERE id = ?', [job.id])?.status === 'FAILED', 60_000);
  assert.match(cur.db.get<{ error: string | null }>('SELECT error FROM render_jobs WHERE id = ?', [job.id])?.error ?? '', /consecutive polls/);
  queue.forgetProject(cur.meta.id);
  cur.close();
});

test('double retry cannot create two jobs; retry puts the shot back to RENDERING', async () => {
  const { root, store } = await makeStore('queue-retry-dedupe');
  roots.push(root);
  const p = await makeProjectDetached(store, 'dedupeP');
  const { shotId, promptVersionId } = makeShotWithPrompt(p, 't2va');
  advanceTo(p, shotId, 'PREFLIGHT_READY');
  const registry = makeRegistry(store.registry, join(root, 'global-mock'));
  const queue = makeQueue(store, registry, 999_999);
  const cur = await store.open(p.meta.id);
  p.close();

  const job = queue.submit({ projectId: p.meta.id, shotId, promptVersionId, provider: 'mock', request: REQUEST(promptVersionId), intentHash: 'same' });
  await waitFor(() => cur.db.get<{ status: string }>('SELECT status FROM render_jobs WHERE id = ?', [job.id])?.status !== 'SUBMITTING', 5000);
  cur.db.run("UPDATE render_jobs SET status = 'FAILED', provider_task_id = NULL WHERE id = ?", [job.id]);
  await queue.cancel(job.id);

  const results = await Promise.allSettled([queue.retry(job.id), queue.retry(job.id)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  const jobs = cur.db.all<{ id: string; status: string }>('SELECT id, status FROM render_jobs ORDER BY created_at');
  assert.equal(jobs.length, 2); // original + exactly ONE retry
  await assert.rejects(() => queue.retry(job.id), /already active/); // third attempt blocked while active
  assert.equal(getShot(cur, shotId).status, 'RENDERING');
  queue.forgetProject(p.meta.id);
  cur.close();
});

test('mock render survives switching projects + provider refresh (global task dir)', async () => {
  const { root, store } = await makeStore('queue-switch');
  roots.push(root);
  const pA = await makeProjectDetached(store, 'swA');
  const pB = await makeProjectDetached(store, 'swB');
  const { shotId, promptVersionId } = makeShotWithPrompt(pA, 't2va');
  advanceTo(pA, shotId, 'PREFLIGHT_READY');
  // Global mock workdir like production wiring (index.ts passes config.home).
  const registry = new ProviderRegistry(() => store.current, () => store.registry, new Ffmpeg(), null, 'mock', bus(), join(root, 'global-mock'));
  registry.refresh();
  const queue = makeQueue(store, registry, 100);

  await store.open(pA.meta.id);
  const job = queue.submit({ projectId: pA.meta.id, shotId, promptVersionId, provider: 'mock', request: REQUEST(promptVersionId), intentHash: 'h' });

  // UI switches to project B and providers are rebuilt on open (route behavior)
  await store.open(pB.meta.id);
  registry.refresh();

  await waitFor(() => {
    const s = pA.db.get<{ status: string }>('SELECT status FROM render_jobs WHERE id = ?', [job.id])?.status;
    return s === 'LOCAL_READY';
  }, 30_000);
  assert.equal(pA.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM takes')!.c, 1);
  queue.forgetProject(pA.meta.id);
});

test('deleting a shot with an active job releases the single worker for the next shot', async () => {
  const { root, store } = await makeStore('queue-delete-active');
  roots.push(root);
  const p = await makeProjectDetached(store, 'delete-active');
  const first = makeShotWithPrompt(p, 't2va');
  const second = makeShotWithPrompt(p, 't2va');
  advanceTo(p, first.shotId, 'PREFLIGHT_READY');
  advanceTo(p, second.shotId, 'PREFLIGHT_READY');
  const registry = makeRegistry(store.registry, join(root, 'global-mock'));
  const queue = makeQueue(store, registry, 100);
  const cur = await store.open(p.meta.id);
  p.close();

  const firstJob = queue.submit({
    projectId: cur.meta.id, shotId: first.shotId, promptVersionId: first.promptVersionId, provider: 'mock',
    request: REQUEST(first.promptVersionId, 1), intentHash: 'delete-first',
  });
  await waitFor(() => ['QUEUED', 'RUNNING'].includes(cur.db.get<{ status: string }>('SELECT status FROM render_jobs WHERE id = ?', [firstJob.id])?.status ?? ''), 5000);
  await deleteShotAndFiles(cur, first.shotId);

  const secondJob = queue.submit({
    projectId: cur.meta.id, shotId: second.shotId, promptVersionId: second.promptVersionId, provider: 'mock',
    request: REQUEST(second.promptVersionId, 1), intentHash: 'delete-second',
  });
  await waitFor(() => cur.db.get<{ status: string }>('SELECT status FROM render_jobs WHERE id = ?', [secondJob.id])?.status === 'LOCAL_READY', 15_000);
  assert.equal(getShot(cur, second.shotId).status, 'HAS_TAKES');
  queue.forgetProject(cur.meta.id);
  cur.close();
});
