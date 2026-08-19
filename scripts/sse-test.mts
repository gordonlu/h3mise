// SSE delivery test: connect, trigger a render event, read the stream.
const session = await fetch('http://127.0.0.1:4789/api/session');
const cookie = (session.headers.get('set-cookie') ?? '').split(';')[0];
console.log('session cookie:', cookie?.slice(0, 20));

const ac = new AbortController();
const res = await fetch('http://127.0.0.1:4789/api/events', { headers: { cookie }, signal: ac.signal });
console.log('SSE status:', res.status);
const reader = res.body!.getReader();
const decoder = new TextDecoder();

// trigger events in parallel
setTimeout(async () => {
  const shots = await (await fetch('http://127.0.0.1:4789/api/shots', { headers: { cookie } })).json();
  const shotId = shots[0].id;
  const prompts = await (await fetch(`http://127.0.0.1:4789/api/shots/${shotId}/prompts`, { headers: { cookie } })).json();
  const pv = prompts[0]?.id;
  await fetch('http://127.0.0.1:4789/api/render', {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ shotId, promptVersionId: pv, providerId: 'mock', durationSeconds: 5 }),
  });
}, 500);

const deadline = Date.now() + 8000;
let got = '';
while (Date.now() < deadline) {
  const { value, done } = await reader.read();
  if (done) break;
  got += decoder.decode(value);
  if (got.includes('render.job')) break;
}
console.log('received:', got.slice(0, 300));
ac.abort();
