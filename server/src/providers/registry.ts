// Provider registry — the only place UI/code selects a render backend.
// v0.1: 'runninghub' (real) + 'mock' (offline). Provider profiles persist in
// the provider_profiles table so field mapping can be corrected without code.

import type { AiAppProfile, ProviderCapabilities, ProviderStatus } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { j, jget } from '../db/sqlite.js';
import type { Ffmpeg } from '../ffmpeg.js';
import type { VideoProvider } from './types.js';
import { RunningHubAiAppProvider } from './runninghub.js';
import { MockProvider } from './mock.js';

export const H3_AI_APP_ID = '2089265538441764866';
export const H3_AI_APP_URL = `https://www.runninghub.cn/openapi/v2/run/ai-app/${H3_AI_APP_ID}`;

/** Default profile for the fixed v0.1 AI App (PRD §25.3). Node layout is a
 * heuristic until the user runs "detect & verify" with a real key. */
export function defaultAiAppProfile(): AiAppProfile {
  return {
    provider: 'runninghub',
    appId: H3_AI_APP_ID,
    invokeUrl: H3_AI_APP_URL,
    protocolVersion: 'observed',
    capabilities: {
      supportedModes: ['t2va', 'i2va', 'fl2va', 'l2va', 'ref2va'],
      minDuration: 5,
      maxDuration: 15,
      supportedAspectRatios: ['16:9', '9:16'],
      supportedResolutions: ['720p', '1080p', '2K'],
      maxImageRefs: 3,
      maxVideoRefs: 1,
      maxAudioRefs: 1,
      audioSupported: true,
    },
    nodes: [],
    inputs: {
      prompt: { nodeId: 'node_1', fieldName: 'prompt' },
      mode: { nodeId: 'node_1', fieldName: 'mode' },
      firstFrame: { nodeId: 'node_1', fieldName: 'first_frame' },
      lastFrame: { nodeId: 'node_1', fieldName: 'last_frame' },
      motion: { nodeId: 'node_1', fieldName: 'motion_video' },
      audio: { nodeId: 'node_1', fieldName: 'audio' },
      duration: { nodeId: 'node_1', fieldName: 'duration' },
      resolution: { nodeId: 'node_1', fieldName: 'resolution' },
    },
    verification: { status: 'unverified', checkedAt: null, note: 'run "detect & verify" to capture the real node layout' },
  };
}

/** Heuristic: map a discovered node to a business input slot by field name. */
export function mapDiscoveredNodes(nodes: AiAppProfile['nodes']): AiAppProfile['inputs'] {
  const inputs = defaultAiAppProfile().inputs;
  const pick = (pred: (n: AiAppProfile['nodes'][number]) => boolean, fallback?: { nodeId: string; fieldName: string }) => {
    const n = nodes.find(pred);
    return n ? { nodeId: n.nodeId, fieldName: n.fieldName } : fallback!;
  };
  const has = (re: RegExp) => (n: AiAppProfile['nodes'][number]) => re.test(n.fieldName) || re.test(n.nodeName) || re.test(n.description);
  return {
    prompt: pick(has(/prompt|text|描述|提示词/i), inputs.prompt),
    mode: pick(has(/mode|模式/i), inputs.mode),
    firstFrame: pick(has(/first.?frame|首帧|start.?image|image1/i), inputs.firstFrame),
    lastFrame: pick(has(/last.?frame|尾帧|end.?image|image2/i), inputs.lastFrame),
    motion: pick(has(/motion|动作|video.?ref/i), inputs.motion),
    audio: pick(has(/audio|音频|sound/i), inputs.audio),
    duration: pick(has(/duration|时长/i), inputs.duration),
    resolution: pick(has(/resolution|分辨率/i), inputs.resolution),
  };
}

export class ProviderRegistry {
  private providers = new Map<string, VideoProvider>();
  private capsCache = new Map<string, ProviderCapabilities>();

  constructor(
    private readonly getProject: () => ProjectContext | null,
    private readonly ffmpeg: Ffmpeg,
    private readonly apiKey: string | null,
    private readonly mode: 'runninghub' | 'mock',
  ) {}

  /** Rebuild providers from the persisted profile (call after profile edits). */
  refresh(): void {
    const p = this.getProject();
    this.providers.clear();
    this.capsCache.clear();
    const mock = new MockProvider(this.ffmpeg, p?.paths.cache ?? '/tmp/h3mise-mock');
    if (this.mode === 'mock') {
      this.providers.set('mock', mock);
      return;
    }
    let profile = defaultAiAppProfile();
    if (p) {
      const row = p.db.get<{ profile_json: string }>("SELECT profile_json FROM provider_profiles WHERE id = 'runninghub'");
      if (row) profile = jget<AiAppProfile>(row.profile_json, profile);
    }
    this.providers.set('runninghub', new RunningHubAiAppProvider({ apiKey: this.apiKey, profile }));
    this.providers.set('mock', mock);
  }

  get(id: string): VideoProvider | undefined {
    return this.providers.get(id);
  }

  async capabilities(id: string): Promise<ProviderCapabilities | undefined> {
    const prov = this.providers.get(id);
    if (!prov) return undefined;
    if (!this.capsCache.has(id)) {
      try {
        this.capsCache.set(id, await prov.capabilities());
      } catch {
        this.capsCache.set(id, { supportedModes: [] });
      }
    }
    return this.capsCache.get(id);
  }

  async statuses(): Promise<ProviderStatus[]> {
    const out: ProviderStatus[] = [];
    for (const [id, prov] of this.providers) {
      const caps = await this.capabilities(id);
      const isRh = prov instanceof RunningHubAiAppProvider;
      const profile = isRh ? this.getProfile() : null;
      out.push({
        id,
        name: prov.name,
        kind: 'runninghub_ai_app',
        configured: prov.configured,
        verification: profile?.verification ?? { status: 'unverified', checkedAt: null, note: 'mock provider' },
        capabilities: caps ?? null,
      });
    }
    return out;
  }

  getProfile(): AiAppProfile | null {
    const p = this.getProject();
    if (!p) return null;
    const row = p.db.get<{ profile_json: string }>("SELECT profile_json FROM provider_profiles WHERE id = 'runninghub'");
    return row ? jget<AiAppProfile>(row.profile_json, defaultAiAppProfile()) : defaultAiAppProfile();
  }

  saveProfile(profile: AiAppProfile): AiAppProfile {
    const p = this.getProject();
    if (!p) throw new Error('no project open');
    p.db.run(
      'INSERT INTO provider_profiles (id, profile_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at',
      ['runninghub', j(profile), new Date().toISOString()],
    );
    this.refresh();
    return profile;
  }

  /**
   * Detect & verify: fetch the app's real node layout with the user's key,
   * map it to business inputs, persist, and refresh the provider.
   */
  async detectAndVerify(): Promise<AiAppProfile> {
    const p = this.getProject();
    if (!p) throw new Error('no project open');
    const current = this.getProfile() ?? defaultAiAppProfile();
    const provider = this.providers.get('runninghub');
    if (!provider || !(provider instanceof RunningHubAiAppProvider)) {
      throw new Error('runninghub provider not active (mock mode?)');
    }
    let nodes: AiAppProfile['nodes'];
    let note: string;
    try {
      nodes = await provider.discoverNodes();
      note = `detected ${nodes.length} node(s) via apiCallDemo`;
    } catch (e) {
      nodes = current.nodes;
      note = `detection failed: ${e instanceof Error ? e.message : e}`;
      const failed = { ...current, verification: { status: 'failed' as const, checkedAt: new Date().toISOString(), note } };
      return this.saveProfile(failed);
    }
    const updated: AiAppProfile = {
      ...current,
      nodes,
      inputs: mapDiscoveredNodes(nodes),
      verification: { status: 'verified', checkedAt: new Date().toISOString(), note },
    };
    return this.saveProfile(updated);
  }
}
