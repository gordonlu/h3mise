import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OpenAICompatModel } from '../src/modules/ai.js';
import { shotMultimodalContent } from '../src/modules/ai-actions.js';
import { createBinding, insertMedia } from '../src/modules/assets.js';
import { createShot } from '../src/modules/shots.js';
import { cleanupTempRoot, makeProject, makeStore } from './helpers.js';

const roots: string[] = [];
after(() => roots.forEach((root) => cleanupTempRoot(root)));

test('OpenAI-compatible multimodal failure falls back to the same text without images', async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const requests: Array<Record<string, unknown>> = [];
  console.warn = () => undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    if (requests.length === 1) return new Response('{"error":"vision unsupported"}', { status: 400 });
    return Response.json({ choices: [{ message: { content: 'text fallback result' } }] });
  }) as typeof fetch;
  try {
    const model = new OpenAICompatModel('https://ai.invalid/v1', 'secret', 'text-model');
    let visionStatus: unknown = null;
    const result = await model.complete({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'keep this exact textual context' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1n', detail: 'high' } },
        ],
      }],
      onVisionStatus: (status) => { visionStatus = status; },
    });
    assert.equal(result, 'text fallback result');
    assert.equal(requests.length, 2);
    const firstMessages = requests[0]!.messages as Array<{ content: unknown }>;
    const fallbackMessages = requests[1]!.messages as Array<{ content: unknown }>;
    assert.ok(Array.isArray(firstMessages[0]!.content));
    assert.equal(fallbackMessages[0]!.content, 'keep this exact textual context');
    assert.doesNotMatch(JSON.stringify(requests[1]), /image_url|base64/);
    assert.deepEqual(visionStatus, { mode: 'text_fallback', imageCount: 1 });
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

test('OpenAI-compatible model reports accepted multimodal image count', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: 'vision result' } }] })) as typeof fetch;
  try {
    const model = new OpenAICompatModel('https://ai.invalid/v1', 'secret', 'vision-model');
    let visionStatus: unknown = null;
    await model.complete({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'inspect' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,Yg==' } },
        ],
      }],
      onVisionStatus: (status) => { visionStatus = status; },
    });
    assert.deepEqual(visionStatus, { mode: 'multimodal', imageCount: 2 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('shot multimodal content attaches local reference images in Picture order', async () => {
  const { root, store } = await makeStore('ai-vision-content');
  roots.push(root);
  const project = await makeProject(store, 'vision');
  const shot = createShot(project, { title: 'Vision Shot' });
  const rel = 'assets/reference.png';
  const abs = project.resolveProjectPath(rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, 'img');
  const media = insertMedia(project, { kind: 'image', fileName: rel, mimeType: 'image/png', sizeBytes: 3, label: 'Left frame' });
  createBinding(project, { assetId: media.id, shotId: shot.id, roles: ['first_frame'], preserve: ['composition'], label: 'Opening frame' });

  const content = await shotMultimodalContent(project, shot.id, 'Prompt text');
  assert.ok(Array.isArray(content));
  assert.equal(content[0]?.type, 'text');
  assert.match(content[1]?.type === 'text' ? content[1].text : '', /<Picture 1>.*Opening frame.*first_frame/);
  assert.equal(content[2]?.type, 'image_url');
  if (content[2]?.type === 'image_url') assert.equal(content[2].image_url.url, 'data:image/png;base64,aW1n');
});
