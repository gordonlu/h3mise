import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { inspectServer, landingPath } from './launch.mjs';

const home = await mkdtemp(join(tmpdir(), 'h3mise-smoke-'));
const port = 4790;
// `pnpm start` runs this entry through tsx. Invoke the same Node loader
// directly so Windows does not leave a pnpm.cmd child process behind.
const tsxLoader = resolve('server/node_modules/tsx/dist/loader.mjs');
const child = spawn(process.execPath, ['--import', pathToFileURL(tsxLoader).href, resolve('server/src/index.ts')], {
  env: {
    ...process.env,
    H3MISE_HOME: home,
    H3MISE_PROVIDER: 'mock',
    PORT: String(port),
    RUNNINGHUB_API_KEY: '',
    AI_API_KEY: '',
    AI_BASE_URL: '',
    AI_MODEL: '',
    H3MISE_SERVE_WEB: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
child.stdout.on('data', (chunk) => { output += chunk.toString(); });
child.stderr.on('data', (chunk) => { output += chunk.toString(); });

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}\n${output}`);
    try {
      const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((res) => res.json());
      if (health?.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error(`server did not become healthy\n${output}`);
}

try {
  await waitForServer();
  const ui = await fetch(`http://127.0.0.1:${port}/`);
  const html = await ui.text();
  if (!ui.ok || !ui.headers.get('content-type')?.includes('text/html') || !html.includes('H3Mise')) {
    throw new Error(`built UI was not served (${ui.status}, ${ui.headers.get('content-type')})`);
  }
  const base = `http://127.0.0.1:${port}`;
  const health = await inspectServer(base);
  assert.equal(health.app, 'h3mise');
  assert.equal(health.webReady, true);
  assert.equal(health.runningHubConfigured, false);
  assert.equal(landingPath(health), '/welcome');
  const welcome = await fetch(`${base}/welcome`);
  assert.equal(welcome.status, 200);
  assert.match(welcome.headers.get('content-type'), /text\/html/);
  // A second launch must reuse this server and exit, without installing or
  // starting another process. No browser, user data, credentials or paid APIs.
  const reuse = process.platform === 'win32'
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'start.bat --no-open'], {
        env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: true,
      })
    : spawn('sh', [resolve('start.sh'), '--no-open'], {
        env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
      });
  let reuseOutput = '';
  reuse.stdout.on('data', (chunk) => { reuseOutput += chunk; });
  reuse.stderr.on('data', (chunk) => { reuseOutput += chunk; });
  const timer = setTimeout(() => reuse.kill(), 15_000);
  try {
    const reuseCode = await new Promise((done, reject) => { reuse.once('error', reject); reuse.once('exit', done); });
    assert.equal(reuseCode, 0, reuseOutput);
    assert.match(reuseOutput, /already running/);
    assert.match(reuseOutput, new RegExp(`${base}/welcome`));
    assert.doesNotMatch(reuseOutput, /Installing dependencies/);
  } finally { clearTimeout(timer); }
  console.log('production smoke test passed (built UI, missing-key guide, repeat-launch reuse)');
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await new Promise((resolveClose) => {
    if (child.exitCode !== null) return resolveClose();
    child.once('close', resolveClose);
    setTimeout(resolveClose, 3_000).unref();
  });
  await rm(home, { recursive: true, force: true });
}
