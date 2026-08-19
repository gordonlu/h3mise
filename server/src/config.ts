// H3Mise server configuration. All secrets come from environment only —
// never from project files or request bodies.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined || v === '') return undefined;
  return v;
}

/** Repo root = server/src → up two levels. */
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

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
