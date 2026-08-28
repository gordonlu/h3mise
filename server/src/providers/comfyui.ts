// ComfyUI local API provider. Executes an imported API-format workflow while
// H3Mise keeps story/Shot/Take/continuity state and final editing local.

import { readFile } from 'node:fs/promises';
import type {
  ComfyUiInputBinding,
  ComfyUiWorkflowProfile,
  MediaAsset,
  ProviderCapabilities,
} from '@h3mise/shared';
import type { RenderJobHandle, RenderRequestInput, RenderResult, RenderStatus, UploadedAsset, VideoProvider } from './types.js';
import { ProviderError } from './types.js';

interface ComfyOutputFile {
  filename: string;
  subfolder?: string;
  type?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class ComfyUiProvider implements VideoProvider {
  readonly id = 'comfyui';
  readonly name = 'ComfyUI Local';

  constructor(readonly profile: ComfyUiWorkflowProfile, private readonly requestTimeoutMs = 120_000) {}

  get configured(): boolean {
    return Object.keys(this.profile.workflow).length > 0
      && this.profile.capabilities.supportedModes.length > 0
      && (this.profile.verification.status === 'nodes_detected' || this.profile.verification.status === 'verified');
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return this.profile.capabilities;
  }

  private endpoint(path: string): string {
    let url: URL;
    try {
      url = new URL(this.profile.baseUrl);
    } catch {
      throw new ProviderError('ComfyUI baseUrl is invalid', 'submit');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw new ProviderError('ComfyUI baseUrl must use http or https', 'submit');
    const host = url.hostname.toLowerCase();
    const loopback = host === 'localhost' || host === '::1' || host.startsWith('127.');
    if (!loopback && !this.profile.allowRemote) {
      throw new ProviderError('non-loopback ComfyUI URL is blocked; set allowRemote=true explicitly after reviewing the endpoint', 'submit');
    }
    return `${url.toString().replace(/\/$/, '')}${this.profile.apiPrefix}${path}`;
  }

  private async requestJson(path: string, init?: RequestInit, stage: 'upload' | 'submit' | 'poll' | 'download' = 'poll'): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.endpoint(path), {
        ...init,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      throw new ProviderError(`ComfyUI request failed: ${error instanceof Error ? error.message : error}`, stage, { path });
    }
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ProviderError(`ComfyUI HTTP ${response.status}: ${JSON.stringify(body)?.slice(0, 500)}`, stage, { path, body });
    }
    return body;
  }

  async probe(): Promise<{ systemStats: unknown; objectInfo: unknown }> {
    const [systemStats, objectInfo] = await Promise.all([
      this.requestJson('/system_stats', undefined, 'submit'),
      this.requestJson('/object_info', undefined, 'submit'),
    ]);
    return { systemStats, objectInfo };
  }

  async uploadAsset(asset: MediaAsset, localPath: string): Promise<UploadedAsset> {
    if (asset.kind !== 'image') {
      throw new ProviderError('ComfyUI Local currently supports image references only', 'upload', { assetId: asset.id, kind: asset.kind });
    }
    const bytes = await readFile(localPath);
    const original = asset.fileName.split(/[\\/]/).pop() ?? 'image.png';
    const safe = `${asset.id}-${original}`.replace(/[^a-zA-Z0-9._-]+/g, '-');
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(bytes)], { type: asset.mimeType || 'application/octet-stream' }), safe);
    form.append('type', 'input');
    form.append('subfolder', 'h3mise');
    form.append('overwrite', 'true');
    const raw = await this.requestJson('/upload/image', { method: 'POST', body: form }, 'upload');
    const result = isRecord(raw) ? raw : {};
    const name = typeof result.name === 'string' ? result.name : safe;
    const subfolder = typeof result.subfolder === 'string' ? result.subfolder : 'h3mise';
    return { providerRef: subfolder ? `${subfolder}/${name}` : name, meta: result };
  }

  private mappedValue(binding: ComfyUiInputBinding, canonical: string | number | boolean): unknown {
    return binding.valueMap?.[String(canonical)] ?? canonical;
  }

  private setInput(workflow: ComfyUiWorkflowProfile['workflow'], binding: ComfyUiInputBinding | undefined, value: unknown): void {
    if (!binding || value === undefined || value === null) return;
    const node = workflow[binding.nodeId];
    if (!node) throw new ProviderError(`ComfyUI mapping references missing node ${binding.nodeId}`, 'submit');
    if (!Object.prototype.hasOwnProperty.call(node.inputs, binding.inputName)) {
      throw new ProviderError(`ComfyUI node ${binding.nodeId} has no input "${binding.inputName}"`, 'submit');
    }
    node.inputs[binding.inputName] = this.mappedValue(binding, value as string | number | boolean);
  }

  buildWorkflow(request: RenderRequestInput): ComfyUiWorkflowProfile['workflow'] {
    const workflow = structuredClone(this.profile.workflow);
    const inputs = this.profile.inputs;
    this.setInput(workflow, inputs.prompt, request.prompt);
    this.setInput(workflow, inputs.mode, request.mode);
    this.setInput(workflow, inputs.duration, request.durationSeconds);
    this.setInput(workflow, inputs.aspectRatio, request.aspectRatio || request.resolution || '');
    this.setInput(workflow, inputs.megapixels, request.megapixels);

    const first = request.references.find((item) => item.roles.includes('first_frame'));
    const last = request.references.find((item) => item.roles.includes('last_frame'));
    if (request.mode === 'ref2va') {
      const images = request.references.filter((item) => item.asset.kind === 'image').map((item) => item.providerRef);
      if (images.length > inputs.refImages.length) {
        throw new ProviderError(`ComfyUI workflow has ${inputs.refImages.length} reference-image slot(s), but ${images.length} image(s) were provided`, 'submit');
      }
      images.forEach((image, index) => this.setInput(workflow, inputs.refImages[index], image));
    } else {
      this.setInput(workflow, inputs.firstFrame, first?.providerRef);
      this.setInput(workflow, inputs.lastFrame, last?.providerRef);
    }
    for (const [key, value] of Object.entries(request.providerParams)) {
      const binding = this.profile.providerParamBindings?.[key];
      if (!binding) throw new ProviderError(`unknown ComfyUI providerParam "${key}": add an explicit providerParamBindings entry`, 'submit');
      this.setInput(workflow, binding, value);
    }
    return workflow;
  }

  async submit(request: RenderRequestInput): Promise<RenderJobHandle> {
    if (!this.configured) throw new ProviderError('ComfyUI profile is not connected and mapped', 'submit');
    const workflow = this.buildWorkflow(request);
    const raw = await this.requestJson('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: this.profile.clientId }),
    }, 'submit');
    const result = isRecord(raw) ? raw : {};
    const promptId = typeof result.prompt_id === 'string' ? result.prompt_id : '';
    if (!promptId) {
      throw new ProviderError(`ComfyUI rejected workflow: ${JSON.stringify(result.error ?? result.node_errors ?? raw)?.slice(0, 800)}`, 'submit', raw);
    }
    return { providerTaskId: promptId, raw: result };
  }

  private outputFile(historyItem: Record<string, unknown>): ComfyOutputFile | null {
    const outputs = isRecord(historyItem.outputs) ? historyItem.outputs : {};
    const ordered = this.profile.outputNodeId && outputs[this.profile.outputNodeId]
      ? [outputs[this.profile.outputNodeId], ...Object.entries(outputs).filter(([id]) => id !== this.profile.outputNodeId).map(([, value]) => value)]
      : Object.values(outputs);
    const videoExt = /\.(mp4|webm|mov|mkv|gif)$/i;
    for (const value of ordered) {
      if (!isRecord(value)) continue;
      for (const list of Object.values(value)) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          if (!isRecord(item) || typeof item.filename !== 'string') continue;
          const file = {
            filename: item.filename,
            subfolder: typeof item.subfolder === 'string' ? item.subfolder : '',
            type: typeof item.type === 'string' ? item.type : 'output',
          };
          if (videoExt.test(file.filename)) return file;
        }
      }
    }
    return null;
  }

  private resultUrl(file: ComfyOutputFile): string {
    const query = new URLSearchParams({
      filename: file.filename,
      subfolder: file.subfolder ?? '',
      type: file.type ?? 'output',
    });
    return `${this.endpoint('/view')}?${query}`;
  }

  async status(handle: RenderJobHandle): Promise<RenderStatus> {
    let raw: unknown;
    try {
      raw = await this.requestJson(`/history/${encodeURIComponent(handle.providerTaskId)}`, undefined, 'poll');
    } catch (error) {
      return { status: 'RUNNING', transient: true, error: error instanceof Error ? error.message : String(error) };
    }
    const root = isRecord(raw) ? raw : {};
    const item = isRecord(root[handle.providerTaskId]) ? root[handle.providerTaskId] as Record<string, unknown> : null;
    if (item) {
      const status = isRecord(item.status) ? item.status : {};
      const statusText = String(status.status_str ?? '').toLowerCase();
      if (statusText === 'error' || statusText === 'failed') {
        return { status: 'FAILED', error: JSON.stringify(status.messages ?? item).slice(0, 1000) };
      }
      if (status.completed === true || statusText === 'success') {
        const file = this.outputFile(item);
        if (!file) return { status: 'FAILED', error: 'ComfyUI workflow completed but no output file was found' };
        return { status: 'SUCCEEDED', resultUrl: this.resultUrl(file) };
      }
    }
    try {
      const queue = await this.requestJson('/queue', undefined, 'poll');
      const text = JSON.stringify(queue);
      if (text.includes(handle.providerTaskId)) {
        const running = isRecord(queue) && JSON.stringify(queue.queue_running ?? []).includes(handle.providerTaskId);
        return { status: running ? 'RUNNING' : 'QUEUED' };
      }
    } catch {
      // History polling remains authoritative; a queue hiccup is transient.
    }
    return { status: 'RUNNING', transient: true, error: 'prompt not present in history or queue yet' };
  }

  async result(handle: RenderJobHandle): Promise<RenderResult> {
    const result = await this.status(handle);
    if (result.status !== 'SUCCEEDED' || !result.resultUrl) {
      throw new ProviderError(result.error ?? 'ComfyUI prompt has not completed', 'poll', result);
    }
    return { url: result.resultUrl, meta: { promptId: handle.providerTaskId } };
  }

  async cancel(handle: RenderJobHandle): Promise<void> {
    // Deleting a queued prompt is task-scoped. /interrupt is intentionally not
    // called because it is global and may kill work submitted outside H3Mise.
    await this.requestJson('/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [handle.providerTaskId] }),
    }, 'poll');
  }
}
