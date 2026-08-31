// H3Mise local server entry — PRD §42 startup order:
// 1. Node local server   2. SQLite init/migration   3. RenderQueue recovery
// 4. web (dev via Vite | prod via dist)   5. optional auto-open browser.

import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { openRegistry } from './project-store.js';
import { EventBus } from './events.js';
import { Ffmpeg } from './ffmpeg.js';
import { ProviderRegistry } from './providers/registry.js';
import { RenderQueue } from './modules/render.js';
import { AIService } from './modules/ai.js';
import { JobRunner } from './modules/jobs.js';
import { buildApp } from './http/app.js';
import { SessionManager } from './http/security.js';
import { join } from 'node:path';
import { AutoProduceService } from './modules/auto-produce.js';

async function main(): Promise<void> {
  const config = loadConfig();
  console.log('┌─────────────────────────────────────────────────────┐');
  console.log('│  H3Mise — local director workstation for MiniMax H3 │');
  console.log('└─────────────────────────────────────────────────────┘');
  console.log(`  home:        ${config.home}`);
  console.log(`  provider:    ${config.providerMode === 'mock' ? 'mock (offline)' : 'runninghub'}${config.runningHubApiKey ? ' (key present)' : ' (no RUNNINGHUB_API_KEY)'}`);
  console.log(`  AI:          ${config.ai.baseUrl ? `configured (${config.ai.model})` : 'not configured — AI-optional mode'}`);

  const { store } = await openRegistry(config);
  const bus = new EventBus();
  const ffmpeg = new Ffmpeg();
  const caps = await ffmpeg.capabilityCheck();
  if (!caps.available) {
    console.warn('  ⚠ ffmpeg/ffprobe not found — frame extraction and export disabled');
  } else {
    console.log(`  ffmpeg:      ${caps.ffmpegVersion}`);
  }

  const registry = new ProviderRegistry(
    () => store.current,
    () => store.registry,
    ffmpeg,
    config.runningHubApiKey,
    config.providerMode,
    bus,
    // P1: mock renders keep their task state under the global home dir so a
    // project switch (providers.refresh()) cannot orphan an in-flight render.
    config.home,
  );
  const queue = new RenderQueue(() => store, registry, ffmpeg, bus);
  const jobs = new JobRunner(bus);
  const ai = new AIService(config.ai, join(config.home, 'skills'));
  const sessions = new SessionManager();
  const auto = new AutoProduceService(() => store, registry, queue, ffmpeg, bus);

  // Restore the last opened project (auto-recovery, PRD §49).
  const lastId = store.registry.get<{ value: string }>("SELECT value FROM kv WHERE key = 'last_project_id'")?.value;
  if (lastId) {
    try {
      const meta = await store.open(lastId);
      console.log(`  project:     reopened "${meta.config.title}" (${meta.meta.id})`);
    } catch (e) {
      console.warn('  ⚠ could not reopen last project:', e instanceof Error ? e.message : e);
    }
  }
  registry.refresh();
  // Recover active jobs of every project (P0-1); recovery is independent of
  // which project the UI reopens.
  await queue.recover();
  console.log('  queue:       recovered pending render jobs');
  await auto.resumeAll();

  const app = buildApp(
    {
      store,
      bus,
      ffmpeg,
      providers: registry,
      queue,
      ai,
      jobs,
      sessions,
      auto,
    },
    config.webDist,
  );

  const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' });
  console.log(`\n  H3Mise API server running at http://127.0.0.1:${config.port}`);
  if (!config.webDist) {
    console.log('  (API only — UI runs on Vite: http://localhost:5173)');
  } else {
    console.log('  (serving built UI — disable with H3MISE_SERVE_WEB=0)');
  }

  // Persist which project was open so restart reopens it.
  const origOpen = store.open.bind(store);
  store.open = async (id: string) => {
    const ctx = await origOpen(id);
    store.registry.run("INSERT INTO kv (key, value) VALUES ('last_project_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [id]);
    return ctx;
  };
  if (store.current) {
    store.registry.run("INSERT INTO kv (key, value) VALUES ('last_project_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [store.current.meta.id]);
  }

  const shutdown = () => {
    console.log('\n  shutting down…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
