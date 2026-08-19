// Provider registry — the only place UI/code selects a render backend.
// v0.1: 'runninghub' (real) + 'mock' (offline). Provider profiles persist in
// the GLOBAL registry DB (account-level: the AI App belongs to the user's
// RunningHub account, not to any single project), so switching projects never
// loses the verified node mapping.

import type { AiAppProfile, H3Mode, ProviderCapabilities, ProviderStatus } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { j, jget, type Db } from '../db/sqlite.js';
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
      // Unknown until verified (P0-6): a heuristic default must not be
      // trusted as executable capability in front of a paid render.
      supportedModes: [],
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
    verification: { status: 'unconfigured', checkedAt: null, note: 'run "detect nodes" in Settings, then confirm with a real render' },
  };
}

/** Heuristic: map a discovered node to a business input slot by field name.
 * Slots with no matching node become DISABLED ({ nodeId: '' }): the adapter
 * must not send them (e.g. a workflow with a fixed mode has no mode node). */
export function mapDiscoveredNodes(nodes: AiAppProfile['nodes']): AiAppProfile['inputs'] {
  const inputs = defaultAiAppProfile().inputs;
  const pick = (pred: (n: AiAppProfile['nodes'][number]) => boolean, fallback?: { nodeId: string; fieldName: string }) => {
    const n = nodes.find(pred);
    return n ? { nodeId: n.nodeId, fieldName: n.fieldName } : { nodeId: '', fieldName: fallback?.fieldName ?? '' };
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
    private readonly getRegistryDb: () => Db,
    private readonly ffmpeg: Ffmpeg,
    private readonly envApiKey: string | null,
    private readonly mode: 'runninghub' | 'mock',
  ) {}

  /** User-set key from the settings page (kv) wins over the env var default. */
  getApiKey(): string | null {
    return this.getRegistryDb().get<{ value: string }>("SELECT value FROM kv WHERE key = 'runninghub_api_key'")?.value ?? null;
  }

  getEffectiveApiKey(): string | null {
    return this.getApiKey() ?? this.envApiKey;
  }

  saveApiKey(key: string): void {
    const k = key.trim();
    this.getRegistryDb().run("INSERT INTO kv (key, value) VALUES ('runninghub_api_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [k]);
    this.refresh();
  }

  getApiKeySource(): 'settings' | 'env' | 'none' {
    if (this.getApiKey()) return 'settings';
    if (this.envApiKey) return 'env';
    return 'none';
  }

  /** Truthful key report even when the registry only holds the mock provider. */
  get runningHubKeyPresent(): boolean {
    return this.getEffectiveApiKey() !== null;
  }

  get providerMode(): 'runninghub' | 'mock' {
    return this.mode;
  }

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
    const row = this.getRegistryDb().get<{ profile_json: string }>("SELECT profile_json FROM provider_profiles WHERE id = 'runninghub'");
    if (row) profile = jget<AiAppProfile>(row.profile_json, profile);
    this.providers.set('runninghub', new RunningHubAiAppProvider({ apiKey: this.getEffectiveApiKey(), profile }));
    this.providers.set('mock', mock);
  }

  get(id: string): VideoProvider | undefined {
    return this.providers.get(id);
  }

  async capabilities(id: string): Promise<ProviderCapabilities | undefined> {
    const prov = this.providers.get(id);
    if (!prov) return undefined;
    if (this.capsCache.has(id)) return this.capsCache.get(id);
    let caps = await prov.capabilities().catch(() => ({ supportedModes: [] as H3Mode[] }));
    // P0-6: capabilities of the runninghub adapter are only trusted once the
    // profile is verified by a real submission; otherwise nothing is
    // advertised as executable (unknown = blocked, not assumed).
    if (prov instanceof RunningHubAiAppProvider) {
      const v = this.getProfile()?.verification;
      if (v?.status !== 'verified') {
        caps = { supportedModes: [] };
      }
    }
    this.capsCache.set(id, caps);
    return caps;
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
        verification: profile?.verification ?? { status: 'unconfigured', checkedAt: null, note: 'mock provider' },
        capabilities: caps ?? null,
      });
    }
    return out;
  }

  getProfile(): AiAppProfile | null {
    const row = this.getRegistryDb().get<{ profile_json: string }>("SELECT profile_json FROM provider_profiles WHERE id = 'runninghub'");
    return row ? jget<AiAppProfile>(row.profile_json, defaultAiAppProfile()) : defaultAiAppProfile();
  }

  /** Merge a user-edited profile over defaults: appId must be non-empty,
   * every input slot needs a nodeId/fieldName, verification falls back. */
  private sanitizeProfile(raw: unknown): AiAppProfile {
    const d = defaultAiAppProfile();
    const base = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const appId = typeof base.appId === 'string' && base.appId.trim() ? base.appId.trim() : d.appId;
    const inputsIn = (base.inputs && typeof base.inputs === 'object' ? base.inputs : {}) as Record<string, unknown>;
    const inputs = {} as AiAppProfile['inputs'];
    for (const key of Object.keys(d.inputs) as Array<keyof AiAppProfile['inputs']>) {
      const def = d.inputs[key];
      const slot = (inputsIn[key] && typeof inputsIn[key] === 'object' ? inputsIn[key] : {}) as Record<string, unknown>;
      // Empty nodeId = explicitly disabled slot; keep it disabled (user intent).
      const nodeId = typeof slot.nodeId === 'string' ? slot.nodeId.trim() : def?.nodeId ?? '';
      inputs[key] = {
        nodeId,
        fieldName: typeof slot.fieldName === 'string' && slot.fieldName.trim() ? slot.fieldName.trim() : def?.fieldName ?? '',
      };
    }
    const verification = base.verification && typeof base.verification === 'object'
      ? base.verification
      : d.verification;
    return {
      ...d,
      ...base,
      appId,
      invokeUrl: typeof base.invokeUrl === 'string' && base.invokeUrl.trim() ? base.invokeUrl.trim() : d.invokeUrl,
      nodes: Array.isArray(base.nodes) ? base.nodes : d.nodes,
      inputs,
      verification: { ...d.verification, ...(verification as object) },
    } as AiAppProfile;
  }

  saveProfile(raw: unknown): AiAppProfile {
    const profile = this.sanitizeProfile(raw);
    this.getRegistryDb().run(
      'INSERT INTO provider_profiles (id, profile_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at',
      ['runninghub', j(profile), new Date().toISOString()],
    );
    this.refresh();
    return profile;
  }

  /**
   * Detect nodes: fetch the app's real node layout with the user's key and
   * map it to business inputs. P0-6: this is NOT a verification — the mapping
   * is heuristic until a real submission succeeds against it, so the status
   * becomes 'nodes_detected', not 'verified'.
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
      note = `detected ${nodes.length} node(s) via apiCallDemo — mapping not yet confirmed by a real render`;
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
      verification: { status: 'nodes_detected', checkedAt: new Date().toISOString(), note },
    };
    return this.saveProfile(updated);
  }

  /**
   * Called after a real provider submission returns a taskId: the mapping is
   * now confirmed executable → 'verified', which unlocks full capabilities.
   */
  confirmVerified(): AiAppProfile {
    const profile = this.getProfile() ?? defaultAiAppProfile();
    const updated: AiAppProfile = {
      ...profile,
      verification: { status: 'verified', checkedAt: new Date().toISOString(), note: 'a real render submission succeeded against this profile' },
    };
    return this.saveProfile(updated);
  }
}
