// HTTP app assembly: guards → static web → API routes.
// Order matters: guards and static middleware are registered on the root app
// BEFORE mounting the routes sub-app, so they always run first.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { Hono } from 'hono';
import { hostGuard, originGuard, sessionGuard } from './security.js';
import { buildRoutes, serveLocalFile, type AppServices } from './routes.js';

export const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export function buildApp(services: AppServices, webDist: string | null): Hono<{ Variables: { services: AppServices } }> {
  const app = new Hono<{ Variables: { services: AppServices } }>();

  // 1) Guards on every request.
  app.use('*', hostGuard());
  app.use('*', originGuard());
  app.use('*', async (c, next) => {
    if (MUTATING.has(c.req.method) && !c.req.path.startsWith('/api/session')) {
      return sessionGuard(services.sessions)(c, next);
    }
    await next();
  });

  // 2) Dev mode: API-only — no stale build served. Tell users where the UI is.
  if (!webDist) {
    app.get('/', (c) =>
      c.json({
        ok: true,
        api: 'H3Mise API server (dev)',
        ui: 'http://localhost:5188',
        note: 'In dev the UI runs on Vite (5188); this port serves API only. `pnpm start` serves the built UI.',
      }),
    );
  }

  // 3) Production: static web (built SPA) with history fallback — skips /api/*.
  //    P2: paths are resolved and contained inside webDist (no ".."), and
  //    assets stream through serveLocalFile — hono's serveStatic wants a
  //    cwd-relative root and silently mis-served with an absolute one on Windows.
  if (webDist && existsSync(webDist)) {
    const rootAbs = resolve(webDist);
    app.use('*', async (c, next) => {
      const path = c.req.path;
      if (path.startsWith('/api/')) return next();
      const rel = path === '/' ? 'index.html' : path.slice(1);
      const abs = resolve(rootAbs, rel);
      const relFromRoot = relative(rootAbs, abs);
      if (relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) {
        return c.text('not found', 404);
      }
      let st;
      try {
        st = statSync(abs);
      } catch {
        /* fall through to history fallback */
      }
      if (st?.isFile()) {
        return serveLocalFile(c, abs);
      }
      const html = readFileSync(join(webDist, 'index.html'));
      c.header('Content-Type', 'text/html; charset=utf-8');
      return c.body(html);
    });
  }

  // 3) API routes (their own middleware runs after these).
  app.route('/', buildRoutes(services));

  return app;
}
