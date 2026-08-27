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
import { enabledBindingSlots, type ProviderRegistry } from '../providers/registry.js';
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
import * as guideMod from '../modules/guide.js';
import { serveMedia } from './media-route.js';
import { createKeyedMutex } from '../modules/mutex.js';
import { BibleFormatError, importBible } from '../modules/import-bible.js';
import { parseByteRange } from './range.js';

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
  const requestProjects = new WeakMap<Context, import('../project-store.js').ProjectContext | null>();
  app.use('*', async (c, next) => {
    c.set('services', services);
    const leased = c.req.path === '/api/events' ? null : services.store.current;
    requestProjects.set(c, leased);
    leased?.retain();
    try {
      await next();
    } finally {
      leased?.release();
      requestProjects.delete(c);
    }
  });

  const p = (c: Context) => {
    const ctx = requestProjects.get(c) ?? services.store.current;
    if (!ctx) throw new HttpError(409, 'no project open');
    return ctx;
  };

  // Serializes preflight→submit per shot (see POST /api/render).
  const renderGate = createKeyedMutex();
  // The desktop server has one process-wide interactive project. Serialize
  // open/create decisions so two tabs cannot both observe an unlocked state
  // and silently replace each other's project.
  const projectSwitchGate = createKeyedMutex();

  const projectLocked = (c: Context, requestedProjectId?: string) => {
    const current = services.store.current;
    return c.json({
      error: '当前项目还在进行',
      code: 'PROJECT_LOCKED',
      currentProject: current ? { id: current.meta.id, title: current.config.title } : null,
      requestedProjectId,
    }, 409);
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
      runningHubConfigured: services.providers.runningHubKeyPresent,
      providerMode: services.providers.providerMode,
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
        let counts = { shotCount: 0, selectedTakeCount: 0, guide: undefined as ReturnType<typeof guideMod.projectGuideSummary> | undefined };
        // openDetached never switches the current project (P0-1).
        let ctx: import('../project-store.js').ProjectContext | null = null;
        try {
          ctx = await services.store.openDetached(m.id);
          counts.shotCount = (ctx.db.get<{ n: number }>('SELECT COUNT(*) as n FROM shots')?.n ?? 0);
          counts.selectedTakeCount = (ctx.db.get<{ n: number }>("SELECT COUNT(*) as n FROM takes WHERE status = 'selected'")?.n ?? 0);
          counts.guide = guideMod.projectGuideSummary(ctx);
        } catch {
          /* unreadable project — keep zeros */
        } finally {
          ctx?.close();
        }
        return { ...m, ...counts };
      }),
    );
    return c.json(out);
  });

  app.post('/api/projects', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (body.format !== undefined && !['single_shot', 'sequence', 'story'].includes(String(body.format))) return c.json({ error: 'invalid project format' }, 400);
    if (body.defaultAspectRatio !== undefined && !/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(String(body.defaultAspectRatio))) return c.json({ error: 'invalid defaultAspectRatio' }, 400);
    const requestedDuration = body.defaultDurationSeconds === undefined ? undefined : Number(body.defaultDurationSeconds);
    if (requestedDuration !== undefined && (!Number.isFinite(requestedDuration) || requestedDuration <= 0)) return c.json({ error: 'invalid defaultDurationSeconds' }, 400);
    return projectSwitchGate('interactive-project', async () => {
      if (services.store.current && body.force !== true) return projectLocked(c);
      const meta = await services.store.create({
        title: String(body.title ?? 'Untitled Project'),
        format: body.format ?? 'single_shot',
        defaultAspectRatio: body.defaultAspectRatio,
        visualStyle: body.visualStyle,
        defaultDurationSeconds: requestedDuration,
      });
      await services.store.open(meta.id);
      services.providers.refresh();
      return c.json(meta, 201);
    });
  });

  app.post('/api/projects/demo', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { force?: boolean; demoId?: string };
    return projectSwitchGate('interactive-project', async () => {
      if (services.store.current && body.force !== true) return projectLocked(c);
      const meta = await services.store.installBundledDemo(body.demoId ?? 'last-film-reel');
      await services.store.open(meta.id);
      services.providers.refresh();
      return c.json(meta, 201);
    });
  });

  app.post('/api/projects/:id/open', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({})) as { force?: boolean };
    return projectSwitchGate('interactive-project', async () => {
      const current = services.store.current;
      if (current?.meta.id === id) return c.json(current.meta);
      if (current && body.force !== true) return projectLocked(c, id);
      const opened = await services.store.open(id);
      services.providers.refresh();
      await services.queue.recover();
      return c.json(opened.meta);
    });
  });

  // --- import (h3mise-bible@1) ---------------------------------------------

  app.post('/api/import/bible', async (c) => {
    const body = await c.req.json().catch(() => null);
    try {
      const result = await importBible(services.store, services.ffmpeg, body);
      services.providers.refresh();
      services.bus.emit({ type: 'project.updated' });
      return c.json(result, 201);
    } catch (e) {
      if (e instanceof BibleFormatError) return c.json({ error: e.message }, 400);
      if (e instanceof Error && 'bibleProjectId' in e) {
        const partial = e as Error & { bibleProjectId?: string; bibleWarnings?: string[] };
        return c.json({ error: partial.message, partialProjectId: partial.bibleProjectId, warnings: partial.bibleWarnings ?? [] }, 500);
      }
      throw e;
    }
  });

  app.post('/api/projects/:id/delete', async (c) => {
    const id = c.req.param('id');
    let ctx: import('../project-store.js').ProjectContext | null = null;
    let ownsContext = false;
    try {
      if (services.store.current?.meta.id === id) ctx = services.store.current;
      else {
        ctx = await services.store.openDetached(id);
        ownsContext = true;
      }
      const activeJobs = ctx.db.all<{ id: string }>(
        "SELECT id FROM render_jobs WHERE status IN ('UPLOADING','SUBMITTING','QUEUED','RUNNING','DOWNLOADING')",
      );
      await Promise.all(activeJobs.map((job) => services.queue.cancel(job.id)));
    } catch {
      // Missing/unreadable projects are still safe to remove from the registry.
    } finally {
      if (ownsContext) ctx?.close();
    }
    services.queue.forgetProject(id);
    await services.store.delete(id);
    services.providers.refresh();
    return c.json({ ok: true });
  });

  app.get('/api/current-project', (c) => {
    const ctx = services.store.current;
    if (!ctx) return c.json(null);
    return c.json({ meta: ctx.meta, config: ctx.config });
  });

  app.get('/api/guide/project', (c) => c.json(guideMod.projectGuideSummary(p(c))));

  app.patch('/api/current-project/config', async (c) => {
    const ctx = p(c);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    // P2: whitelist — arbitrary keys must not be persisted into project.json.
    const allowed: Array<keyof typeof ctx.config> = ['title', 'format', 'default_aspect_ratio', 'visual_style', 'default_duration_seconds'];
    const patch: Record<string, unknown> = {};
    for (const key of allowed) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    if (typeof patch.title === 'string' && !patch.title.trim()) delete patch.title;
    if (patch.format !== undefined && !['single_shot', 'sequence', 'story'].includes(String(patch.format))) {
      return c.json({ error: 'invalid project format' }, 400);
    }
    if (patch.default_aspect_ratio !== undefined && !/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(String(patch.default_aspect_ratio))) {
      return c.json({ error: 'invalid default_aspect_ratio' }, 400);
    }
    const duration = Number(patch.default_duration_seconds);
    if (patch.default_duration_seconds !== undefined && (!Number.isFinite(duration) || duration <= 0)) delete patch.default_duration_seconds;
    // Propagate a changed project default only to shots still ON the old
    // default — per-shot customizations are kept.
    if (typeof patch.default_aspect_ratio === 'string' && patch.default_aspect_ratio !== ctx.config.default_aspect_ratio) {
      const now = new Date().toISOString();
      ctx.db.run('UPDATE shots SET aspect_ratio = ?, updated_at = ? WHERE aspect_ratio = ?', [
        patch.default_aspect_ratio,
        now,
        ctx.config.default_aspect_ratio,
      ]);
    }
    ctx.config = { ...ctx.config, ...patch } as typeof ctx.config;
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
  app.patch('/api/story/beats/:id', async (c) => {
    const ctx = p(c);
    const id = c.req.param('id');
    const body = (await c.req.json()) as { durationSeconds?: number };
    const before = ctx.db.get<{ duration_seconds: number }>('SELECT duration_seconds FROM story_beats WHERE id = ?', [id]);
    const updated = storyMod.updateBeat(ctx, id, body);
    // Propagate beat duration to linked shots — but only those that still
    // mirror the beat's old duration. A shot manually set to a different
    // length is an intentional override and must not be clobbered.
    if (
      before &&
      body.durationSeconds !== undefined &&
      Number.isFinite(Number(body.durationSeconds)) &&
      Number(body.durationSeconds) > 0 &&
      Number(body.durationSeconds) !== before.duration_seconds
    ) {
      const mirrored = ctx.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM shots WHERE story_beat_id = ? AND duration_seconds = ?',
        [id, before.duration_seconds],
      )?.n ?? 0;
      const linked = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM shots WHERE story_beat_id = ?', [id])?.n ?? 0;
      ctx.db.run(
        'UPDATE shots SET duration_seconds = ?, updated_at = ? WHERE story_beat_id = ? AND duration_seconds = ?',
        [Number(body.durationSeconds), new Date().toISOString(), id, before.duration_seconds],
      );
      return c.json({ ...updated, shotsSynced: mirrored, shotsSkipped: linked - mirrored });
    }
    return c.json(updated);
  });
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
      // PRD §9 card fields: missing-asset hint + latest preflight risk flag.
      const missing = assetsMod
        .shotAssetRequirements(ctx, s)
        .filter((r) => r.level === 'required')
        .map((r) => r.label);
      const risk =
        ctx.db.get<{ risk: string }>('SELECT risk FROM preflight_reports WHERE shot_id = ? ORDER BY created_at DESC LIMIT 1', [s.id])?.risk ?? null;
      return {
        ...s,
        takeCount,
        selectedTakeId: selected?.id ?? null,
        activeJobs,
        missing,
        risk,
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
    assetsMod.ensureShotEntityImageBindings(ctx, shot);
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
      guide: guideMod.shotGuidePayload(ctx, shot),
    });
  });

  app.post('/api/shots', async (c) => {
    const ctx = p(c);
    const shot = shotsMod.createShot(ctx, await c.req.json());
    assetsMod.ensureShotEntityImageBindings(ctx, shot);
    return c.json(shot, 201);
  });
  app.post('/api/shots/bulk', async (c) => {
    const ctx = p(c);
    const shots = shotsMod.bulkCreateShots(ctx, (await c.req.json()).items ?? []);
    for (const shot of shots) assetsMod.ensureShotEntityImageBindings(ctx, shot);
    return c.json(shots, 201);
  });
  app.patch('/api/shots/:id', async (c) => {
    const ctx = p(c);
    const shot = shotsMod.updateShot(ctx, c.req.param('id'), await c.req.json());
    assetsMod.ensureShotEntityImageBindings(ctx, shot);
    return c.json(shot);
  });
  app.delete('/api/shots/:id', async (c) => {
    const ctx = p(c);
    const shotId = c.req.param('id');
    const activeJobs = ctx.db.all<{ id: string }>(
      "SELECT id FROM render_jobs WHERE shot_id = ? AND status IN ('UPLOADING','SUBMITTING','QUEUED','RUNNING','DOWNLOADING')",
      [shotId],
    );
    await Promise.all(activeJobs.map((job) => services.queue.cancel(job.id)));
    await shotsMod.deleteShotAndFiles(ctx, shotId);
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

  app.get('/api/shots/:id/plans', (c) => c.json(directorMod.listPlanVersions(p(c), c.req.param('id')!)));

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
    return c.json(promptMod.buildContextPackage(p(c), c.req.param('id'), String(task ?? 'Plan this shot'), services.providers.getProfile()));
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
    const source = body.source === 'ai_compiler' ? 'ai_compiler' : 'manual';
    return c.json(promptMod.importRawPrompt(p(c), c.req.param('id'), String(body.text ?? ''), body.mode ?? 't2va', source), 201);
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
      megapixels: body.megapixels !== undefined ? Number(body.megapixels) : undefined,
    });
    return c.json(report, 201);
  });
  app.patch('/api/preflight/:id/semantic', async (c) => {
    const body = await c.req.json();
    return c.json(preflightMod.attachSemanticReview(p(c), c.req.param('id'), String(body.text ?? '')));
  });

  // --- render --------------------------------------------------------------

  app.post('/api/render', async (c) => {
    const ctx = p(c);
    const body = await c.req.json();
    const shotId = String(body.shotId);
    const promptVersionId = String(body.promptVersionId);
    const providerId = String(body.providerId ?? 'runninghub');
    // P0-2: build the EXACT render intent (client overrides included), gate
    // on that intent, and only then submit. The intent hash is persisted on
    // the job so any later re-submission can be audited against it.
    // P1: the whole gate+submit sequence is serialized per shot — preflight's
    // duplicate check and the INSERT are separated by awaits, so two
    // overlapping requests (double-click, multi-tab, different params) used to
    // be able to pass the gate twice and double-charge.
    return renderGate(`render:${ctx.meta.id}:${shotId}`, async () => {
      const intent = await preflightMod.intentFromInput(ctx, services.providers, {
        shotId,
        promptVersionId,
        providerId,
        durationSeconds: body.durationSeconds !== undefined ? Number(body.durationSeconds) : undefined,
        aspectRatio: body.aspectRatio !== undefined ? String(body.aspectRatio) : undefined,
        resolution: body.resolution,
        megapixels: body.megapixels !== undefined ? Number(body.megapixels) : undefined,
        providerParams: body.providerParams ?? {},
      });
      const preflight = await preflightMod.runBasicPreflightIntent(ctx, services.providers, intent);
      if (preflight.blocked) {
        const reasons = preflight.basic
          .flatMap((section) => section.checks)
          .filter((check) => check.severity === 'error')
          .map((check) => check.message);
        return c.json({
          error: reasons.length ? `生成检查未通过：${reasons.join('；')}` : '生成检查未通过，请查看检查结果',
          preflight,
        }, 422);
      }
      const profile = services.providers.getProfile();
      const intentHash = preflightMod.renderIntentHash(intent, { appId: profile?.appId ?? '', checkedAt: profile?.verification.checkedAt ?? null });
      const request = {
        provider: providerId,
        aiAppId: body.aiAppId ?? '2089265538441764866',
        mode: intent.mode,
        promptVersionId,
        durationSeconds: intent.durationSeconds,
        aspectRatio: intent.aspectRatio,
        resolution: intent.resolution,
        megapixels: intent.megapixels,
        references: intent.references,
        providerParams: intent.providerParams,
      };
      let job;
      try {
        job = services.queue.submit({ projectId: ctx.meta.id, shotId, promptVersionId, provider: providerId, request, intentHash });
      } catch (e) {
        if (e instanceof Error && /already active/.test(e.message)) {
          return c.json({ error: e.message }, 409);
        }
        throw e;
      }
      return c.json(job, 201);
    });
  });

  app.get('/api/render', (c) => {
    const shotId = c.req.query('shotId');
    return c.json(services.queue.list(shotId || undefined));
  });
  app.get('/api/render/:id', (c) => {
    const job = services.queue.get(c.req.param('id'));
    return job ? c.json(job) : c.json({ error: 'job not found' }, 404);
  });
  app.post('/api/render/:id/cancel', async (c) => {
    // cancel is best-effort and never throws (see RenderQueue.cancel).
    await services.queue.cancel(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/render/:id/retry', async (c) => {
    try {
      await services.queue.retry(c.req.param('id'));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
    }
    return c.json({ ok: true });
  });

  // --- takes ---------------------------------------------------------------

  app.get('/api/takes/:id', (c) => c.json(takesMod.getTake(p(c), c.req.param('id'))));
  app.patch('/api/takes/:id', async (c) => c.json(takesMod.updateTake(p(c), c.req.param('id'), await c.req.json())));
  app.post('/api/takes/:id/select', (c) => {
    const ctx = p(c);
    const take = takesMod.selectTake(ctx, c.req.param('id'), services.bus);
    // P1: a reselect invalidates the shot's old clips (old take is no longer
    // selected; the timeline must never export it).
    timelineMod.invalidateShotClips(ctx, take.shotId);
    return c.json(take);
  });
  app.post('/api/takes/:id/reject', (c) => c.json(takesMod.rejectTake(p(c), c.req.param('id'))));
  app.delete('/api/takes/:id', async (c) => {
    try {
      const take = await takesMod.deleteRejectedTake(p(c), c.req.param('id'));
      services.bus.emit({ type: 'shot.updated', shotId: take.shotId, status: shotsMod.getShot(p(c), take.shotId).status });
      return c.json({ ok: true, id: take.id, shotId: take.shotId });
    } catch (error) {
      if (error instanceof Error && /only rejected takes/.test(error.message)) {
        return c.json({ error: error.message }, 409);
      }
      throw error;
    }
  });
  app.post('/api/takes/:id/select-commit', async (c) => {
    const ctx = p(c);
    const body = await c.req.json();
    const state = body.state ?? continuityMod.emptyVisualState();
    const result = continuityMod.selectTakeAndCommit(ctx, c.req.param('id'), state, services.bus);
    timelineMod.invalidateShotClips(ctx, result.take.shotId);
    return c.json(result);
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
  app.post('/api/timeline/quick-build', (c) => {
    const result = timelineMod.addMissingSelectedTakes(p(c));
    services.bus.emit({ type: 'project.updated' });
    return c.json(result);
  });
  app.post('/api/timeline/clips', async (c) => c.json(timelineMod.addClip(p(c), await c.req.json()), 201));
  app.patch('/api/timeline/clips/:id', async (c) => c.json(timelineMod.updateClip(p(c), c.req.param('id'), await c.req.json())));
  app.delete('/api/timeline/clips/:id', (c) => {
    timelineMod.removeClip(p(c), c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/timeline/clips/reorder', async (c) => c.json(timelineMod.reorderClips(p(c), (await c.req.json()).ids)));
  app.get('/api/timeline/exports', (c) => c.json(timelineMod.listTimelineExports(p(c)).map((item) => ({
    ...item,
    url: `/api/file/${encodeURIComponent(item.relPath)}`,
  }))));
  app.post('/api/timeline/export', async (c) => {
    const ctx = p(c);
    const body = await c.req.json().catch(() => ({}));
    const projectId = ctx.meta.id;
    // P1: run against a DETACHED context. The closure outlives the request,
    // and store.open() closes the old current db when the UI switches
    // projects — a captured `ctx` would die mid-export.
    const job = services.jobs.start('timeline.export', 'Timeline export', async (update) => {
      const pctx = await services.store.openDetached(projectId);
      try {
        update({ message: 'trimming clips' });
        const result = await timelineMod.exportTimeline(pctx, services.ffmpeg, body.title, (done, total) => {
          update({ progress: done / total, message: `trimming clip ${done}/${total}` });
        });
        services.bus.emit({ type: 'project.updated' });
        update({ progress: 1, message: 'concatenating…' });
        return { ...result, url: `/api/file/${encodeURIComponent(result.relPath)}` };
      } finally {
        pctx.close();
      }
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
    if (file.size > 100 * 1024 * 1024) return c.json({ error: 'file too large (maximum 100 MB)' }, 413);
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
  app.get('/api/assets/media/:id/usage', (c) => c.json(assetsMod.mediaUsage(p(c), c.req.param('id'))));
  app.delete('/api/assets/media/:id', async (c) => {
    const ctx = p(c);
    let asset;
    try {
      asset = assetsMod.deleteMedia(ctx, c.req.param('id'));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 409);
    }
    await mediaMod.removeStoredMediaFiles(ctx, asset).catch((error) => {
      console.warn('[media] database row deleted but file cleanup failed', error);
    });
    services.bus.emit({ type: 'project.updated' });
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
  app.get('/api/providers/runninghub/profile', (c) => {
    const profile = services.providers.getProfile();
    return c.json(profile ? { ...profile, bindingSlots: enabledBindingSlots(profile) } : null);
  });
  app.put('/api/providers/runninghub/profile', async (c) => {
    const profile = services.providers.saveProfile(await c.req.json());
    services.bus.emit({ type: 'project.updated' });
    return c.json(profile);
  });
  app.get('/api/providers/runninghub/apikey', (c) =>
    c.json({ source: services.providers.getApiKeySource(), configured: services.providers.getEffectiveApiKey() !== null }),
  );
  app.put('/api/providers/runninghub/apikey', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { key?: unknown };
    if (typeof body.key !== 'string' || !body.key.trim()) {
      return c.json({ ok: false, message: 'API Key 不能为空' }, 400);
    }
    services.providers.saveApiKey(body.key);
    services.bus.emit({ type: 'project.updated' });
    return c.json({ ok: true, source: 'settings', configured: true });
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
    const projectId = ctx.meta.id;
    // P1: detached context — AI actions can run long; a project switch in the
    // UI must not close the database out from under them.
    const job = services.jobs.start('ai.action', `AI: ${action}`, async (update) => {
      const pctx = await services.store.openDetached(projectId);
      try {
        update({ message: 'asking the model…' });
        const out = await aiActions.runAction(services.ai, pctx, action, body);
        update({ message: 'done' });
        return out;
      } finally {
        pctx.close();
      }
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
    if (/not found|missing$/i.test(msg)) return c.json({ error: msg }, 404);
    if (/^(invalid|unsupported)|required|must be|accepts only|does not belong|absolute path/i.test(msg)) {
      return c.json({ error: msg }, 400);
    }
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

/** Range-capable local file response. Shared with the static web middleware
 * in http/app.ts so production asset serving behaves identically on Windows
 * and Unix (hono's serveStatic expects a cwd-relative root). */
export function serveLocalFile(c: Context, abs: string): Response {
  let st;
  try {
    st = statSync(abs);
  } catch {
    return c.json({ error: 'file not found' }, 404);
  }
  if (!st.isFile()) return c.json({ error: 'not a file' }, 400);
  const ext = abs.split('.').pop()?.toLowerCase() ?? '';
  const mime: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    css: 'text/css; charset=utf-8',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
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
  const contentType = mime[ext] ?? 'application/octet-stream';
  const baseHeaders = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
  };
  if (range) {
    const parsed = parseByteRange(range, st.size);
    if (parsed === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, 'Content-Range': `bytes */${st.size}` },
      });
    }
    if (parsed) {
      const { start, end } = parsed;
      return new Response(Readable.toWeb(createReadStream(abs, { start, end })), {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Range': `bytes ${start}-${end}/${st.size}`,
          'Content-Length': String(end - start + 1),
        },
      });
    }
  }
  return new Response(Readable.toWeb(createReadStream(abs)), {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(st.size) },
  });
}
