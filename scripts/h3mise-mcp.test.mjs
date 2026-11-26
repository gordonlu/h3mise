import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

test('MCP exposes agent inference and compact render tracking without paid calls', async () => {
  const paths = [];
  const bodies = [];
  const headersSeen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      paths.push(req.method + ' ' + req.url);
      headersSeen.push({ url: req.url, model: req.headers['x-h3mise-agent-model'] ?? null });
      bodies.push({ method: req.method, url: req.url, body: rawBody ? JSON.parse(rawBody) : null });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/session') {
        res.setHeader('Set-Cookie', 'h3mise_session=test'); res.end('{}'); return;
      }
      if (req.url.startsWith('/api/render') && req.method === 'GET') {
        const job = { id: 'job-1', status: 'RUNNING', providerTaskId: 'remote-1', takeId: null,
          requestSnapshot: { prompt: 'large context' }, providerResponseSnapshot: { raw: 'large' } };
        res.end(JSON.stringify(req.url.includes('job-1') ? job : [job])); return;
      }
      if (req.url === '/api/render' && req.method === 'POST') {
        res.end(JSON.stringify({ id: 'job-2', status: 'LOCAL_QUEUED' })); return;
      }
      if (req.url.endsWith('/review-evidence')) { res.end('{"takeId":"take-1","technical":{"decode":"passed"}}'); return; }
      if (req.url.includes('/prepare')) { res.end('{"requestId":"aireq-1","inference":{"system":"your model"}}'); return; }
      if (req.url.includes('/apply')) { res.end('{"status":"applied","result":{"saved":{"promptVersionId":"prompt-1"}}}'); return; }
      if (req.url === '/api/ai/requests/aireq-1') { res.end('{"id":"aireq-1","status":"applied"}'); return; }
      if (req.url === '/api/ai/agent/session') { res.end('{"attached":true,"modelLabel":"claude-opus-4"}'); return; }
      res.end('{}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['tools/h3mise-mcp.mjs'], {
    env: { ...process.env, H3MISE_API_URL: `http://127.0.0.1:${server.address().port}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map(); let id = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { const message = JSON.parse(line); pending.get(message.id)?.(message.result); });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error('MCP timeout')); }, 5000);
    pending.set(key, value => { clearTimeout(timer); pending.delete(key); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n');
  });
  const call = (name, args) => rpc('tools/call', { name, arguments: args });
  try {
    const listed = await rpc('tools/list');
    for (const name of ['prepare_take_review', 'inspect_render_jobs', 'prepare_ai_action', 'apply_ai_result', 'agent_session', 'inspect_ai_requests', 'create_shot', 'ensure_service', 'get_provider_profile', 'upsert_workflow', 'verify_workflow', 'set_active_workflow', 'preview_workflow_payload'])
      assert.ok(listed.tools.some(tool => tool.name === name));
    const updateShotTool = listed.tools.find(tool => tool.name === 'update_shot');
    assert.ok(updateShotTool.inputSchema.properties.dependsOnShotId);
    assert.ok(updateShotTool.inputSchema.properties.h3Mode.enum.includes('faceswap'));
    const statusRes = await call('inspect_render_jobs', { jobId: 'job-1' });
    assert.ok(!statusRes.content[0].text.includes('\n'), 'MCP returns compact JSON');
    const status = JSON.parse(statusRes.content[0].text);
    assert.equal(status.providerTaskId, 'remote-1');
    assert.ok(!('requestSnapshot' in status));
    const full = JSON.parse((await call('inspect_render_jobs', { includeSnapshots: true })).content[0].text);
    assert.ok(full[0].requestSnapshot);
    await call('agent_session', { action: 'attach', model: 'claude-opus-4' });
    assert.equal(JSON.parse((await call('prepare_ai_action', { action: 'plan_shot', body: { shotId: 's1' } })).content[0].text).requestId, 'aireq-1');
    const prepPath = paths.find(p => p.includes('/prepare'));
    assert.ok(prepPath?.includes('imageMode=paths'), 'prepare_ai_action defaults to imageMode=paths');
    const prepHeader = headersSeen.find(h => h.url?.includes('/prepare'));
    assert.equal(prepHeader?.model, 'claude-opus-4', 'attached agent model is preserved');
    assert.equal(JSON.parse((await call('inspect_ai_requests', { requestId: 'aireq-1', view: 'detail' })).content[0].text).status, 'applied');
    assert.equal(JSON.parse((await call('apply_ai_result', { requestId: 'aireq-1', result: 'answer', persist: true })).content[0].text).result.saved.promptVersionId, 'prompt-1');
    assert.equal(JSON.parse((await call('prepare_take_review', { takeId: 'take-1' })).content[0].text).technical.decode, 'passed');
    assert.ok(paths.includes('POST /api/takes/take-1/review-evidence'));
    const before = paths.length;
    assert.equal((await call('submit_render', { shotId: 's1' })).isError, true);
    assert.equal((await call('submit_render', { shotId: 's1', promptVersionId: 'p1', providerId: 'runninghub' })).isError, true);
    assert.equal(paths.length, before, 'unconfirmed paid render never reaches HTTP');
    assert.ok(!paths.some(path => path === 'POST /api/render'), 'unconfirmed render never submits');

    // Confirmed paid render forwards confirmed: true to the server gate.
    const confirmedRes = await call('submit_render', {
      shotId: 's1', promptVersionId: 'p1', providerId: 'runninghub', confirmPaid: true,
    });
    assert.ok(!confirmedRes.isError);
    const renderPost = bodies.find(entry => entry.method === 'POST' && entry.url === '/api/render');
    assert.equal(renderPost?.body?.confirmed, true);
  } finally {
    lines.close(); child.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
});
