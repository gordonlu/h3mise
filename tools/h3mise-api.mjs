// Local REST transport. Retry only a rejected session, never uncertain submissions.
export function createApiClient(baseUrl, fetchImpl = fetch) {
  let cookie = '';
  let bootstrap = null;
  let modelLabel = typeof process !== 'undefined' && process.env?.H3MISE_AGENT_MODEL?.trim()
    ? process.env.H3MISE_AGENT_MODEL.trim()
    : null;
  async function ensureSession() {
    if (cookie) return cookie;
    if (!bootstrap) bootstrap = (async () => {
      const response = await fetchImpl(`${baseUrl}/api/session`);
      if (!response.ok) throw new Error(`H3Mise session bootstrap failed: HTTP ${response.status}`);
      const match = (response.headers.get('set-cookie') ?? '').match(/h3mise_session=([^;]+)/);
      if (!match) throw new Error('H3Mise did not return a session cookie');
      cookie = `h3mise_session=${match[1]}`;
      return cookie;
    })().finally(() => { bootstrap = null; });
    return bootstrap;
  }
  async function api(method, path, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const sentCookie = await ensureSession();
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Cookie: sentCookie,
          ...(modelLabel ? { 'X-H3Mise-Agent-Model': modelLabel } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).catch(error => { throw new Error(`Cannot reach H3Mise at ${baseUrl}: ${error.message}`); });
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (response.ok) return data;
      if (response.status === 401) {
        if (cookie === sentCookie) cookie = '';
        if (attempt === 0) continue;
      }
      const message = data && typeof data === 'object' && 'error' in data
        ? `${data.code ? `[${data.code}] ` : ''}${data.error}`
        : data && typeof data === 'object' && 'message' in data
          ? String(data.message)
          : `HTTP ${response.status}`;
      const extra = data && typeof data === 'object' && data.currentProject
        ? ` (currentProject=${JSON.stringify(data.currentProject)})`
        : '';
      throw new Error(`H3Mise ${method} ${path} failed: ${message}${extra}`);
    }
  }
  api.setModelLabel = (label) => {
    modelLabel = typeof label === 'string' && label.trim() ? label.trim() : null;
  };
  return api;
}
