import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ComfyUiApiNode, MediaAsset } from '@h3mise/shared';
import type { RenderRequestInput } from '../src/providers/types.js';
import { ComfyUiProvider } from '../src/providers/comfyui.js';
import { importComfyUiWorkflow } from '../src/providers/comfyui-profile.js';

const tempDirs: string[] = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function requestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

test('ComfyUI provider maps inputs, uploads frames, polls history, and cancels only its queued prompt', async (t) => {
  let submitted: Record<string, unknown> | null = null;
  let cancelBody: Record<string, unknown> | null = null;
  let uploadWasMultipart = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/system_stats') return json(res, { system: { os: 'test' } });
    if (req.method === 'GET' && url.pathname === '/object_info') return json(res, { CLIPTextEncode: {} });
    if (req.method === 'POST' && url.pathname === '/upload/image') {
      uploadWasMultipart = String(req.headers['content-type']).startsWith('multipart/form-data;');
      await requestBody(req);
      return json(res, { name: 'frame.png', subfolder: 'h3mise', type: 'input' });
    }
    if (req.method === 'POST' && url.pathname === '/prompt') {
      submitted = JSON.parse(await requestBody(req)) as Record<string, unknown>;
      return json(res, { prompt_id: 'prompt-1', number: 1 });
    }
    if (req.method === 'GET' && url.pathname === '/history/prompt-1') {
      return json(res, {
        'prompt-1': {
          status: { completed: true, status_str: 'success' },
          outputs: {
            '30': { videos: [{ filename: 'result.mp4', subfolder: 'video', type: 'output' }] },
            '31': { images: [{ filename: 'preview.png', subfolder: '', type: 'temp' }] },
          },
        },
      });
    }
    if (req.method === 'GET' && url.pathname === '/queue') return json(res, { queue_running: [], queue_pending: [] });
    if (req.method === 'POST' && url.pathname === '/queue') {
      cancelBody = JSON.parse(await requestBody(req)) as Record<string, unknown>;
      return json(res, {});
    }
    return json(res, { error: 'not found' }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const workflow: Record<string, ComfyUiApiNode> = {
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '' }, _meta: { title: 'H3Mise Prompt' } },
    '12': { class_type: 'LoadImage', inputs: { image: '' }, _meta: { title: 'H3Mise First Frame' } },
    '13': { class_type: 'LoadImage', inputs: { image: '' }, _meta: { title: 'H3Mise Last Frame' } },
    '21': {
      class_type: 'VideoSettings',
      inputs: { duration: 5, aspect_ratio: '16:9', megapixels: 0.6 },
      _meta: { title: 'H3Mise Video Settings' },
    },
    '30': { class_type: 'VHS_VideoCombine', inputs: { filename_prefix: 'H3Mise' }, _meta: { title: 'H3Mise Video Output' } },
  };
  const imported = importComfyUiWorkflow({
    provider: 'comfyui',
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiPrefix: '',
    clientId: 'h3mise-test',
    allowRemote: false,
    workflow: {},
    inputs: { refImages: [] },
    capabilities: { supportedModes: [] },
    verification: { status: 'unconfigured', checkedAt: null, note: '' },
  }, workflow);
  assert.deepEqual(imported.capabilities.supportedModes, ['t2va', 'i2va', 'l2va', 'fl2va']);
  assert.equal(imported.outputNodeId, '30');

  const provider = new ComfyUiProvider({
    ...imported,
    verification: { status: 'nodes_detected', checkedAt: new Date().toISOString(), note: 'test' },
  });
  await provider.probe();

  const dir = await mkdtemp(join(tmpdir(), 'h3mise-comfy-test-'));
  tempDirs.push(dir);
  const imagePath = join(dir, 'frame.png');
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const asset: MediaAsset = {
    id: 'asset-frame', kind: 'image', fileName: 'frame.png', mimeType: 'image/png', sizeBytes: 4,
    source: 'import', label: 'frame', tags: [], createdAt: new Date().toISOString(),
  };
  const first = await provider.uploadAsset(asset, imagePath);
  assert.equal(first.providerRef, 'h3mise/frame.png');
  assert.equal(uploadWasMultipart, true);

  const request: RenderRequestInput = {
    mode: 'fl2va',
    prompt: 'A dog waits by the door.',
    durationSeconds: 8,
    aspectRatio: '9:16',
    megapixels: 1.2,
    references: [
      { asset, roles: ['first_frame'], label: 'first', providerRef: first.providerRef },
      { asset, roles: ['last_frame'], label: 'last', providerRef: 'h3mise/last.png' },
    ],
    providerParams: {},
  };
  const handle = await provider.submit(request);
  assert.equal(handle.providerTaskId, 'prompt-1');
  const submittedBody = submitted as Record<string, unknown> | null;
  assert.ok(submittedBody);
  const submittedWorkflow = submittedBody.prompt as Record<string, ComfyUiApiNode>;
  assert.equal(submittedWorkflow['6']?.inputs.text, request.prompt);
  assert.equal(submittedWorkflow['12']?.inputs.image, 'h3mise/frame.png');
  assert.equal(submittedWorkflow['13']?.inputs.image, 'h3mise/last.png');
  assert.equal(submittedWorkflow['21']?.inputs.duration, 8);
  assert.equal(submittedWorkflow['21']?.inputs.aspect_ratio, '9:16');
  assert.equal(submittedWorkflow['21']?.inputs.megapixels, 1.2);

  const status = await provider.status(handle);
  assert.equal(status.status, 'SUCCEEDED');
  assert.match(status.resultUrl ?? '', /\/view\?filename=result\.mp4&subfolder=video&type=output$/);
  const result = await provider.result(handle);
  assert.equal(result.meta?.promptId, 'prompt-1');

  await provider.cancel(handle);
  assert.deepEqual(cancelBody, { delete: ['prompt-1'] });
});

test('ComfyUI provider blocks non-loopback endpoints unless explicitly enabled', async () => {
  const provider = new ComfyUiProvider({
    provider: 'comfyui', baseUrl: 'http://192.0.2.1:8188', apiPrefix: '', clientId: 'test', allowRemote: false,
    workflow: { '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } } },
    inputs: { prompt: { nodeId: '1', inputName: 'text' }, refImages: [] },
    capabilities: { supportedModes: ['t2va'] },
    verification: { status: 'nodes_detected', checkedAt: null, note: '' },
  });

  await assert.rejects(provider.probe(), /non-loopback ComfyUI URL is blocked/);
});

test('ComfyUI result selection rejects preview images instead of creating a broken video Take', async () => {
  const provider = new ComfyUiProvider({
    provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', apiPrefix: '', clientId: 'test', allowRemote: false,
    workflow: { '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } } },
    inputs: { prompt: { nodeId: '1', inputName: 'text' }, refImages: [] },
    outputNodeId: '2', capabilities: { supportedModes: ['t2va'] },
    verification: { status: 'nodes_detected', checkedAt: null, note: '' },
  });
  const outputFile = (provider as unknown as { outputFile(item: Record<string, unknown>): unknown }).outputFile({
    outputs: { '2': { images: [{ filename: 'preview.png', type: 'temp' }] } },
  });
  assert.equal(outputFile, null);
});
