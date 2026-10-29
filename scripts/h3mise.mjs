#!/usr/bin/env node
// Idempotent local service helper: `h3mise up` starts H3Mise only when it is
// not already healthy; `h3mise status` never installs or starts anything.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 4789;
const json = process.argv.includes('--json');
const args = process.argv.slice(2).filter((arg) => arg !== '--json');
const command = args[0] ?? 'status';
const portArg = args.indexOf('--port');
const port = portArg >= 0 && args[portArg + 1] ? Number(args[portArg + 1]) : Number(process.env.PORT || DEFAULT_PORT);
const base = `http://127.0.0.1:${port}`;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function print(value) {
  if (json) process.stdout.write(`${JSON.stringify(value)}\n`);
  else if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

async function health() {
  try {
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2500), redirect: 'error' });
    if (!response.ok) return null;
    const body = await response.json();
    if (!body?.ok || body.app !== 'h3mise') return null;
    return body;
  } catch {
    return null;
  }
}

async function waitHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await health();
    if (body) return body;
    await delay(300);
  }
  return null;
}

async function status() {
  const body = await health();
  if (!body) {
    print({ ok: false, running: false, apiBase: base, hint: 'Run `h3mise up` (or `sh start.sh`) to start H3Mise.' });
    process.exitCode = 1;
    return;
  }
  print({
    ok: true,
    running: true,
    apiBase: base,
    providerMode: body.providerMode,
    runningHubConfigured: body.runningHubConfigured,
    runningHubActiveWorkflowId: body.runningHubActiveWorkflowId ?? null,
    runningHubActiveModes: body.runningHubActiveModes ?? [],
    runningHubVerification: body.runningHubVerification ?? null,
    projectOpen: body.projectOpen,
    projectProvider: body.projectProvider ?? null,
    time: body.time,
  });
}

async function up() {
  const existing = await health();
  if (existing) {
    print({ ok: true, running: true, started: false, apiBase: base, message: 'H3Mise is already running.' });
    return;
  }
  const cacheDir = join(ROOT, 'node_modules', '.cache', 'h3mise');
  mkdirSync(cacheDir, { recursive: true });
  const logPath = join(cacheDir, 'launch.log');
  const log = openSync(logPath, 'a');
  const child = spawn(process.execPath, [join(ROOT, 'scripts/launch.mjs'), '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', log, log],
    detached: true,
    windowsHide: true,
  });
  child.unref();
  closeSync(log);
  const startedAt = Date.now();
  const body = await waitHealth(180_000);
  if (!body) {
    print({ ok: false, running: false, started: false, apiBase: base, message: `H3Mise did not become healthy within 180s. See ${logPath}` });
    process.exitCode = 1;
    return;
  }
  print({ ok: true, running: true, started: true, apiBase: base, startupMs: Date.now() - startedAt, log: logPath });
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  print({ ok: false, error: 'invalid port' });
  process.exitCode = 2;
} else if (command === 'status') {
  await status();
} else if (command === 'up' || command === 'ensure') {
  await up();
} else {
  print({ ok: false, error: `unknown command "${command}"`, usage: 'h3mise [up|status] [--port N] [--json]' });
  process.exitCode = 2;
}
