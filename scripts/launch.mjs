// Dependency-free bootstrap: Node + the npm/npx bundled with it are sufficient.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, mkdirSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { once } from 'node:events';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const say = (zh, en) => console.log(`[H3Mise] ${zh}\n         ${en}`);

export function supportsNode(version) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

// Match server/src/config.ts precedence; never print values or create env files.
export function loadEnvironment(root, env) {
  for (const name of ['.env.local', '.env']) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || env[match[1]] !== undefined) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      env[match[1]] = value;
    }
  }
  return env;
}

export function serverPort(env) {
  const port = Number(env.PORT || 4789);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 的整数 / PORT must be an integer from 1 to 65535.');
  return port;
}

export function pnpmCommand(version, args, platform = process.platform) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid pinned pnpm version');
  // All arguments are launcher-owned constants. Do not pass user input to cmd.
  const commandArgs = ['--yes', `--package=pnpm@${version}`, 'pnpm', '--config.pmOnFail=ignore', '--config.updateNotifier=false', ...args];
  if (commandArgs.some((arg) => !/^[a-zA-Z0-9@/_.=:-]+$/.test(arg))) throw new Error('Invalid package manager argument');
  return platform === 'win32'
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `npx ${commandArgs.join(' ')}`], verbatim: true }
    : { file: 'npx', args: commandArgs };
}

export function fingerprint(root, paths) {
  const hash = createHash('sha256');
  function visit(relative) {
    const file = join(root, relative);
    hash.update(relative.replaceAll('\\', '/'));
    if (!existsSync(file)) { hash.update('missing'); return; }
    const entries = readdirOrNull(file);
    if (entries) {
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        if (entry.isFile() || entry.isDirectory()) visit(join(relative, entry.name));
      }
    } else hash.update(readFileSync(file));
  }
  for (const path of paths) visit(path);
  return hash.digest('hex');
}

function readdirOrNull(path) {
  try { return readdirSync(path, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOTDIR') return null; throw error; }
}

export async function inspectServer(base, fetcher = fetch) {
  try {
    const response = await fetcher(`${base}/api/health`, { signal: AbortSignal.timeout(2500), redirect: 'error' });
    const health = await response.json();
    // Older H3Mise builds predate the app marker. Require their full shape.
    const identity = health.app === 'h3mise' || (typeof health.runningHubConfigured === 'boolean' && ['mock', 'runninghub'].includes(health.providerMode) && typeof health.ffmpeg?.available === 'boolean');
    if (!response.ok || !health.ok || !identity) return null;
    const ui = await fetcher(`${base}/`, { signal: AbortSignal.timeout(2500), redirect: 'error' });
    const webReady = ui.ok && ui.headers.get('content-type')?.includes('text/html') && (await ui.text()).includes('H3Mise');
    return { ...health, webReady: Boolean(webReady) };
  } catch { return null; }
}

export function landingPath(health) {
  return health.runningHubConfigured || health.comfyUiConfigured ? '/' : '/welcome';
}

async function portAvailable(port) {
  return new Promise((done, reject) => {
    const probe = createServer();
    probe.once('error', (error) => error.code === 'EADDRINUSE' ? done(false) : reject(error));
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
  });
}

function openBrowser(url, noOpen) {
  console.log(`\n  ${url}\n`);
  if (noOpen) return;
  const [file, args] = process.platform === 'win32'
    ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `start "" "${url}"`]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const browser = spawn(file, args, { stdio: 'ignore', detached: true, windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' });
  browser.on('error', () => say('浏览器未能自动打开，请复制上方地址。', 'Copy the address above into your browser.'));
  browser.on('exit', (code) => { if (code) say('请在浏览器中打开上方地址。', 'Open the address above in your browser.'); });
  browser.unref();
}

function run(command, env, cwd = ROOT) {
  return new Promise((done, reject) => {
    const child = spawn(command.file, command.args, { cwd, env, stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: command.verbatim ?? false });
    child.once('error', () => reject(new Error('无法运行 npm/npx。请重新安装含 npm 的 Node.js。 / Reinstall Node.js with npm included.')));
    child.once('exit', (code) => code === 0 ? done() : reject(new Error('准备失败。请检查上方错误、网络和文件夹写入权限，然后重新启动。 / Setup failed. Check the error above, network and folder permissions, then launch again.')));
  });
}

function acquireLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => { try { unlinkSync(path); } catch { /* already removed */ } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(readFileSync(path, 'utf8'));
      let alive = true;
      try { if (Number.isInteger(pid) && pid > 0) process.kill(pid, 0); else alive = false; }
      catch (error) { alive = error.code !== 'ESRCH'; }
      if (alive) throw new Error('另一个启动窗口正在准备或启动，请稍候再试。 / Another launcher is preparing H3Mise. Please wait and try again.');
      unlinkSync(path);
    }
  }
  throw new Error('请重新启动 / Please launch again.');
}

async function useExisting(base, noOpen) {
  const health = await inspectServer(base);
  if (!health) return false;
  if (!health.webReady) throw new Error('已有 H3Mise 服务仅提供 API。请在原窗口停止它，再使用一键启动。 / An API-only H3Mise is running. Stop it in its original window, then launch again.');
  say('H3Mise 已在运行，正在打开。', 'H3Mise is already running. Opening it.');
  openBrowser(base + landingPath(health), noOpen);
  return true;
}

export async function main(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== '--no-open')) throw new Error('只支持 --no-open 参数 / Only --no-open is supported.');
  if (!supportsNode(process.versions.node)) throw new Error('需要 Node.js 22.13 或更新版本：https://nodejs.org/ / Install Node.js 22.13 or newer.');
  // Loading SQLite now gives an actionable error before downloading dependencies.
  try { await import('node:sqlite'); }
  catch { throw new Error('此 Node.js 不含 SQLite，请安装官方 Node.js 22.13 或更新版本。 / Install official Node.js 22.13+ with SQLite.'); }
  const env = loadEnvironment(ROOT, { ...process.env });
  const port = serverPort(env);
  const base = `http://127.0.0.1:${port}`;
  const noOpen = args.includes('--no-open');
  if (await useExisting(base, noOpen)) return;
  const busy = () => new Error(`端口 ${port} 被其他程序占用，请关闭占用程序后重试。 / Port ${port} is in use. Close the other application, then launch again. Advanced: set PORT in .env.local.`);
  if (!(await portAvailable(port))) throw busy();

  const cacheDir = join(ROOT, 'node_modules', '.cache', 'h3mise');
  const release = acquireLock(join(cacheDir, 'launch.lock'));
  let server;
  let stopping = false;
  const stop = () => { stopping = true; server?.kill('SIGTERM'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const version = manifest.packageManager?.match(/^pnpm@(\d+\.\d+\.\d+)$/)?.[1];
    if (!version) throw new Error('package.json must pin a pnpm version.');
    const stampPath = join(cacheDir, 'launcher.json');
    let stamp = {};
    try { stamp = JSON.parse(readFileSync(stampPath, 'utf8')); } catch { /* first launch */ }
    const depsHash = fingerprint(ROOT, ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'server/package.json', 'shared/package.json', 'web/package.json']);
    // Keep npm bootstrap cache local; no global pnpm/Corepack/admin install.
    const setupEnv = { ...env, npm_config_cache: join(cacheDir, 'npm'), npm_config_update_notifier: 'false', NO_UPDATE_NOTIFIER: '1' };
    const loader = join(ROOT, 'server/node_modules/tsx/dist/loader.mjs');
    const vite = join(ROOT, 'web/node_modules/vite/bin/vite.js');
    if (stamp.deps !== depsHash || !existsSync(loader) || !existsSync(vite)) {
      if (env.H3MISE_SKIP_INSTALL === '1') {
        throw new Error('依赖尚未安装或无更新，但已设置 H3MISE_SKIP_INSTALL=1。请先手动运行 pnpm install，或去掉该变量后重试。 / Dependencies are missing or stale, but H3MISE_SKIP_INSTALL=1 is set. Run pnpm install first or unset it.');
      }
      say('首次启动或依赖有更新，正在安装。首次需要联网，请保持窗口打开。', 'Installing dependencies. The first launch needs internet; keep this window open.');
      await run(pnpmCommand(version, ['install', '--frozen-lockfile', '--prod=false']), setupEnv);
      stamp = { deps: depsHash };
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(stampPath, JSON.stringify(stamp));
    }
    if (stopping) return;
    const webHash = fingerprint(ROOT, ['web/src', 'web/public', 'web/index.html', 'web/vite.config.ts', 'web/tsconfig.json', 'shared/src', 'tsconfig.base.json']) + depsHash;
    if (stamp.web !== webHash || !existsSync(join(ROOT, 'web/dist/index.html'))) {
      say('正在准备界面，完成后会自动打开浏览器。', 'Building the interface. Your browser will open when ready.');
      await run({ file: process.execPath, args: [vite, 'build'] }, env, join(ROOT, 'web'));
      stamp.web = webHash;
    }
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(stampPath, JSON.stringify(stamp));
    if (stopping || await useExisting(base, noOpen)) return;
    if (!(await portAvailable(port))) throw busy();
    say('正在启动；缺少 Key 时会显示设置引导，也可免费体验。', 'Starting. Missing keys will show setup guidance; free exploration is available.');
    // Direct child avoids orphaned pnpm.cmd / tsx wrappers on Windows.
    server = spawn(process.execPath, ['--import', pathToFileURL(loader).href, join(ROOT, 'server/src/index.ts')], {
      cwd: ROOT, env: { ...env, PORT: String(port), H3MISE_SERVE_WEB: '1' }, stdio: 'inherit', windowsHide: true,
    });
    let spawnError;
    server.on('error', (error) => { spawnError = error; });
    const exited = new Promise((done) => server.once('exit', (code) => done(code)));
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (!stopping && Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (server.exitCode !== null || server.signalCode !== null) throw new Error('服务已退出，请查看上方错误。 / Server exited. Check the error above.');
      const health = await inspectServer(base);
      if (health?.webReady) {
        ready = true;
        say('启动成功。使用期间请保持此窗口打开；按 Ctrl+C 停止。', 'Ready. Keep this window open while using H3Mise; press Ctrl+C to stop.');
        openBrowser(base + landingPath(health), noOpen);
        break;
      }
      await delay(300);
    }
    if (!ready && !stopping) throw new Error('启动超时，请查看上方错误并重新启动。 / Startup timed out. Check the error above and launch again.');
    if (stopping) server.kill('SIGTERM');
    const code = await exited;
    if (!stopping && code !== 0) throw new Error('服务意外停止，请查看上方错误。 / Server stopped unexpectedly. Check the error above.');
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      await Promise.race([once(server, 'exit'), delay(3000)]);
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    }
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`\n[H3Mise] ${error.message}\n请参阅 START_HERE.md / See START_HERE.md`); process.exitCode = 1; });
}
