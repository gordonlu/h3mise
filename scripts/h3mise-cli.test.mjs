import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/h3mise.mjs', ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('h3mise status is read-only and reports an existing service', async () => {
  const server = createServer((req, res) => {
    if (req.url !== '/api/health') { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, app: 'h3mise', providerMode: 'mock', runningHubConfigured: false, runningHubActiveWorkflowId: 'main', runningHubActiveModes: ['t2va'], runningHubVerification: 'verified', projectOpen: false, time: new Date().toISOString() }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const healthy = await run(['status', '--json'], { PORT: String(port) });
    assert.equal(healthy.code, 0);
    const body = JSON.parse(healthy.stdout.trim());
    assert.equal(body.running, true);
    assert.equal(body.runningHubActiveWorkflowId, 'main');
    assert.deepEqual(body.runningHubActiveModes, ['t2va']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const stopped = await run(['status', '--json'], { PORT: '1' });
  assert.equal(stopped.code, 1);
  assert.equal(JSON.parse(stopped.stdout.trim()).running, false);
});
