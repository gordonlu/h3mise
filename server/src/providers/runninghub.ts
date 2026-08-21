// RunningHubAiAppProvider — PRD §25. Calls the user's own published AI App
// via the personal key (RUNNINGHUB_API_KEY) over the v2 API.
//
// Protocol facts (verified against official docs + live probes, 2026-08-19):
//   upload  POST /openapi/v2/media/upload/binary   (multipart "file", Bearer)
//           -> {code:0, data:{fileName, download_url}}   (errors: code!=0)
//   submit  POST /openapi/v2/run/ai-app/:id        (JSON, Bearer)
//           -> flat {taskId, status, errorCode, errorMessage, results}
//   poll    POST /openapi/v2/query                 (JSON {taskId}, Bearer)
//           -> flat {status: QUEUED|RUNNING|SUCCESS|FAILED, results:[{url}],
//                    usage:{consumeMoney,...}, errorCode, errorMessage}
//   result  GET  results[].url (pre-signed, no auth, valid 24h)
//   detect  GET  /api/webapp/apiCallDemo?apiKey&webappId -> data.nodeInfoList
//
// All endpoints return HTTP 200 even on errors — errors live in the body.
// The exact node layout of the app lives ONLY in the AiAppProfile; this
// adapter just executes it. Empty nodeInfoList is rejected (1101), so we
// always include at least the prompt node.

import {} from 'node:fs';
import type { AiAppProfile, ProviderCapabilities } from '@h3mise/shared';
import type { RenderJobHandle, RenderRequestInput, RenderResult, RenderStatus, UploadedAsset, VideoProvider } from './types.js';
import { ProviderError } from './types.js';

export const RH_BASE = 'https://www.runninghub.cn';

export interface RunningHubOptions {
  apiKey: string | null;
  profile: AiAppProfile;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
}

const STATUS_MAP: Record<string, RenderStatus['status']> = {
  QUEUED: 'QUEUED',
  queued: 'QUEUED',
  queueing: 'QUEUED',
  RUNNING: 'RUNNING',
  running: 'RUNNING',
  processing: 'RUNNING',
  SUCCESS: 'SUCCEEDED',
  success: 'SUCCEEDED',
  succeeded: 'SUCCEEDED',
  FAILED: 'FAILED',
  failed: 'FAILED',
  fail: 'FAILED',
  error: 'FAILED',
  EXPIRED: 'EXPIRED',
  expired: 'EXPIRED',
};

export class RunningHubAiAppProvider implements VideoProvider {
  readonly id = 'runninghub';

  // NB: getter, NOT a field initializer — field initializers run before the
  // constructor assigns `options`, which would crash on `this.options.profile`.
  get name(): string {
    return `RunningHub AI App ${this.profile.appId}`;
  }

  constructor(private readonly options: RunningHubOptions) {}

  get profile(): AiAppProfile {
    return this.options.profile;
  }

  get configured(): boolean {
    return Boolean(this.options.apiKey);
  }

  private get key(): string {
    if (!this.options.apiKey) throw new ProviderError('RUNNINGHUB_API_KEY is not set', 'submit');
    return this.options.apiKey;
  }

  private async v2(path: string, body?: unknown, init: RequestInit = {}): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${RH_BASE}${path}`, {
        ...init,
        // Body-carrying calls are POST (submit / query); GET only when no body.
        method: init.method ?? (body !== undefined ? 'POST' : 'GET'),
        headers: {
          Authorization: `Bearer ${this.key}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
        body: body !== undefined ? JSON.stringify(body) : init.body,
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 120_000),
      });
    } catch (e) {
      throw new ProviderError(`RunningHub request failed: ${e instanceof Error ? e.message : e}`, 'submit', { path });
    }
    const json = (await res.json().catch(() => null)) as unknown;
    // v2 endpoints return HTTP 200 even on errors; envelopes vary (flat vs {code,msg}).
    if (res.ok) return json;
    throw new ProviderError(`RunningHub HTTP ${res.status}: ${JSON.stringify(json)?.slice(0, 300)}`, 'submit', { path, status: res.status });
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return this.profile.capabilities;
  }

  /**
   * Fetch the app's actual node layout (apiCallDemo). Returns raw nodes.
   * Throws ProviderError when the key/app is invalid.
   */
  async discoverNodes(): Promise<AiAppProfile['nodes']> {
    const url = `${RH_BASE}/api/webapp/apiCallDemo?apiKey=${encodeURIComponent(this.key)}&webappId=${this.profile.appId}`;
    // P1: never let the API key leak into error metadata / debug output.
    const redactedUrl = url.replace(encodeURIComponent(this.key), '***');
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new ProviderError(`node discovery failed: ${e instanceof Error ? e.message : e}`, 'submit', { url: redactedUrl });
    }
    const json = (await res.json().catch(() => null)) as { code?: number; msg?: string; data?: { nodeInfoList?: Array<Record<string, unknown>> } } | null;
    const list = json?.data?.nodeInfoList;
    if (!Array.isArray(list)) {
      throw new ProviderError(`node discovery failed: ${json?.msg ?? JSON.stringify(json)?.slice(0, 200)}`, 'submit', json);
    }
    return list.map((n) => ({
      nodeId: String(n.nodeId ?? ''),
      nodeName: String(n.nodeName ?? ''),
      fieldName: String(n.fieldName ?? ''),
      fieldType: String(n.fieldType ?? 'STRING'),
      fieldData: n.fieldData ? String(n.fieldData) : null,
      description: String(n.description ?? n.descriptionEn ?? ''),
    }));
  }

  /** Upload a local asset; returns the fileName to place into nodeInfoList. */
  async uploadAsset(asset: import('@h3mise/shared').MediaAsset, localPath: string): Promise<UploadedAsset> {
    const buf = await import('node:fs/promises').then((fs) => fs.readFile(localPath));
    const form = new FormData();
    const blob = new Blob([new Uint8Array(buf)], { type: asset.mimeType || 'application/octet-stream' });
    form.append('file', blob, asset.fileName.split('/').pop() ?? 'upload');
    let res: Response;
    try {
      res = await fetch(`${RH_BASE}/openapi/v2/media/upload/binary`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.key}` },
        body: form,
        signal: AbortSignal.timeout(180_000),
      });
    } catch (e) {
      throw new ProviderError(`upload failed: ${e instanceof Error ? e.message : e}`, 'upload');
    }
    const json = (await res.json().catch(() => null)) as {
      code?: number;
      msg?: string;
      message?: string;
      data?: { fileName?: string };
    } | null;
    const fileName = json?.data?.fileName;
    if (json?.code !== 0 || !fileName) {
      throw new ProviderError(`upload failed: ${json?.msg ?? json?.message ?? `HTTP ${res.status}`}`, 'upload', json);
    }
    return { providerRef: fileName, meta: json };
  }

  /** Map business references to profile slots, then build nodeInfoList. */
  submit(request: RenderRequestInput): Promise<RenderJobHandle> {
    const nodeInfoList = this.buildNodeInfoList(request);
    const body: Record<string, unknown> = { nodeInfoList };
    return this.v2(`/openapi/v2/run/ai-app/${this.profile.appId}`, body).then((raw) => {
      const r = raw as { taskId?: string; status?: string; errorCode?: string; errorMessage?: string; results?: unknown };
      if (!r.taskId || (r.errorCode && r.errorCode !== '')) {
        throw new ProviderError(`submit failed: ${r.errorCode ?? '?'} ${r.errorMessage ?? JSON.stringify(raw)?.slice(0, 300)}`, 'submit', raw);
      }
      return { providerTaskId: String(r.taskId), raw: raw as Record<string, unknown> };
    });
  }

  private buildNodeInfoList(request: RenderRequestInput): Array<{ nodeId: string; fieldName: string; fieldValue: string }> {
    const inputs = this.profile.inputs;
    const out: Array<{ nodeId: string; fieldName: string; fieldValue: string }> = [];
    const push = (slot: { nodeId: string; fieldName: string } | undefined, value: string | undefined) => {
      // nodeId '' = disabled slot (workflow has no such node): never send it.
      if (slot && slot.nodeId !== '' && value !== undefined && value !== '') {
        out.push({ nodeId: slot.nodeId, fieldName: slot.fieldName, fieldValue: value });
      }
    };
    // Fill an array slot (ref_images.ref_image_0..8) in order; each entry is
    // one physical input on the workflow node.
    const pushArray = (slots: Array<{ nodeId: string; fieldName: string }>, values: string[]) => {
      for (let i = 0; i < Math.min(slots.length, values.length); i++) {
        const slot = slots[i];
        if (slot && slot.nodeId !== '') {
          const v = values[i];
          if (v !== undefined) out.push({ nodeId: slot.nodeId, fieldName: slot.fieldName, fieldValue: v });
        }
      }
    };
    push(inputs.prompt, request.prompt);
    if (inputs.mode) {
      push(inputs.mode, request.mode.toUpperCase());
    }
    // Two mutually exclusive reference modes (workflow contract):
    //  - ref2va → reference slots (ref_images/ref_audios); first/last frame
    //    inputs are ignored. (ref_videos was dropped from the RunningHub API.)
    //  - i2va/l2va/fl2va → first/last frame slots only; reference slots are
    //    not sent.
    const firstFrameRef = request.references.find((r) => r.roles.includes('first_frame'));
    const lastFrameRef = request.references.find((r) => r.roles.includes('last_frame'));
    if (request.mode === 'ref2va') {
      const images = request.references.filter((r) => r.asset.kind === 'image').map((r) => r.providerRef);
      const audios = request.references.filter((r) => r.asset.kind === 'audio').map((r) => r.providerRef);
      this.validateRefLimits(images.length, audios.length, request.references);
      pushArray(inputs.refImages, images);
      pushArray(inputs.refAudios, audios);
    } else {
      push(inputs.firstFrame, firstFrameRef?.providerRef);
      push(inputs.lastFrame, lastFrameRef?.providerRef);
    }
    push(inputs.duration, request.durationSeconds ? String(Math.round(request.durationSeconds)) : undefined);
    push(inputs.resolution, request.resolution);
    // P0-4: providerParams are ONLY written through explicit per-key bindings
    // from the profile. An unknown param is refused — never guessed into the
    // prompt node or any other slot.
    for (const [k, v] of Object.entries(request.providerParams)) {
      const binding = this.profile.providerParamBindings?.[k];
      if (!binding) {
        throw new ProviderError(
          `unknown providerParam "${k}": add a providerParamBindings entry (nodeId/fieldName) to the AI App profile or remove the param`,
          'submit',
        );
      }
      push(binding, v === null || v === undefined ? undefined : String(v));
    }
    return out;
  }

  /** RunningHub reference limits: ≤9 images, ≤3 audios, ≤12 total, each
   * audio 2–15s with combined length ≤15s, and audio can never be the only
   * reference (needs ≥1 image). (ref_videos was dropped from the API.) */
  private validateRefLimits(
    imageCount: number,
    audioCount: number,
    refs: RenderRequestInput['references'],
  ): void {
    const cap = this.profile.capabilities;
    if (imageCount > (cap.maxImageRefs ?? 9)) throw new ProviderError(`参考图片最多 ${cap.maxImageRefs ?? 9} 张（当前 ${imageCount} 张）`, 'submit');
    if (audioCount > (cap.maxAudioRefs ?? 3)) throw new ProviderError(`参考音频最多 ${cap.maxAudioRefs ?? 3} 个（当前 ${audioCount} 个）`, 'submit');
    if (imageCount + audioCount > (cap.maxTotalRefs ?? 12)) {
      throw new ProviderError(`参考文件合计最多 ${cap.maxTotalRefs ?? 12} 个（当前 ${imageCount + audioCount} 个）`, 'submit');
    }
    const audSecs = refs.filter((r) => r.asset.kind === 'audio').reduce((sum, r) => sum + (r.asset.durationSeconds ?? 0), 0);
    if (audSecs > 15) throw new ProviderError('参考音频总时长不能超过 15 秒', 'submit');
    const tooLong = refs.find((r) => r.asset.kind === 'audio' && r.asset.durationSeconds != null && r.asset.durationSeconds > 15);
    if (tooLong) throw new ProviderError(`单个参考音频时长不能超过 15 秒（当前 ${tooLong.asset.durationSeconds}s）`, 'submit');
    if (audioCount > 0 && imageCount === 0) {
      throw new ProviderError('参考音频不能单独作为唯一参考，请至少同时提供一张参考图片', 'submit');
    }
  }

  async status(handle: RenderJobHandle): Promise<RenderStatus> {
    const raw = (await this.v2('/openapi/v2/query', { taskId: handle.providerTaskId })) as {
      status?: string;
      errorCode?: string;
      errorMessage?: string;
      failedReason?: unknown;
      results?: Array<{ url?: string; outputType?: string }> | null;
      usage?: { consumeMoney?: number | string | null; consumeCoins?: number | string | null; taskCostTime?: string | null };
    };
    const mapped = STATUS_MAP[String(raw?.status ?? '')];
    if (!mapped) {
      // Error encoded in body (e.g. 806 user not found).
      return { status: 'FAILED', error: `${raw?.errorCode ?? '?'}: ${raw?.errorMessage ?? JSON.stringify(raw)?.slice(0, 200)}` };
    }
    const result: RenderStatus = { status: mapped, error: raw?.failedReason ? JSON.stringify(raw.failedReason) : undefined };
    if (mapped === 'SUCCEEDED') {
      const urls = (raw?.results ?? []).map((r) => r.url).filter((u): u is string => Boolean(u));
      result.resultUrl = urls[0];
      result.cost = raw?.usage
        ? {
            credits: Number(raw.usage.consumeMoney ?? 0),
            unit: 'CNY',
            raw: raw.usage,
          }
        : undefined;
      if (!result.resultUrl) return { status: 'FAILED', error: 'task succeeded but no result URL' };
    }
    if (mapped === 'FAILED') {
      result.error = `${raw?.errorCode ?? ''} ${raw?.errorMessage ?? ''}`.trim() || 'task failed';
    }
    return result;
  }

  async result(handle: RenderJobHandle): Promise<RenderResult> {
    const st = await this.status(handle);
    if (st.status !== 'SUCCEEDED' || !st.resultUrl) {
      throw new ProviderError(st.error ?? 'task not succeeded', 'poll', st);
    }
    return { url: st.resultUrl, cost: st.cost };
  }

  async cancel(handle: RenderJobHandle): Promise<void> {
    // v2 has no documented cancel for AI App tasks; best effort via query is
    // not possible — so cancel is a local no-op that stops polling.
    void handle;
  }
}
