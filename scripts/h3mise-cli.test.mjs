import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('h3mise export-project copies a project out of H3MISE_HOME', async () => {
  const root = mkdtempSync(join(tmpdir(), 'h3mise-cli-export-'));
  const home = join(root, 'home');
  const project = join(home, 'projects', 'demo.h3studio');
  const destination = join(root, 'workspace-copy');
  mkdirSync(project, { recursive: true });
  const marker = join(project, 'project.json');
  const fs = await import('node:fs');
  fs.writeFileSync(marker, '{"title":"Demo"}');
  const db = new DatabaseSync(join(home, 'registry.db'));
  db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT, format TEXT, dir_path TEXT, created_at TEXT, updated_at TEXT, last_opened_at TEXT)`);
  db.prepare('INSERT INTO projects (id, title, format, dir_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('proj-demo', 'Demo', 'single_shot', project, new Date().toISOString(), new Date().toISOString());
  db.close();
  try {
    const result = await run(['export-project', 'proj-demo', destination, '--json'], { H3MISE_HOME: home });
    assert.equal(result.code, 0, result.stderr);
    const body = JSON.parse(result.stdout.trim());
    assert.equal(body.ok, true);
    assert.equal(JSON.parse(readFileSync(join(destination, 'project.json'), 'utf8')).title, 'Demo');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
