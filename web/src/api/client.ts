// Typed API client for the local H3Mise server. Bootstraps the session
// cookie, throws on error, and exposes a raw fetch for media URLs.

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

let sessionReady: Promise<void> | null = null;

const REQUEST_TIMEOUT_MS = 20_000;

/** Local requests can stall (a dropped keep-alive connection, a busy
 * server). Without a bound the UI would wait forever, so GET/HEAD get a
 * timeout plus one retry; mutating requests fail fast and never retry. */
async function fetchWithGuard(path: string, init: RequestInit, retry: boolean): Promise<Response> {
  try {
    return await fetch(path, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    if (!retry) throw error;
    return fetch(path, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }
}

async function ensureSession(): Promise<void> {
  if (!sessionReady) {
    sessionReady = (async () => {
      const res = await fetchWithGuard('/api/session', { credentials: 'same-origin' }, true);
      if (!res.ok) throw new ApiError('session bootstrap failed', res.status);
    })().catch((e) => {
      sessionReady = null;
      throw e;
    });
  }
  await sessionReady;
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  await ensureSession();
  const isFormData = body instanceof FormData;
  const res = await fetchWithGuard(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined && !isFormData ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? (isFormData ? body : JSON.stringify(body)) : undefined,
  }, method === 'GET' || method === 'HEAD');
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, data);
  }
  return data as T;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => api<T>('POST', path, body);
export const patch = <T>(path: string, body?: unknown) => api<T>('PATCH', path, body);
export const put = <T>(path: string, body?: unknown) => api<T>('PUT', path, body);
export const del = <T>(path: string) => api<T>('DELETE', path);

export function mediaUrl(id: string): string {
  return `/api/media/${id}`;
}

export function takeVideoUrl(takeId: string): string {
  return `/api/takes/${takeId}/video`;
}

/** Serve a project-relative file path (poster, frame, export) via the file API. */
export function fileUrl(relPath: string): string {
  return `/api/file/${encodeURIComponent(relPath)}`;
}

/** Subscribe to server events over SSE with auto-reconnect. */
export function subscribeEvents(onEvent: (e: import('@h3mise/shared').AppEvent) => void): () => void {
  let es: EventSource | null = null;
  let closed = false;
  const connect = () => {
    if (closed) return;
    es = new EventSource('/api/events', { withCredentials: true });
    es.onmessage = (ev) => {
      try {
        onEvent(JSON.parse(ev.data) as import('@h3mise/shared').AppEvent);
      } catch {
        /* ignore malformed */
      }
    };
    es.onerror = () => {
      es?.close();
      if (!closed) setTimeout(connect, 3000);
    };
  };
  connect();
  return () => {
    closed = true;
    es?.close();
  };
}
