// Local HTTP API — PRD §47. Vue never touches SQLite/FFmpeg/RunningHub
// directly; everything goes through these routes over localhost.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { createReadStream, statSync } from 'node:fs';
import { stream, streamSSE } from 'hono/streaming';
import { Readable } from 'node:stream';
import { emptyDirectorPlan } from '@h3mise/shared';
import type { AppEvent, H3Mode } from '@h3mise/shared';
import type { ProjectStore } from '../project-store.js';
import type { EventBus } from '../events.js';
import type { Ffmpeg } from '../ffmpeg.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { RenderQueue } from '../modules/render.js';
import type { AIService } from '../modules/ai.js';
import type { SessionManager } from './security.js';
import { sessionGuard } from './security.js';
import type { JobRunner } from '../modules/jobs.js';
import * as storyMod from '../modules/story.js';
import * as shotsMod from '../modules/shots.js';
import * as assetsMod from '../modules/assets.js';
import * as directorMod from '../modules/director.js';
import * as promptMod from '../modules/prompt.js';
import * as preflightMod from '../modules/preflight.js';
import * as takesMod from '../modules/takes.js';
import * as continuityMod from '../modules/continuity.js';
import * as timelineMod from '../modules/timeline.js';
import * as mediaMod from '../modules/media.js';
import * as aiActions from '../modules/ai-actions.js';
import { serveMedia } from './media-route.js';

export interface AppServices {
  store: ProjectStore;
  bus: EventBus;
  ffmpeg: Ffmpeg;
  providers: ProviderRegistry;
  queue: RenderQueue;
  ai: AIService;
  jobs: JobRunner;
  sessions: SessionManager;
}

type App = Hono<{ Variables: { services: AppServices } }>;

export function buildRoutes(services: AppServices): App {
  const app = new Hono<{ Variables: { services: AppServices } }>();
  app.use('*', async (c, next) => {
    c.set('services', services);
    await next();
  });

  const p = (c: Context) => {
    const ctx = services.store.current;
    if (!ctx) throw new HttpError(409, 'no project open');
    return ctx;
  };

  // --- session / health ----------------------------------------------------

  app.get('/api/session', (c) => {
    const token = services.sessions.issue();
    c.header('Set-Cookie', `h3mise_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
    return c.json({ ok: true });
  });

  app.get('/api/health', async (c) => {
    const caps = await services.ffmpeg.capabilityCheck();
    return c.json({
      ok: true,
      ffmpeg: caps,
      runningHubConfigured: services.providers.get('runninghub')?.configured ?? false,
      aiConfigured: services.ai.status.configured,
      projectOpen: Boolean(services.store.current),
      time: new Date().toISOString(),
    });
  });

  // --- projects ------------------------------------------------------------

  app.get('/api/projects', async (c) => {
    const meta = await services.store.list();
    const out = await Promise.all(
      meta.map(async (m) => {
        let counts = { shotCount: 0, selectedTakeCount: 0 };
        try {
          const db = await services.store.open(m.id);
          counts.shotCount = (db.db.get<{ n: number }>('SELECT COUNT(*) as n FROM shots')?.n ?? 0);
          counts.selectedTakeCount = (db.db.get<{ n: number }>("SELECT COUNT(*) as n FROM takes WHERE status = 'selected'")?.n ?? 0);
        } catch {
          /* unreadable project — keep zeros */
        }
        return { ...m, ...counts };
      }),
    );
    return c.json(out);
  });

  app.post('/api/projects', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const meta = await services.store.create({
      title: String(body.title ?? 'Untitled Project'),
      format: body.format ?? 'single_shot',
      defaultAspectRatio: body.defaultAspectRatio,
      visualStyle: body.visualStyle,
      defaultDurationSeconds: body.defaultDurationSeconds,
    });
    await services.store.open(meta.id);
    services.providers.refresh();
    return c.json(meta, 201);
  });

  app.post('/api/projects/:id/open', async (c) => {
    const meta = await services.store.open(c.req.param('id'));
    services.providers.refresh();
    services.queue.recover();
    return c.json(meta);
  });

  app.post('/api/projects/:id/delete', async (c) => {
    await services.store.delete(c.req.param('id'));
    services.providers.refresh();
    return c.json({ ok: true });
  });

  app.get('/api/current-project', (c) => {
    const ctx = services.store.current;
    if (!ctx) return c.json(null);
    return c.json({ meta: ctx.meta, config: ctx.config });
  });

  app.patch('/api/current-project/config', async (c) => {
    const ctx = p(c);
    const body = await c.req.json().catch(() => ({}));
    ctx.config = { ...ctx.config, ...body };
    await services.store.saveConfig();
    return c.json({ config: ctx.config });
  });

  // --- story ---------------------------------------------------------------

  app.get('/api/story', (c) => c.json(storyMod.getStory(p(c))));
  app.patch('/api/story', async (c) => c.json(storyMod.updateStory(p(c), await c.req.json())));

  app.get('/api/story/sequences', (c) => c.json(storyMod.listSequences(p(c))));
  app.post('/api/story/sequences', async (c) => c.json(storyMod.createSequence(p(c), await c.req.json()), 201));
  app.patch('/api/story/sequences/:id', async (c) => c.json(storyMod.updateSequence(p(c), c.req.param('id'), await c.req.json())));
  app.delete('/api/story/sequences/:id', (c) => {
    storyMod.deleteSequence(p(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/api/story/beats', (c) => c.json(storyMod.listBeats(p(c))));
  app.post('/api/story/beats', async (c) => c.json(storyMod.createBeat(p(c), await c.req.json()), 201));
  app.patch('/api/story/beats/:id', async (c) => c.json(storyMod.updateBeat(p(c), c.req.param('id'), await c.req.json())));
  app.delete('/api/story/beats/:id', (c) => {
    storyMod.deleteBeat(p(c), c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/story/beats/reorder', async (c) => c.json(storyMod.reorderBeats(p(c), (await c.req.json()).ids)));

  // --- shots ---------------------------------------------------------------

  app.get('/api/shots', (c) => {
    const ctx = p(c);
    const shots = shotsMod.listShots(ctx);
    const out = shots.map((s) => {
      const selected = ctx.db.get<{ id: string }>("SELECT id FROM takes WHERE shot_id = ? AND status = 'selected' ORDER BY created_at DESC LIMIT 1", [s.id]);
      const takeCount = ctx.db.get<{ n: number }>('SELECT COUNT(*) as n FROM takes WHERE shot_id = ?', [s.id])!.n;
      const activeJobs = ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) as n FROM render_jobs WHERE shot_id = ? AND status IN ('UPLOADING','SUBMITTING','QUEUED','RUNNING','DOWNLOADING')",
        [s.id],
      )!.n;
      return {
        ...s,
        takeCount,
        selectedTakeId: selected?.id ?? null,
        activeJobs,
        cover: selected
          ? (ctx.db.get<{ poster_path: string | null }>('SELECT poster_path FROM takes WHERE id = ?', [selected.id])?.poster_path ?? null)
          : null,
      };
    });
    return c.json(out);
  });

  app.get('/api/shots/:id', (c) => {
    const ctx = p(c);
    const shot = shotsMod.getShot(ctx, c.req.param('id'));
    return c.json({
      shot,
      plans: directorMod.listPlanVersions(ctx, shot.id),
      prompts: promptMod.listPrompts(ctx, shot.id),
      takes: takesMod.listTakes(ctx, shot.id),
      jobs: services.queue.list(shot.id),
      preflights: preflightMod.listPreflightReports(ctx, shot.id),
      bindings: assetsMod.listBindings(ctx, shot.id),
      requirements: assetsMod.shotAssetRequirements(ctx, shot),
      continuity: continuityMod.listContinuity(ctx, shot.id),
      allBindings: assetsMod.listBindings(ctx),
      entities: assetsMod.listEntities(ctx),
      characterStates: assetsMod.listCharacterStates(ctx),
      sequences: storyMod.listSequences(ctx),
      beats: storyMod.listBeats(ctx),
      continuityLatest: {
        visualActual: continuityMod.latestContinuity(ctx, 'visual', 'actual'),
        visualPlanned: continuityMod.latestContinuity(ctx, 'visual', 'planned'),
        narrative: continuityMod.latestContinuity(ctx, 'narrative', 'actual'),
      },
    });
  });

  app.post('/api/shots', async (c) => c.json(shotsMod.createShot(p(c), await c.req.json()), 201));
  app.post('/api/shots/bulk', async (c) => c.json(shotsMod.bulkCreateShots(p(c), (await c.req.json()).items ?? []), 201));
  app.patch('/api/shots/:id', async (c) => c.json(shotsMod.updateShot(p(c), c.req.param('id'), await c.req.json())));
  app.delete('/api/shots/:id', (c) => {
    shotsMod.deleteShot(p(c), c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/shots/:id/status', async (c) => {
    const { status } = await c.req.json();
    const shot = shotsMod.advanceShotStatus(p(c), c.req.param('id'), status);
    services.bus.emit({ type: 'shot.updated', shotId: shot.id, status: shot.status });
    return c.json(shot);
  });
  app.post('/api/shots/reorder', async (c) => c.json(shotsMod.reorderShots(p(c), (await c.req.json()).ids)));

  // --- director ------------------------------------------------------------

  app.post('/api/shots/:id/plans', async (c) => {
    const ctx = p(c);
    const body = await c.req.json();
    const plan = body.plan ?? emptyDirectorPlan();
    const version = directorMod.createPlanVersion(ctx, {
      shotId: c.req.param('id'),
      plan,
      source: body.source ?? 'manual',
    });
    services.bus.emit({ type: 'shot.updated', shotId: version.shotId, status: shotsMod.getShot(ctx, version.shotId).status });
    return c.json(version, 201);
  });

  app.post('/api/shots/:id/plans/parse', async (c) => {
    const { text } = await c.req.json();
    const result = directorMod.parseDirectorPlanText(String(text ?? ''));
    return c.json(result);
  });

  app.post('/api/shots/:id/context-package', async (c) => {
    const { task } = await c.req.json();
    return c.json(promptMod.buildContextPackage(p(c), c.req.param('id'), String(task ?? 'Plan this shot')));
  });

  // --- prompt --------------------------------------------------------------

  app.get('/api/shots/:id/prompts', (c) => c.json(promptMod.listPrompts(p(c), c.req.param('id'))));
  app.post('/api/shots/:id/prompts/compile', async (c) => {
    const ctx = p(c);
    const shotId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const mode = (body.mode as H3Mode) ?? shotsMod.getShot(ctx, shotId).h3Mode ?? 't2va';
    return c.json(promptMod.compilePrompt(ctx, shotId, mode, body.durationSeconds), 201);
  });
  app.post('/api/shots/:id/prompts/raw', async (c) => {
    const body = await c.req.json();
    return c.json(promptMod.importRawPrompt(p(c), c.req.param('id'), String(body.text ?? ''), body.mode ?? 't2va'), 201);
  });

  // --- preflight -----------------------------------------------------------

  app.post('/api/shots/:id/preflight', async (c) => {
    const ctx = p(c);
    const shotId = c.req.param('id');
    const body = await c.req.json();
    const report = await preflightMod.runBasicPreflight(ctx, services.providers, {
      shotId,
      promptVersionId: String(body.promptVersionId ?? promptMod.listPrompts(ctx, shotId).at(-1)?.id ?? ''),
      providerId: String(body.providerId ?? 'runninghub'),
    });
    return c.json(report, 201);
  });

  // --- render --------------------------------------------------------------

  app.post('/api/render', async (c) => {
    const ctx = p(c);
    const body = await c.req.json();
    const shotId = String(body.shotId);
    const promptVersionId = String(body.promptVersionId);
    const providerId = String(body.providerId ?? 'runninghub');
    // No hidden paid actions: basic preflight gates every submission.
    const preflight = await preflightMod.runBasicPreflight(ctx, services.providers, { shotId, promptVersionId, providerId });
    if (preflight.blocked) {
      return c.json({ error: 'preflight blocked', preflight }, 422);
    }
    const prompt = promptMod.getPrompt(ctx, promptVersionId);
    const shot = shotsMod.getShot(ctx, shotId);
    const request = {
      provider: providerId,
      aiAppId: body.aiAppId ?? '2089265538441764866',
      mode: prompt.h3Mode,
      promptVersionId,
      durationSeconds: Number(body.durationSeconds ?? shot.durationSeconds),
      aspectRatio: String(body.aspectRatio ?? shot.aspectRatio),
      resolution: body.resolution,
      references: ctx.db
        .all<{ id: string; asset_id: string; type: string }>('SELECT * FROM reference_bindings WHERE shot_id = ?', [shotId])
        .map((r) => ({ bindingId: r.id, assetId: r.asset_id, kind: r.type as 'image' | 'video' | 'audio' })),
      providerParams: body.providerParams ?? {},
    };
    const job = services.queue.submit({ shotId, promptVersionId, provider: providerId, request });
    return c.json(job, 201);
  });

  app.get('/api/render', (c) => {
    const shotId = c.req.query('shotId');
    return c.json(services.queue.list(shotId || undefined));
  });
  app.get('/api/render/:id', (c) => {
    const job = services.queue.get(c.req.param('id'));
    return job ? c.json(job) : c.json({ error: 'job not found' }, 404);
  });
  app.post('/api/render/:id/cancel', (c) => {
    services.queue.cancel(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/render/:id/retry', (c) => {
    services.queue.retry(c.req.param('id'));
    return c.json({ ok: true });
  });

  // --- takes ---------------------------------------------------------------

  app.get('/api/takes/:id', (c) => c.json(takesMod.getTake(p(c), c.req.param('id'))));
  app.patch('/api/takes/:id', async (c) => c.json(takesMod.updateTake(p(c), c.req.param('id'), await c.req.json())));
  app.post('/api/takes/:id/select', (c) => c.json(takesMod.selectTake(p(c), c.req.param('id'), services.bus)));
  app.post('/api/takes/:id/reject', (c) => c.json(takesMod.rejectTake(p(c), c.req.param('id'))));
  app.post('/api/takes/:id/select-commit', async (c) => {
    const ctx = p(c);
    const body = await c.req.json();
    const state = body.state ?? continuityMod.emptyVisualState();
    return c.json(continuityMod.selectTakeAndCommit(ctx, c.req.param('id'), state, services.bus));
  });

  // --- continuity ----------------------------------------------------------

  app.get('/api/continuity', (c) => {
    const shotId = c.req.query('shotId');
    return c.json(continuityMod.listContinuity(p(c), shotId || undefined));
  });
  app.post('/api/continuity/commit', async (c) => {
    const body = await c.req.json();
    return c.json(continuityMod.commitContinuity(p(c), body, services.bus), 201);
  });
  app.get('/api/continuity/latest', (c) => {
    const { scope, kind } = c.req.query();
    return c.json(continuityMod.latestContinuity(p(c), (scope ?? 'visual') as 'visual' | 'narrative', (kind ?? 'actual') as 'planned' | 'actual'));
  });

  // --- timeline ------------------------------------------------------------

  app.get('/api/timeline', (c) => c.json(timelineMod.getTimeline(p(c))));
  app.post('/api/timeline/clips', async (c) => c.json(timelineMod.addClip(p(c), await c.req.json()), 201));
  app.patch('/api/timeline/clips/:id', async (c) => c.json(timelineMod.updateClip(p(c), c.req.param('id'), await c.req.json())));
  app.delete('/api/timeline/clips/:id', (c) => {
    timelineMod.removeClip(p(c), c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/timeline/clips/reorder', async (c) => c.json(timelineMod.reorderClips(p(c), (await c.req.json()).ids)));
  app.post('/api/timeline/export', async (c) => {
    const ctx = p(c);
    const body = await c.req.json().catch(() => ({}));
    const job = services.jobs.start('timeline.export', 'Timeline export', async (update) => {
      update({ message: 'trimming clips' });
      const result = await timelineMod.exportTimeline(ctx, services.ffmpeg, body.title);
      update({ progress: 1, message: 'done' });
      return { ...result, url: `/api/file/${encodeURIComponent(result.relPath)}` };
    });
    return c.json({ jobId: job.id, status: job.status }, 202);
  });

  // --- assets --------------------------------------------------------------

  app.get('/api/assets/entities', (c) => c.json(assetsMod.listEntities(p(c), c.req.query('kind') as never)));
  app.post('/api/assets/entities', async (c) => c.json(assetsMod.createEntity(p(c), await c.req.json()), 201));
  app.patch('/api/assets/entities/:id', async (c) => c.json(assetsMod.updateEntity(p(c), c.req.param('id'), await c.req.json())));
  app.delete('/api/assets/entities/:id', (c) => {
    assetsMod.deleteEntity(p(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/api/assets/character-states', (c) => c.json(assetsMod.listCharacterStates(p(c), c.req.query('characterId'))));
  app.post('/api/assets/character-states', async (c) => c.json(assetsMod.createCharacterState(p(c), await c.req.json()), 201));
  app.patch('/api/assets/character-states/:id', async (c) => c.json(assetsMod.updateCharacterState(p(c), c.req.param('id'), await c.req.json())));
  app.delete('/api/assets/character-states/:id', (c) => {
    assetsMod.deleteCharacterState(p(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/api/assets/media', (c) => c.json(assetsMod.listMedia(p(c), c.req.query('kind') as never)));

  app.post('/api/assets/media/upload', async (c) => {
    const ctx = p(c);
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return c.json({ error: 'missing file' }, 400);
    const buf = Buffer.from(await file.arrayBuffer());
    const asset = await mediaMod.importUpload(ctx, services.ffmpeg, {
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      data: buf,
      label: (form.get('label') as string | null) ?? undefined,
    });
    services.bus.emit({ type: 'project.updated' });
    return c.json(asset, 201);
  });

  app.post('/api/assets/media/import-path', async (c) => {
    const body = await c.req.json();
    const asset = await mediaMod.importPath(p(c), services.ffmpeg, { path: String(body.path ?? ''), label: body.label });
    services.bus.emit({ type: 'project.updated' });
    return c.json(asset, 201);
  });

  app.post('/api/assets/media/:id/extract-frame', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const asset = await mediaMod.extractFrameAsset(p(c), services.ffmpeg, {
      assetId: c.req.param('id'),
      atSeconds: Number(body.atSeconds ?? 0),
      label: body.label,
    });
    services.bus.emit({ type: 'project.updated' });
    return c.json(asset, 201);
  });

  app.patch('/api/assets/media/:id', async (c) => c.json(assetsMod.updateMediaLabel(p(c), c.req.param('id'), await c.req.json())));
  app.delete('/api/assets/media/:id', (c) => {
    assetsMod.deleteMedia(p(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/api/assets/bindings', (c) => c.json(assetsMod.listBindings(p(c), c.req.query('shotId') ?? null)));
  app.post('/api/assets/bindings', async (c) => c.json(assetsMod.createBinding(p(c), await c.req.json()), 201));
  app.patch('/api/assets/bindings/:id', async (c) => c.json(assetsMod.updateBinding(p(c), c.req.param('id'), await c.req.json())));
  app.delete('/api/assets/bindings/:id', (c) => {
    assetsMod.deleteBinding(p(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  // --- media file serving --------------------------------------------------

  app.get('/api/media/:id', (c) => serveMedia(p(c), c));

  // Take video playback (Range-supported, for Take Review / A-B compare).
  app.get('/api/takes/:id/video', (c) => {
    const ctx = p(c);
    const take = takesMod.getTake(ctx, c.req.param('id'));
    let abs: string;
    try {
      abs = ctx.resolveProjectPath(take.localVideoPath);
    } catch {
      return c.json({ error: 'invalid take path' }, 400);
    }
    return serveLocalFile(c, abs);
  });

  // --- exported files (timeline exports etc.) ------------------------------

  app.get('/api/file/*', (c) => {
    const ctx = p(c);
    const rel = c.req.path.slice('/api/file/'.length);
    if (!rel) return c.json({ error: 'missing path' }, 400);
    let abs: string;
    try {
      abs = ctx.resolveProjectPath(decodeURIComponent(rel));
    } catch {
      return c.json({ error: 'invalid path' }, 400);
    }
    return serveLocalFile(c, abs);
  });

  // --- provider ------------------------------------------------------------

  app.get('/api/providers', async (c) => c.json(await services.providers.statuses()));
  app.get('/api/providers/runninghub/profile', (c) => c.json(services.providers.getProfile()));
  app.put('/api/providers/runninghub/profile', async (c) => {
    const profile = services.providers.saveProfile(await c.req.json());
    services.bus.emit({ type: 'project.updated' });
    return c.json(profile);
  });
  app.post('/api/providers/runninghub/verify', async (c) => {
    const profile = await services.providers.detectAndVerify();
    services.bus.emit({ type: 'project.updated' });
    return c.json(profile);
  });

  // --- AI (optional) -------------------------------------------------------

  app.get('/api/ai/status', (c) => c.json({ ...services.ai.status, skills: services.ai.skillsDir }));
  app.get('/api/ai/skills', async (c) => c.json(await services.ai.loadSkills()));
  app.post('/api/ai/actions/:action', async (c) => {
    const ctx = p(c);
    const body = await c.req.json();
    const action = c.req.param('action');
    const job = services.jobs.start('ai.action', `AI: ${action}`, async (update) => {
      update({ message: 'asking the model…' });
      const out = await aiActions.runAction(services.ai, ctx, action, body);
      update({ message: 'done' });
      return out;
    });
    return c.json({ jobId: job.id, status: job.status }, 202);
  });
  app.post('/api/ai/chat', async (c) => {
    const body = await c.req.json();
    return c.json({ text: await services.ai.complete(body.messages ?? []) });
  });

  // --- background jobs ----------------------------------------------------

  app.get('/api/jobs', (c) => c.json(services.jobs.list()));
  app.get('/api/jobs/:id', (c) => {
    const job = services.jobs.get(c.req.param('id')!);
    return job ? c.json(job) : c.json({ error: 'job not found' }, 404);
  });

  // --- SSE ----------------------------------------------------------------

  app.get('/api/events', (c) => {
    return streamSSE(c, async (stream) => {
      const off = services.bus.on((e) => {
        void stream.writeSSE({ data: JSON.stringify(e) });
      });
      stream.onAbort(() => off());
      while (true) {
        await stream.sleep(20_000);
      }
    });
  });

  // --- local shutdown (session-guarded; used by the UI and tooling) --------

  app.post('/api/system/shutdown', (c) => {
    setTimeout(() => process.exit(0), 100).unref();
    return c.json({ ok: true });
  });

  // --- error handling ------------------------------------------------------

  app.notFound((c) => c.json({ error: `not found: ${c.req.method} ${c.req.path}` }, 404));

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400);
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  });

  return app;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function serveLocalFile(c: Context, abs: string): Response {
  let st;
  try {
    st = statSync(abs);
  } catch {
    return c.json({ error: 'file not found' }, 404);
  }
  if (!st.isFile()) return c.json({ error: 'not a file' }, 400);
  const ext = abs.split('.').pop()?.toLowerCase() ?? '';
  const mime: Record<string, string> = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    json: 'application/json',
    txt: 'text/plain',
    md: 'text/markdown',
  };
  const range = c.req.header('range');
  c.header('Content-Type', mime[ext] ?? 'application/octet-stream');
  c.header('Accept-Ranges', 'bytes');
  c.header('Content-Length', String(st.size));
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (isNaN(start)) {
        const n = parseInt(m[2] ?? '0', 10);
        start = Math.max(0, st.size - n);
        end = st.size - 1;
      }
      end = Math.min(end, st.size - 1);
      if (start > end || start >= st.size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}` } });
      }
      c.status(206);
      c.header('Content-Range', `bytes ${start}-${end}/${st.size}`);
      c.header('Content-Length', String(end - start + 1));
      return new Response(Readable.toWeb(createReadStream(abs, { start, end })), { status: 206 });
    }
  }
  return new Response(Readable.toWeb(createReadStream(abs)), { status: 200 });
}
