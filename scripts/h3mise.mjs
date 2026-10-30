#!/usr/bin/env node
// Idempotent local service helper: `h3mise up` starts H3Mise only when it is
// not already healthy; `h3mise status` never installs or starts anything.
import { execFile, spawn } from 'node:child_process';
import { accessSync, closeSync, constants, cpSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
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

async function exportProject(projectRef, destination) {
  if (!projectRef || !destination) throw new Error('usage: h3mise export-project <projectId|title> <destination>');
  const home = process.env.H3MISE_HOME || join(homedir(), '.h3mise');
  const registryPath = join(home, 'registry.db');
  if (!existsSync(registryPath)) throw new Error(`registry not found: ${registryPath}`);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(registryPath, { readOnly: true });
  let row;
  try {
    row = db.prepare('SELECT id, title, dir_path FROM projects WHERE id = ?').get(projectRef)
      ?? db.prepare('SELECT id, title, dir_path FROM projects WHERE title = ?').get(projectRef)
      ?? db.prepare('SELECT id, title, dir_path FROM projects WHERE title LIKE ? ORDER BY updated_at DESC LIMIT 1').get(`${projectRef}%`);
  } finally {
    db.close();
  }
  if (!row) throw new Error(`project not found: ${projectRef}`);
  const source = resolve(String(row.dir_path));
  const target = resolve(destination);
  if (target === source || target.startsWith(`${source}${sep}`)) throw new Error('destination must be outside the project directory');
  if (existsSync(target)) throw new Error(`destination already exists: ${target}`);
  cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
  print({ ok: true, projectId: String(row.id), title: String(row.title), source, destination: target });
}

async function doctor() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const [major, minor] = process.versions.node.replace(/^v/, '').split('.').map(Number);
  add('node', major > 22 || (major === 22 && minor >= 13), process.versions.node);
  const home = process.env.H3MISE_HOME || join(homedir(), '.h3mise');
  try { accessSync(home, constants.W_OK); add('home writable', true, home); }
  catch { add('home writable', false, `${home} (will be created on first run)`); }
  const versionOf = (bin) => new Promise((done) => {
    execFile(bin, ['-version'], { timeout: 5000 }, (error, stdout) => done(error ? null : String(stdout).split('\n')[0]));
  });
  for (const bin of ['ffmpeg', 'ffprobe']) {
    const version = await versionOf(bin);
    add(bin, Boolean(version), version ?? 'not found');
  }
  const body = await health();
  add('service', Boolean(body), body ? `${base} (${body.providerMode})` : 'not running — run `h3mise up`');
  if (body) {
    add('runninghub', body.runningHubConfigured === true, body.runningHubConfigured ? `active ${body.runningHubActiveWorkflowId ?? '—'}` : 'no API key — Mock remains available');
    add('project', body.projectOpen === true, body.projectOpen ? 'open' : 'no project open');
  }
  const ok = checks.filter((check) => !check.ok).length === 0;
  if (json) print({ ok, checks });
  else {
    for (const check of checks) console.log(`${check.ok ? 'ok  ' : 'WARN'} ${check.name.padEnd(16)} ${check.detail}`);
    console.log(ok ? '\nAll checks passed.' : '\nSome checks need attention.');
  }
  if (!ok) process.exitCode = 1;
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
} else if (command === 'doctor') {
  await doctor();
} else if (command === 'export-project') {
  const positional = args.slice(1).filter((arg) => !arg.startsWith('--'));
  await exportProject(positional[0], positional[1]).catch((error) => {
    print({ ok: false, error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
} else {
  print({ ok: false, error: `unknown command "${command}"`, usage: 'h3mise [up|status|doctor|export-project] [--port N] [--json]' });
  process.exitCode = 2;
}
