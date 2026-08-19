// H3Mise server configuration. Secrets come from environment — optionally
// via .env / .env.local files at the repo root (real env vars take precedence).

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Repo root = server/src → up two levels. */
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

/**
 * Minimal dotenv-free loader: .env.local first, then .env (missing keys only).
 * A variable already present in the real environment is never overridden.
 */
function loadEnvFiles(): void {
  for (const name of ['.env.local', '.env']) {
    const file = join(REPO_ROOT, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || !m[1]) continue;
      const key = m[1];
      if (process.env[key] !== undefined) continue;
      let val = m[2] ?? '';
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  }
}

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  return v;
}

export interface ServerConfig {
  port: number;
  /** Root for the registry DB and project dirs. */
  home: string;
  runningHubApiKey: string | null;
  /** v0.1: 'runninghub' (real) | 'mock' (offline synthetic renders). */
  providerMode: 'runninghub' | 'mock';
  ai: {
    baseUrl: string | null;
    apiKey: string | null;
    model: string | null;
  };
  webDist: string | null;
}

export function loadConfig(): ServerConfig {
  loadEnvFiles();
  const port = Number(readEnv('PORT') ?? '4789');
  const home = readEnv('H3MISE_HOME')
    ? resolve(readEnv('H3MISE_HOME')!)
    : join(homedir(), '.h3mise');
  const webDist = join(REPO_ROOT, 'web', 'dist');
  return {
    port,
    home,
    runningHubApiKey: readEnv('RUNNINGHUB_API_KEY') ?? null,
    providerMode: (readEnv('H3MISE_PROVIDER') ?? 'runninghub') === 'mock' ? 'mock' : 'runninghub',
    ai: {
      baseUrl: readEnv('AI_BASE_URL') ?? null,
      apiKey: readEnv('AI_API_KEY') ?? null,
      model: readEnv('AI_MODEL') ?? null,
    },
    webDist: existsSync(webDist) ? webDist : null,
  };
}
