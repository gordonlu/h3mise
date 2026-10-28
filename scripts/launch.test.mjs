import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fingerprint, inspectServer, landingPath, loadEnvironment, pnpmCommand, serverPort, supportsNode } from './launch.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'h3mise launch 中文 '));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('launcher enforces the Node version needed for unflagged node:sqlite', () => {
  for (const version of ['20.19.0', '22.0.0', '22.12.9']) assert.equal(supportsNode(version), false);
  for (const version of ['v22.13.0', '22.22.0', '24.0.0', '26.0.0']) assert.equal(supportsNode(version), true);
});

test('env precedence matches the server without rewriting files or revealing keys', () => fixture((root) => {
  const content = 'PORT=4901\nRUNNINGHUB_API_KEY="test-only-secret"\nH3MISE_HOME="项目 data"\n';
  writeFileSync(join(root, '.env.local'), content);
  writeFileSync(join(root, '.env'), 'PORT=4902\nRUNNINGHUB_API_KEY=other\nAI_MODEL=test-model\n');
  const env = loadEnvironment(root, { PORT: '4900', AI_API_KEY: '' });
  assert.equal(serverPort(env), 4900);
  assert.equal(env.RUNNINGHUB_API_KEY, 'test-only-secret');
  assert.equal(env.H3MISE_HOME, '项目 data');
  assert.equal(env.AI_API_KEY, '');
  assert.equal(env.AI_MODEL, 'test-model');
  assert.equal(serverPort(loadEnvironment(root, {})), 4901);
}));

test('invalid ports fail before a server or browser is started', () => {
  assert.equal(serverPort({}), 4789);
  assert.equal(serverPort({ PORT: '' }), 4789);
  for (const port of ['0', '-1', '65536', 'not-a-port', '1.5']) assert.throws(() => serverPort({ PORT: port }), /PORT/);
});

test('bootstrap pins pnpm without Corepack, global installs or shell interpolation', () => {
  const args = ['install', '--frozen-lockfile'];
  const windows = pnpmCommand('11.7.0', args, 'win32');
  assert.match(windows.args.at(-1), /^npx --yes --package=pnpm@11\.7\.0 pnpm --config.pmOnFail=ignore --config.updateNotifier=false install --frozen-lockfile$/);
  for (const platform of ['darwin', 'linux']) {
    const posix = pnpmCommand('11.7.0', args, platform);
    assert.equal(posix.file, 'npx');
    assert.equal(posix.args.at(-1), '--frozen-lockfile');
  }
  assert.throws(() => pnpmCommand('latest', args));
  assert.throws(() => pnpmCommand('11.7.0', ['install & echo unsafe'], 'win32'));
});

test('source contents and deleted files invalidate build cache in paths with spaces and Chinese', () => fixture((root) => {
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'page.vue'), 'before');
  const before = fingerprint(root, ['src', 'optional']);
  assert.equal(fingerprint(root, ['src', 'optional']), before);
  writeFileSync(join(root, 'src', 'page.vue'), 'after');
  const after = fingerprint(root, ['src', 'optional']);
  assert.notEqual(after, before);
  rmSync(join(root, 'src', 'page.vue'));
  assert.notEqual(fingerprint(root, ['src', 'optional']), after);
}));

const health = { ok: true, app: 'h3mise', runningHubConfigured: false, aiConfigured: false, ffmpeg: { available: false } };
function serverResponses(body, html = '<title>H3Mise</title>', type = 'text/html') {
  return async (url) => url.endsWith('/api/health')
    ? Response.json(body)
    : new Response(html, { headers: { 'content-type': type } });
}

test('an unrelated service is never treated as a running H3Mise', async () => {
  assert.equal(await inspectServer('http://127.0.0.1:4789', serverResponses({ ok: true })), null);
  assert.equal(await inspectServer('http://127.0.0.1:4789', async () => { throw new Error('offline'); }), null);
});

test('health alone does not open an API-only service as the UI', async () => {
  assert.equal((await inspectServer('http://127.0.0.1:4789', serverResponses(health, '{"api":"H3Mise"}', 'application/json'))).webReady, false);
  assert.equal((await inspectServer('http://127.0.0.1:4789', serverResponses(health))).webReady, true);
});

test('missing RunningHub keys open guidance while configured local ComfyUI can continue', () => {
  assert.equal(landingPath(health), '/welcome');
  assert.equal(landingPath({ ...health, runningHubConfigured: true }), '/');
  assert.equal(landingPath({ ...health, comfyUiConfigured: true }), '/');
});

test('platform entry works outside the project directory with spaces and Chinese in its path', () => fixture((root) => {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const name = process.platform === 'win32' ? 'start.bat' : 'start.sh';
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, name), readFileSync(join(repo, name)));
  writeFileSync(join(root, 'scripts', 'launch.mjs'), 'console.log("ENTRY_OK"); console.log(process.cwd()); console.log(process.argv[2]);');
  const result = process.platform === 'win32'
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${join(root, name)}" --no-open"`], { cwd: repo, encoding: 'utf8', input: '\n', timeout: 15_000, windowsVerbatimArguments: true })
    : spawnSync('sh', [join(root, name), '--no-open'], { cwd: repo, encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ENTRY_OK/);
  assert.ok(result.stdout.includes(root));
  assert.match(result.stdout, /--no-open/);
}));

test('occupied port reports a useful error without installing or replacing the other service', async () => {
  const other = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); });
  await new Promise((done) => other.listen(0, '127.0.0.1', done));
  const port = other.address().port;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./launch.mjs', import.meta.url)), '--no-open'], {
    env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill(), 15_000);
  try {
    const code = await new Promise((done, reject) => { child.once('exit', done); child.once('error', reject); });
    assert.equal(code, 1, output);
    assert.match(output, new RegExp(`Port ${port} is in use`));
    assert.doesNotMatch(output, /Installing dependencies/);
    assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 200);
  } finally { clearTimeout(timer); other.closeAllConnections(); await new Promise((done) => other.close(done)); }
});
