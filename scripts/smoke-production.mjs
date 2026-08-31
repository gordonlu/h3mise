import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'h3mise-smoke-'));
const port = 4790;
// `pnpm start` runs this entry through tsx. Invoke the same Node loader
// directly so Windows does not leave a pnpm.cmd child process behind.
const tsxLoader = resolve('server/node_modules/tsx/dist/loader.mjs');
const child = spawn(process.execPath, ['--import', tsxLoader, resolve('server/src/index.ts')], {
  env: {
    ...process.env,
    H3MISE_HOME: home,
    H3MISE_PROVIDER: 'mock',
    PORT: String(port),
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
  console.log('production smoke test passed');
} finally {
  if (child.exitCode === null) child.kill('SIGTERM');
  await new Promise((resolveClose) => {
    if (child.exitCode !== null) return resolveClose();
    child.once('close', resolveClose);
    setTimeout(resolveClose, 3_000).unref();
  });
  await rm(home, { recursive: true, force: true });
}
