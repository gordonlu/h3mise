// Local security — PRD §45. Bind 127.0.0.1; validate Origin/Host; state
// changes require a session cookie (CSRF). No wildcard CORS.

import { randomBytes } from 'node:crypto';
import type { Context, MiddlewareHandler, Next } from 'hono';

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export class SessionManager {
  private sessions = new Set<string>();

  issue(): string {
    const token = randomBytes(32).toString('hex');
    this.sessions.add(token);
    return token;
  }

  valid(token: string | undefined): boolean {
    return Boolean(token && this.sessions.has(token));
  }

  revoke(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }
}

/** Validate Host header — every request. */
export function hostGuard(): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host') ?? '';
    if (!LOCAL_HOST.test(host)) {
      return c.json({ error: 'forbidden host' }, 403);
    }
    await next();
  };
}

/** Validate Origin — every request with an Origin header (browser CSRF). */
export function originGuard(): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && !LOCAL_ORIGIN.test(origin)) {
      return c.json({ error: 'forbidden origin' }, 403);
    }
    await next();
  };
}

/** Session cookie required for state-changing requests. */
export function sessionGuard(sessions: SessionManager): MiddlewareHandler {
  return async (c, next) => {
    const token = c.req.header('cookie')?.match(/h3mise_session=([^;]+)/)?.[1];
    if (!sessions.valid(token)) {
      return c.json({ error: 'invalid or missing session — call GET /api/session first' }, 401);
    }
    await next();
  };
}

export function setSessionCookie(c: Context, token: string): void {
  c.header(
    'Set-Cookie',
    `h3mise_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`,
  );
}

export async function noCache(c: Context, next: Next): Promise<void> {
  c.header('Cache-Control', 'no-store');
  await next();
}
