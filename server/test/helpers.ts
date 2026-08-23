// Shared test helpers: throwaway registry + projects in a temp dir.
// Tests exercise the module layer directly (no HTTP, no network).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db/sqlite.js';
import { REGISTRY_MIGRATIONS, PROJECT_MIGRATIONS } from '../src/db/schema.js';
import { ProjectStore, type ProjectContext } from '../src/project-store.js';
import { migrate } from '../src/db/migrate.js';
import { createShot } from '../src/modules/shots.js';
import { importRawPrompt } from '../src/modules/prompt.js';
import { createTake, selectTake, listTakes } from '../src/modules/takes.js';
import type { Take } from '@h3mise/shared';
import { EventBus } from '../src/events.js';
import type { H3Mode } from '@h3mise/shared';

export function makeTempRoot(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), `h3mise-test-${tag}-`));
  return dir;
}

/** Everything these helpers ever opened. On Windows an unclosed SQLite handle
 * (the registry db, the last `store.current`) keeps `project.db-wal/-shm`
 * locked and makes rmSync fail with EPERM, so cleanup closes them all first. */
const liveStores = new Set<ProjectStore>();
const liveHandles = new Set<{ close(): void }>();
const liveRoots = new Set<string>();

function closeQuietly(handle: { close(): void }): void {
  try {
    handle.close();
  } catch {
    /* already closed */
  }
}

function rmSyncRetry(dir: string, attempts = 6): void {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (attempt >= attempts) throw e;
      // Brief sync pause: antivirus/indexers transiently lock fresh files.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * attempt);
    }
  }
}

/**
 * Close EVERY database handle issued by makeStore/makeProject*, then remove
 * `dir` along with any remaining helper-created roots. Idempotent — safe
 * against double-close and repeated calls. Existing per-file
 * `after(() => roots.forEach(cleanupTempRoot))` hooks work unchanged.
 */
export function cleanupTempRoot(dir?: string): void {
  for (const store of liveStores) {
    // store.current is replaced on every open(); its newest handle is the one
    // tests most often leave behind.
    try {
      store.current?.db.close();
    } catch {
      /* already closed */
    }
  }
  liveStores.clear();
  for (const handle of liveHandles) closeQuietly(handle);
  liveHandles.clear();
  const targets = new Set(liveRoots);
  liveRoots.clear();
  if (dir) targets.add(dir);
  for (const target of targets) rmSyncRetry(target);
}

export async function makeStore(tag: string): Promise<{ root: string; store: ProjectStore }> {
  const root = makeTempRoot(tag);
  const registry = new Db(join(root, 'registry.db'));
  migrate(registry, REGISTRY_MIGRATIONS);
  const store = new ProjectStore(registry, join(root, 'projects'));
  liveRoots.add(root);
  liveStores.add(store);
  liveHandles.add(registry);
  return { root, store };
}

export async function makeProject(store: ProjectStore, title: string): Promise<ProjectContext> {
  await store.create({ title, format: 'single_shot' });
  const meta = (await store.list()).find((m) => m.title === title)!;
  const ctx = await store.open(meta.id);
  liveHandles.add(ctx);
  return ctx;
}

/** Open WITHOUT touching `store.current` (open() closes the previous one). */
export async function makeProjectDetached(store: ProjectStore, title: string): Promise<ProjectContext> {
  await store.create({ title, format: 'single_shot' });
  const meta = (await store.list()).find((m) => m.title === title)!;
  const ctx = await store.openDetached(meta.id);
  liveHandles.add(ctx);
  return ctx;
}

/** Shot with a compiled prompt so preflight/render can run. */
export function makeShotWithPrompt(p: ProjectContext, mode: H3Mode = 't2va'): { shotId: string; promptVersionId: string } {
  const shot = createShot(p, { title: 'Test Shot', durationSeconds: 3 });
  const prompt = importRawPrompt(p, shot.id, 'A test prompt for the invariant suite.', mode);
  return { shotId: shot.id, promptVersionId: prompt.id };
}

/** Insert a fake take (no file, no ffmpeg) tied to a fake render job. */
export async function fakeTake(p: ProjectContext, shotId: string, promptVersionId: string, tag: string): Promise<Take> {
  const jobId = `job-test-${tag}`;
  p.db.run(
    `INSERT INTO render_jobs (id, project_id, shot_id, prompt_version_id, director_plan_version_id, provider, status, request_snapshot_json, render_intent_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'mock', 'FAILED', '{}', 'x', datetime('now'), datetime('now'))`,
    [jobId, p.meta.id, shotId, promptVersionId],
  );
  return createTake(p, {
    shotId,
    renderJobId: jobId,
    promptVersionId,
    directorPlanVersionId: null,
    localVideoPath: `shots/${shotId}/takes/take-${tag}.mp4`,
    duration: 3,
  });
}

export function bus(): EventBus {
  return new EventBus();
}

export type { ProjectContext };
export { listTakes, selectTake };
