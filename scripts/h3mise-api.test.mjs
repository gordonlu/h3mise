import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApiClient } from '../tools/h3mise-api.mjs';

test('parallel calls share bootstrap and rejected sessions recover once', async () => {
  let sessions = 0, requests = 0;
  const api = createApiClient('http://local', async (url, init) => {
    if (url.endsWith('/api/session')) {
      sessions++;
      await new Promise(resolve => setTimeout(resolve, 1));
      return new Response('{}', { headers: { 'set-cookie': `h3mise_session=${sessions}; HttpOnly` } });
    }
    requests++;
    return init.headers.Cookie.endsWith('=1')
      ? new Response('{"error":"session expired"}', { status: 401 })
      : new Response('{"ok":true}');
  });
  const results = await Promise.all([api('POST', '/api/a', {}), api('POST', '/api/b', {})]);
  assert.deepEqual(results, [{ ok: true }, { ok: true }]);
  assert.equal(sessions, 2);
  assert.equal(requests, 4);
});

for (const failure of ['network', 'server', 'unauthorized']) {
  test(`never repeats uncertain submissions: ${failure}`, async () => {
    let submissions = 0;
    const api = createApiClient('http://local', async (url) => {
      if (url.endsWith('/api/session')) return new Response('{}', { headers: { 'set-cookie': 'h3mise_session=test' } });
      submissions++;
      if (failure === 'network') throw new Error('connection lost after sending');
      return new Response('{}', { status: failure === 'server' ? 500 : 401 });
    });
    await assert.rejects(api('POST', '/api/render', { shotId: 's1' }));
    assert.equal(submissions, failure === 'unauthorized' ? 2 : 1);
  });
}
