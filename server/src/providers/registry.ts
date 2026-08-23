// Provider registry — the only place UI/code selects a render backend.
// v0.1: 'runninghub' (real) + 'mock' (offline). Provider profiles persist in
// the GLOBAL registry DB (account-level: the AI App belongs to the user's
// RunningHub account, not to any single project), so switching projects never
// loses the verified node mapping.

import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AiAppProfile, H3Mode, ProviderCapabilities, ProviderStatus, ReferenceRole } from '@h3mise/shared';
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
      maxImageRefs: 9,
      maxVideoRefs: 0,
      maxAudioRefs: 3,
      maxTotalRefs: 12,
      audioSupported: true,
    },
    nodes: [],
    inputs: {
      prompt: { nodeId: 'node_1', fieldName: 'prompt' },
      mode: { nodeId: 'node_1', fieldName: 'mode' },
      firstFrame: { nodeId: 'node_1', fieldName: 'first_frame' },
      lastFrame: { nodeId: 'node_1', fieldName: 'last_frame' },
      refImages: [],
      refAudios: [],
      duration: { nodeId: 'node_1', fieldName: 'duration' },
      resolution: { nodeId: 'node_1', fieldName: 'resolution' },
      steps: { nodeId: 'node_1', fieldName: 'steps' },
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
  /** Collect every matching node into an ordered slot list. Slots share the
   * fieldName ("image") and differ by description (首帧/尾帧/参考图1..N), so
   * order is the apiCallDemo layout order, which follows the workflow.
   * Semantic priority keeps 首帧/尾帧 ahead of generic 参考图 entries. */
  const hasDesc = (re: RegExp) => (n: AiAppProfile['nodes'][number]) => re.test(n.description) || re.test(n.nodeName) || re.test(n.fieldName);
  /** Frame slots are identified by their semantic description (首帧/尾帧);
   * remaining image nodes become reference-image slots (参考图1..9). */
  const first = nodes.find(hasDesc(/首帧|first.?frame|start.?image|frame0/i));
  const last = nodes.find(hasDesc(/尾帧|last.?frame|end.?image/i));
  const frameIds = new Set([first?.nodeId, last?.nodeId].filter(Boolean));
  const collect = (pred: (n: AiAppProfile['nodes'][number]) => boolean) =>
    nodes.filter((n) => !frameIds.has(n.nodeId)).filter(pred).map((n) => ({ nodeId: n.nodeId, fieldName: n.fieldName }));
  const isAudioRef = has(/ref.?audio|audio_?\d|参考音频/i);
  const isImageRef = (n: AiAppProfile['nodes'][number]) => has(/ref.?image|image_?\d|参考图/i)(n) && !isAudioRef(n);
  return {
    prompt: pick(has(/prompt|text|描述|提示词/i), inputs.prompt),
    mode: pick(has(/mode|模式/i), inputs.mode),
    firstFrame: first ? { nodeId: first.nodeId, fieldName: first.fieldName } : { nodeId: '', fieldName: 'first_frame' },
    lastFrame: last ? { nodeId: last.nodeId, fieldName: last.fieldName } : { nodeId: '', fieldName: 'last_frame' },
    refImages: collect(isImageRef),
    refAudios: collect(isAudioRef),
    duration: pick(has(/duration|时长/i), inputs.duration),
    resolution: pick(has(/resolution|分辨率|比例/i), inputs.resolution),
    steps: pick(has(/^steps$|steps|采样/i), inputs.steps),
  };
}

/**
 * Infer the business modes a workflow can actually run from its node layout.
 * This is the single source of truth for `capabilities.supportedModes`:
 *  - t2va    needs a prompt input
 *  - i2va    needs a first-frame image input
 *  - l2va    needs a last-frame image input
 *  - fl2va   needs BOTH first and last frame
 *  - ref2va  needs at least one dedicated RefImages input; audio alone is not
 *            a valid Ref2VA path
 */
export function inferSupportedModes(inputs: AiAppProfile['inputs'], _nodes: AiAppProfile['nodes']): H3Mode[] {
  const modes: H3Mode[] = [];
  const hasSlot = (slot: { nodeId: string; fieldName: string } | undefined) => Boolean(slot && slot.nodeId !== '');
  const hasArray = (slots: Array<{ nodeId: string; fieldName: string }>) => slots.length > 0 && slots.every((s) => s.nodeId !== '');
  if (hasSlot(inputs.prompt)) modes.push('t2va');
  if (hasSlot(inputs.firstFrame)) modes.push('i2va');
  if (hasSlot(inputs.lastFrame)) modes.push('l2va');
  if (hasSlot(inputs.firstFrame) && hasSlot(inputs.lastFrame)) modes.push('fl2va');
  if (hasArray(inputs.refImages)) {
    modes.push('ref2va');
  }
  return modes;
}

/** Binding roles that actually reach the API, derived from the workflow's
 * enabled input slots. Descriptive roles (identity/costume/style/…) have no
 * slot in the workflow model — they are expressed through the prompt. */
export interface BindingSlots {
  firstFrame: boolean;
  lastFrame: boolean;
  images: number;
  audios: number;
  total: number;
}
/** Slot availability derived from the workflow's enabled input slots.
 * Frame mode (firstFrame+lastFrame) and reference-image mode (refImages)
 * are mutually exclusive; audios expose their capacity. (ref_videos was
 * dropped from the RunningHub API.) */
export function enabledBindingSlots(profile: AiAppProfile | undefined): BindingSlots {
  if (!profile) return { firstFrame: false, lastFrame: false, images: 0, audios: 0, total: 0 };
  const count = (slots: Array<{ nodeId: string; fieldName: string }>) => slots.filter((s) => s.nodeId !== '').length;
  const firstFrame = Boolean(profile.inputs.firstFrame && profile.inputs.firstFrame.nodeId !== '');
  const lastFrame = Boolean(profile.inputs.lastFrame && profile.inputs.lastFrame.nodeId !== '');
  const images = count(profile.inputs.refImages);
  const audios = count(profile.inputs.refAudios);
  const total = images + audios;
  return { firstFrame, lastFrame, images, audios, total };
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
    private readonly bus?: { emit: (e: import('@h3mise/shared').AppEvent) => void },
    /** P1: global (project-independent) workdir for the mock provider's task
     * state. Polling must survive project switches, so it can NEVER live in a
     * per-project cache dir that changes when `refresh()` re-runs. */
    private readonly mockWorkDir?: string,
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
    // P1: mock task state lives in a GLOBAL dir (default ~/.h3mise/mock-tasks).
    // Pinning it to the current project's cache made any in-flight mock render
    // fail with "unknown mock task" as soon as the user switched projects.
    const workDir = this.mockWorkDir ?? p?.paths.cache ?? resolve(tmpdir(), 'h3mise-mock');
    const mock = new MockProvider(this.ffmpeg, workDir);
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
      // P0-6: never advertise modes as executable from a profile that has no
      // real node data. Once nodes_detected, supportedModes were inferred
      // from the ACTUAL node layout (inferSupportedModes), so they are trusted;
      // verified additionally means a real submission succeeded.
      if (!v || v.status === 'unconfigured' || v.status === 'failed') {
        caps = { supportedModes: [] };
      }
    }
    this.capsCache.set(id, caps);
    return caps;
  }

  async statuses(): Promise<ProviderStatus[]> {
    // Auto-detect in the background when we have a key but no node data yet —
    // never blocks the response (the probe can take up to 30s).
    void this.maybeAutoDetect();
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

  private autoDetectPromise: Promise<void> | null = null;

  /** Probe the RunningHub workflow layout automatically once, as soon as a key
   * exists and no node data has been captured yet. Failures are silent (the
   * user can retry from Settings); a successful probe emits project.updated so
   * the UI refreshes provider caps + guide. */
  maybeAutoDetect(): Promise<void> {
    if (this.mode !== 'runninghub') return Promise.resolve();
    const v = this.getProfile()?.verification;
    if (v?.status === 'nodes_detected' || v?.status === 'verified') return Promise.resolve();
    if (!this.getEffectiveApiKey()) return Promise.resolve();
    if (this.autoDetectPromise) return this.autoDetectPromise;
    this.autoDetectPromise = this.detectAndVerify()
      .then(() => {
        this.bus?.emit({ type: 'project.updated' });
      })
      .catch(() => {
        /* keep current status; retry on next statuses() call */
      })
      .finally(() => {
        this.autoDetectPromise = null;
      });
    return this.autoDetectPromise;
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
    const slotOf = (v: unknown): { nodeId: string; fieldName: string } => {
      const s = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
      return {
        nodeId: typeof s.nodeId === 'string' ? s.nodeId.trim() : '',
        fieldName: typeof s.fieldName === 'string' ? s.fieldName.trim() : '',
      };
    };
    const inputsRaw: Record<string, unknown> = {};
    for (const key of Object.keys(d.inputs) as Array<keyof AiAppProfile['inputs']>) {
      const def = d.inputs[key];
      const raw = inputsIn[key];
      if (Array.isArray(def)) {
        // Array slot (refImages etc.): keep user's list if present, else empty.
        inputsRaw[key] = (Array.isArray(raw) ? raw : []).map(slotOf);
      } else {
        // Empty nodeId = explicitly disabled slot; keep it disabled (user intent).
        const slot = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        const nodeId = typeof slot.nodeId === 'string' ? slot.nodeId.trim() : def?.nodeId ?? '';
        inputsRaw[key] = {
          nodeId,
          fieldName: typeof slot.fieldName === 'string' && slot.fieldName.trim() ? slot.fieldName.trim() : def?.fieldName ?? '',
        };
      }
    }
    const inputs = inputsRaw as AiAppProfile['inputs'];
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
      capabilities: { ...current.capabilities, supportedModes: inferSupportedModes(mapDiscoveredNodes(nodes), nodes) },
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
