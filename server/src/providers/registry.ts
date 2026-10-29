// Provider registry — the only place UI/code selects a render backend.
// RunningHub (cloud), ComfyUI (local), and Mock (offline). Provider profiles persist in
// the GLOBAL registry DB (account-level: the AI App belongs to the user's
// the global registry DB rather than a project DB, so switching projects never
// loses a verified workflow mapping.

import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { H3_MODES } from '@h3mise/shared';
import type { AiAppInputs, AiAppProfile, ComfyUiInputBinding, ComfyUiWorkflowProfile, H3Mode, MediaAsset, ProviderCapabilities, ProviderStatus, ProviderVerification, ProviderWorkflowSummary, RunningHubRegion, StoryboardProviderProfile, WorkflowKind, WorkflowModeReadiness, WorkflowProfile } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { j, jget, type Db } from '../db/sqlite.js';
import type { Ffmpeg } from '../ffmpeg.js';
import type { VideoProvider } from './types.js';
import { RunningHubAiAppProvider, runningHubOrigin } from './runninghub.js';
import { ComfyUiProvider } from './comfyui.js';
import { defaultComfyUiProfile, importComfyUiWorkflow, sanitizeComfyUiProfile } from './comfyui-profile.js';
import { MockProvider } from './mock.js';

export const H3_AI_APP_ID = '2089265538441764866';
export const H3_AI_APP_URL = `${runningHubOrigin('cn')}/openapi/v2/run/ai-app/${H3_AI_APP_ID}`;
export const STORYBOARD_AI_APP_ID = '2094638110561886209';

export function defaultStoryboardProviderProfile(region: RunningHubRegion = 'cn'): StoryboardProviderProfile {
  return {
    provider: 'runninghub_storyboard',
    region,
    enabled: true,
    appId: STORYBOARD_AI_APP_ID,
    invokeUrl: `${runningHubOrigin(region)}/openapi/v2/run/ai-app/${STORYBOARD_AI_APP_ID}`,
    estimatedCostCny: 0.22,
    inputs: {
      prompt: { nodeId: '1', fieldName: 'text' },
      size: { nodeId: '12', fieldName: 'size' },
      layoutImage: { nodeId: '16', fieldName: 'image' },
    },
    sizeValues: { 3: '2560x1440', 6: '2496x1664', 9: '2048x2048' },
    nodes: [],
    verification: {
      status: 'unconfigured',
      checkedAt: null,
      note: 'Storyboard 生图是可选付费功能；请先检测 AI App 节点映射',
    },
  };
}

/** Map the three Storyboard business inputs without confusing an image model
 * node (for example `RH_Jimeng4_Image2Image.size`) with the actual uploaded
 * image input (`LoadImage.image`). apiCallDemo order is not semantic, so the
 * image slot must be selected by field type/upload metadata first. */
export function mapStoryboardProviderNodes(
  nodes: StoryboardProviderProfile['nodes'],
): StoryboardProviderProfile['inputs'] | null {
  const text = (node: StoryboardProviderProfile['nodes'][number]) =>
    `${node.fieldName} ${node.nodeName} ${node.description}`;
  const prompt = nodes.find((node) => /prompt|text|提示词/i.test(text(node)));
  const size = nodes.find((node) => /size|resolution|分辨率/i.test(text(node)));
  const layoutImage = nodes
    .map((node, index) => {
      let score = 0;
      if (/^image$/i.test(node.fieldType)) score += 100;
      if (/image_upload/i.test(node.fieldData ?? '')) score += 80;
      if (/^image$/i.test(node.fieldName)) score += 40;
      if (/load.?image/i.test(node.nodeName)) score += 30;
      if (/参考图|layout.?image|reference.?image/i.test(text(node))) score += 20;
      // A LIST/string option on an image-generation node is commonly the size
      // selector. Never let the word "Image" in its node name outrank a real
      // upload field.
      if (/^(list|string)$/i.test(node.fieldType) && !/image_upload/i.test(node.fieldData ?? '')) score -= 100;
      return { node, score, index };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.node;
  if (!prompt || !size || !layoutImage) return null;
  return {
    prompt: { nodeId: prompt.nodeId, fieldName: prompt.fieldName },
    size: { nodeId: size.nodeId, fieldName: size.fieldName },
    layoutImage: { nodeId: layoutImage.nodeId, fieldName: layoutImage.fieldName },
  };
}

/** Default profile for the fixed v0.1 AI App (PRD §25.3). Node layout is a
 * heuristic until the user runs "detect & verify" with a real key. */
export function defaultAiAppProfile(region: RunningHubRegion = 'cn'): AiAppProfile {
  const inputs: AiAppInputs = {
    prompt: { nodeId: 'node_1', fieldName: 'prompt' },
    mode: { nodeId: 'node_1', fieldName: 'mode' },
    firstFrame: { nodeId: 'node_1', fieldName: 'first_frame' },
    lastFrame: { nodeId: 'node_1', fieldName: 'last_frame' },
    refImages: [],
    refAudios: [],
    refVideos: [],
    duration: { nodeId: 'node_1', fieldName: 'duration' },
    resolution: { nodeId: 'node_1', fieldName: 'resolution' },
    megapixels: { nodeId: '', fieldName: 'megapixels' },
    steps: { nodeId: 'node_1', fieldName: 'steps' },
  };
  const capabilities: ProviderCapabilities = {
    // Unknown until verified (P0-6): a heuristic default must not be
    // trusted as executable capability in front of a paid render.
    supportedModes: [],
    maxImageRefs: 9,
    maxVideoRefs: 0,
    maxAudioRefs: 3,
    maxTotalRefs: 12,
    audioSupported: true,
  };
  const verification = { status: 'unconfigured' as const, checkedAt: null, note: 'run "detect nodes" in Settings, then confirm with a real render' };
  return {
    provider: 'runninghub',
    region,
    concurrency: 1,
    appId: H3_AI_APP_ID,
    invokeUrl: `${runningHubOrigin(region)}/openapi/v2/run/ai-app/${H3_AI_APP_ID}`,
    protocolVersion: 'observed',
    capabilities,
    nodes: [],
    inputs,
    apps: [{
      id: 'primary',
      name: '主视频生成',
      appId: H3_AI_APP_ID,
      description: '默认 H3 视频生成 App',
      inputs,
      nodes: [],
      capabilities,
      verification,
    }],
    activeWorkflowId: 'primary',
    verification,
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
  const isAudioRef = (n: AiAppProfile['nodes'][number]) =>
    has(/ref.?audio|audio_?\d|参考音频/i)(n) || /^audio$/i.test(n.fieldType) || /audio_upload/i.test(n.fieldData ?? '');
  const isImageRef = (n: AiAppProfile['nodes'][number]) =>
    !isAudioRef(n) && (has(/ref.?image|image_?\d|参考图|参考(?:图片)?\s*\d|人脸|face.?image/i)(n)
      || /^image$/i.test(n.fieldName) || /^image$/i.test(n.fieldType) || /image_upload/i.test(n.fieldData ?? ''));
  return {
    prompt: pick(has(/prompt|text|描述|提示词/i), inputs.prompt),
    mode: pick(has(/mode|模式/i), inputs.mode),
    firstFrame: first ? { nodeId: first.nodeId, fieldName: first.fieldName } : { nodeId: '', fieldName: 'first_frame' },
    lastFrame: last ? { nodeId: last.nodeId, fieldName: last.fieldName } : { nodeId: '', fieldName: 'last_frame' },
    refImages: collect(isImageRef),
    refAudios: collect(isAudioRef),
    refVideos: collect(n => /^video$/i.test(n.fieldType) || /video_upload/i.test(n.fieldData ?? '') || /参考视频|源视频|换脸|ref.?video|face.?swap/i.test(`${n.fieldName} ${n.nodeName} ${n.description}`)),
    duration: pick(has(/duration|时长/i), inputs.duration),
    resolution: pick(has(/resolution|分辨率|比例/i), inputs.resolution),
    megapixels: pick(has(/^megapixels$|megapixel|百万像素/i), inputs.megapixels),
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
export function inferSupportedModes(inputs: AiAppInputs, nodes: AiAppProfile['nodes'], kind?: WorkflowKind): H3Mode[] {
  const modes: H3Mode[] = [];
  const hasSlot = (slot: { nodeId: string; fieldName: string } | undefined) => Boolean(slot && slot.nodeId !== '');
  const hasArray = (slots: Array<{ nodeId: string; fieldName: string }>) => slots.length > 0 && slots.every((s) => s.nodeId !== '');
  const videoSlots = inputs.refVideos ?? [];
  const hasVideo = hasArray(videoSlots);
  const hasImages = hasArray(inputs.refImages);
  const videoOptional = videoSlots.length > 0 && videoSlots.every(slot => nodes.some(node => node.nodeId === slot.nodeId
    && node.fieldName === slot.fieldName && /["']None["']/i.test(node.fieldData ?? '')));
  // A dedicated image+video App is the faceswap/v2v shape. An explicit
  // `kind: "faceswap"` is authoritative: some workflows expose the source
  // video as a COMBO/upload field whose default "None" would otherwise look
  // like an optional video port. The same slots can still act as a
  // conservative video-reference workflow.
  const faceSwapNamed = nodes.some((node) => /换脸|face.?swap|face.?fusion/i.test(`${node.nodeName} ${node.fieldName} ${node.description}`));
  const faceSwapShape = hasVideo && hasImages && hasSlot(inputs.prompt)
    && !hasSlot(inputs.firstFrame) && !hasSlot(inputs.lastFrame)
    && (kind === 'faceswap'
      ? true
      : !videoOptional && inputs.refImages.length === 1
        && (inputs.refAudios.length === 0 || faceSwapNamed));
  // An optional video port on a multimodal image/audio App does not make
  // video mandatory. Keep dedicated video-reference Apps conservative.
  const optionalMultimodalVideo = videoOptional && hasImages;
  if (faceSwapShape) return ['faceswap', 'vref2va'];
  if (hasVideo && !optionalMultimodalVideo) return hasSlot(inputs.prompt) ? ['vref2va'] : [];
  if (hasSlot(inputs.prompt)) modes.push('t2va');
  if (hasSlot(inputs.firstFrame)) modes.push('i2va');
  if (hasSlot(inputs.lastFrame)) modes.push('l2va');
  if (hasSlot(inputs.firstFrame) && hasSlot(inputs.lastFrame)) modes.push('fl2va');
  if (hasImages) {
    modes.push('ref2va');
  }
  if (hasVideo && hasSlot(inputs.prompt)) modes.push('vref2va');
  return modes;
}

/** Concrete missing requirement per mode. Supports both supported and
 * unsupported modes so the UI can explain what a workflow still needs. */
export function workflowModeReadiness(profile: AiAppProfile): WorkflowModeReadiness[] {
  const inputs = profile.inputs;
  const has = (slot: { nodeId: string; fieldName: string } | undefined) => Boolean(slot?.nodeId);
  const supportedModes = profile.capabilities.supportedModes;
  return H3_MODES.map((mode) => {
    const missing: string[] = [];
    if (!has(inputs.prompt)) missing.push('prompt 输入节点');
    if (mode === 'i2va' && !has(inputs.firstFrame)) missing.push('首帧节点');
    if (mode === 'l2va' && !has(inputs.lastFrame)) missing.push('尾帧节点');
    if (mode === 'fl2va') {
      if (!has(inputs.firstFrame)) missing.push('首帧节点');
      if (!has(inputs.lastFrame)) missing.push('尾帧节点');
    }
    if (mode === 'ref2va' && !inputs.refImages.some(has)) missing.push('至少一个参考图槽位');
    if (mode === 'vref2va') {
      if (!(inputs.refVideos ?? []).some(has)) missing.push('视频输入槽位');
    }
    if (mode === 'faceswap') {
      if (!(inputs.refVideos ?? []).some(has)) missing.push('源视频输入槽位');
      if (!inputs.refImages.some(has)) missing.push('人脸图片输入槽位');
      if (inputs.refAudios.length > 0) missing.push('该模式不接受音频槽位（应保留源视频音频）');
    }
    const supported = supportedModes.includes(mode);
    if (!supported && !missing.length) missing.push('工作流未声明该模式');
    if (!['nodes_detected', 'verified'].includes(profile.verification.status)) {
      missing.push(profile.verification.status === 'failed' ? '节点检测失败，请重新检测' : '尚未检测节点映射');
    }
    return { mode, supported, ready: supported && missing.length === 0, missing };
  });
}

/** Binding roles that actually reach the API, derived from the workflow's
 * enabled input slots. Descriptive roles (identity/costume/style/…) have no
 * slot in the workflow model — they are expressed through the prompt. */
export interface BindingSlots {
  firstFrame: boolean;
  lastFrame: boolean;
  images: number;
  audios: number;
  videos: number;
  total: number;
}
/** Slot availability derived from the workflow's enabled input slots.
 * Frame mode (firstFrame+lastFrame) and reference-image mode (refImages)
 * are mutually exclusive; audios/videos expose their own capacities. */
export function enabledBindingSlots(profile: AiAppProfile | undefined): BindingSlots {
  if (!profile) return { firstFrame: false, lastFrame: false, images: 0, audios: 0, videos: 0, total: 0 };
  const count = (slots: Array<{ nodeId: string; fieldName: string }>) => slots.filter((s) => s.nodeId !== '').length;
  const firstFrame = Boolean(profile.inputs.firstFrame && profile.inputs.firstFrame.nodeId !== '');
  const lastFrame = Boolean(profile.inputs.lastFrame && profile.inputs.lastFrame.nodeId !== '');
  const images = count(profile.inputs.refImages);
  const audios = count(profile.inputs.refAudios);
  const videos = count(profile.inputs.refVideos ?? []);
  const total = images + audios + videos;
  return { firstFrame, lastFrame, images, audios, videos, total };
}

function emptyVerification(note = '等待检测节点映射'): ProviderVerification {
  return { status: 'unconfigured', checkedAt: null, note };
}

function disabledInputs(): AiAppInputs {
  const slot = { nodeId: '', fieldName: '' };
  return {
    prompt: slot,
    mode: slot,
    firstFrame: slot,
    lastFrame: slot,
    refImages: [],
    refAudios: [],
    refVideos: [],
    duration: slot,
    resolution: slot,
    megapixels: { nodeId: '', fieldName: 'megapixels' },
    steps: slot,
  };
}

function slotOf(value: unknown): { nodeId: string; fieldName: string } {
  const slot = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    nodeId: typeof slot.nodeId === 'string' ? slot.nodeId.trim() : '',
    fieldName: typeof slot.fieldName === 'string' ? slot.fieldName.trim() : '',
  };
}

function sanitizeInputs(raw: unknown, defaults: AiAppInputs): AiAppInputs {
  const inputsIn = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(defaults) as Array<keyof AiAppInputs>) {
    const def = defaults[key];
    const value = inputsIn[key];
    if (Array.isArray(def)) {
      out[key] = (Array.isArray(value) ? value : []).map(slotOf);
    } else {
      const slot = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
      out[key] = {
        nodeId: typeof slot.nodeId === 'string' ? slot.nodeId.trim() : def?.nodeId ?? '',
        fieldName: typeof slot.fieldName === 'string' && slot.fieldName.trim() ? slot.fieldName.trim() : def?.fieldName ?? '',
      };
    }
  }
  return out as unknown as AiAppInputs;
}

function sanitizeVerification(raw: unknown, fallback: ProviderVerification): ProviderVerification {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const status = ['unconfigured', 'nodes_detected', 'verified', 'failed'].includes(String(value.status))
    ? value.status as ProviderVerification['status']
    : fallback.status;
  return {
    status,
    checkedAt: typeof value.checkedAt === 'string' ? value.checkedAt : fallback.checkedAt,
    note: typeof value.note === 'string' ? value.note : fallback.note,
  };
}

const WORKFLOW_KINDS: WorkflowKind[] = ['video', 'frame', 'video_reference', 'faceswap', 'custom'];

function sanitizeKind(raw: unknown): WorkflowKind | undefined {
  return typeof raw === 'string' && WORKFLOW_KINDS.includes(raw as WorkflowKind) ? raw as WorkflowKind : undefined;
}

function sanitizeCapabilities(raw: unknown, inputs: AiAppInputs, nodes: AiAppProfile['nodes'], kind?: WorkflowKind): ProviderCapabilities | undefined {
  if (!raw || typeof raw !== 'object') {
    if (!inputs.prompt.nodeId) return undefined;
    return { supportedModes: inferSupportedModes(inputs, nodes, kind) };
  }
  const value = raw as Record<string, unknown>;
  const inferred = inferSupportedModes(inputs, nodes, kind);
  const declared = Array.isArray(value.supportedModes)
    ? value.supportedModes.filter((mode): mode is H3Mode => H3_MODES.includes(mode as H3Mode))
    : inferred;
  // Repair evidence written before explicit faceswap kinds were honored:
  // the stored mode list may still say t2va/ref2va/vref2va while the same
  // nodes + kind prove faceswap. Never drop a declared mode.
  const modes = [...new Set(kind === 'faceswap' ? [...declared, ...inferred] : declared)];
  return { ...(value as object), supportedModes: modes } as ProviderCapabilities;
}

function sanitizeBindings(raw: unknown): Record<string, { nodeId: string; fieldName: string }> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>).map(([key, value]) => {
    const slot = slotOf(value);
    return slot.nodeId ? [key, slot] as const : null;
  }).filter((entry): entry is readonly [string, { nodeId: string; fieldName: string }] => Boolean(entry));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function hasUsableInputs(inputs: AiAppInputs): boolean {
  return Boolean(inputs.prompt.nodeId);
}

function sanitizeWorkflow(raw: unknown): WorkflowProfile | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const appId = typeof value.appId === 'string' ? value.appId.trim() : '';
  if (!appId) return null;
  const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : appId;
  const hasInputs = value.inputs !== undefined && value.inputs !== null && typeof value.inputs === 'object' && !Array.isArray(value.inputs);
  const inputs = hasInputs ? sanitizeInputs(value.inputs, disabledInputs()) : undefined;
  const nodes = Array.isArray(value.nodes) ? value.nodes as AiAppProfile['nodes'] : [];
  const kind = sanitizeKind(value.kind);
  const capabilities = inputs ? sanitizeCapabilities(value.capabilities, inputs, nodes, kind) : undefined;
  return {
    id,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : `AI App ${appId}`,
    appId,
    ...(typeof value.description === 'string' && value.description.trim() ? { description: value.description.trim() } : {}),
    ...(kind ? { kind } : {}),
    ...(inputs ? { inputs } : {}),
    ...(nodes.length ? { nodes } : {}),
    ...(capabilities ? { capabilities } : {}),
    verification: sanitizeVerification(value.verification, emptyVerification()),
    ...(sanitizeBindings(value.providerParamBindings) ? { providerParamBindings: sanitizeBindings(value.providerParamBindings) } : {}),
  };
}

function workflowAsProfile(workflow: WorkflowProfile, account: AiAppProfile): AiAppProfile {
  return {
    provider: 'runninghub',
    region: account.region,
    concurrency: account.concurrency,
    appId: workflow.appId,
    invokeUrl: `${runningHubOrigin(account.region)}/openapi/v2/run/ai-app/${workflow.appId}`,
    protocolVersion: 'observed',
    capabilities: workflow.capabilities ?? { supportedModes: [] },
    nodes: workflow.nodes ?? [],
    inputs: workflow.inputs ?? disabledInputs(),
    providerParamBindings: workflow.providerParamBindings,
    refVideoAppId: account.refVideoAppId,
    apps: [],
    activeWorkflowId: workflow.id,
    verification: workflow.verification ?? emptyVerification(),
  };
}

function enrichWorkflow(workflow: WorkflowProfile): WorkflowProfile {
  const inputs = workflow.inputs;
  const capabilities = workflow.capabilities;
  const runnable = Boolean(inputs?.prompt.nodeId && capabilities?.supportedModes.length);
  const base: AiAppProfile = {
    ...defaultAiAppProfile(),
    appId: workflow.appId,
    inputs: inputs ?? disabledInputs(),
    nodes: workflow.nodes ?? [],
    capabilities: capabilities ?? { supportedModes: [] },
    verification: workflow.verification ?? emptyVerification(),
    apps: [],
  };
  return {
    ...workflow,
    runnable,
    modes: capabilities?.supportedModes ?? [],
    readiness: workflowModeReadiness(base),
  };
}

function discoveredCapabilities(mapped: AiAppInputs, nodes: AiAppProfile['nodes'], previous: ProviderCapabilities, kind?: WorkflowKind): ProviderCapabilities {
  const modes = inferSupportedModes(mapped, nodes, kind);
  const faceswap = modes.includes('faceswap');
  return {
    ...previous,
    supportedModes: modes,
    maxImageRefs: faceswap ? 1 : (mapped.refImages.length || Number(Boolean(mapped.firstFrame?.nodeId)) + Number(Boolean(mapped.lastFrame?.nodeId))),
    maxAudioRefs: faceswap ? 0 : mapped.refAudios.length,
    maxVideoRefs: faceswap ? 1 : (mapped.refVideos ?? []).length,
    maxTotalRefs: faceswap ? 2 : Math.max(mapped.refImages.length, Number(Boolean(mapped.firstFrame?.nodeId)) + Number(Boolean(mapped.lastFrame?.nodeId)))
      + mapped.refAudios.length + (mapped.refVideos ?? []).length,
    audioSupported: faceswap ? false : previous.audioSupported || mapped.refAudios.length > 0,
    ...(faceswap ? { preservesSourceAudio: true } : {}),
  };
}

function previewAsset(kind: 'image' | 'video' | 'audio', n: number): MediaAsset {
  return {
    id: `preview-${kind}-${n}`,
    kind,
    fileName: `preview-${kind}-${n}`,
    mimeType: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg',
    sizeBytes: 0,
    source: 'other',
    label: `preview-${kind}-${n}`,
    tags: [],
    createdAt: '1970-01-01T00:00:00.000Z',
  };
}

function previewReferences(mode: H3Mode): Array<{ asset: MediaAsset; roles: import('@h3mise/shared').ReferenceRole[]; providerRef: string; label: string }> {
  const image = (n: number) => ({ asset: previewAsset('image', n), roles: [], label: `preview-image-${n}`, providerRef: `{{upload:image-${n}}}` });
  const video = (n: number) => ({ asset: previewAsset('video', n), roles: [], label: `preview-video-${n}`, providerRef: `{{upload:video-${n}}}` });
  switch (mode) {
    case 'i2va': return [{ ...image(1), roles: ['first_frame'] }];
    case 'l2va': return [{ ...image(1), roles: ['last_frame'] }];
    case 'fl2va': return [{ ...image(1), roles: ['first_frame'] }, { ...image(2), roles: ['last_frame'] }];
    case 'ref2va': return [image(1)];
    case 'vref2va': return [video(1), image(1)];
    case 'faceswap': return [image(1), video(1)];
    default: return [];
  }
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
    const region = this.getProfile()?.region ?? 'cn';
    const regional = this.getRegistryDb().get<{ value: string }>('SELECT value FROM kv WHERE key = ?', [`runninghub_api_key_${region}`])?.value;
    if (regional) return regional;
    // Backward compatibility: the historical single key always targeted the
    // only supported endpoint at the time, runninghub.cn. Never reuse it for
    // Global where it could be mistaken for a valid credential.
    if (region === 'cn') return this.getRegistryDb().get<{ value: string }>("SELECT value FROM kv WHERE key = 'runninghub_api_key'")?.value ?? null;
    return null;
  }

  getEffectiveApiKey(): string | null {
    return this.getApiKey() ?? this.envApiKey;
  }

  saveApiKey(key: string): void {
    const k = key.trim();
    const region = this.getProfile()?.region ?? 'cn';
    this.getRegistryDb().run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [`runninghub_api_key_${region}`, k]);
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
    const profile = this.getProfile() ?? defaultAiAppProfile();
    this.providers.set('runninghub', new RunningHubAiAppProvider({ apiKey: this.getEffectiveApiKey(), profile }));
    const comfyProfile = this.getComfyUiProfile();
    this.providers.set('comfyui', new ComfyUiProvider(comfyProfile));
    this.providers.set('mock', mock);
  }

  get(id: string, mode?: H3Mode): VideoProvider | undefined {
    if (id === 'runninghub' && mode) {
      const profile = this.getProfileForMode(mode);
      if (profile) return new RunningHubAiAppProvider({ apiKey: this.getEffectiveApiKey(), profile });
    }
    return this.providers.get(id);
  }

  /** Resolve the provider for a persisted render snapshot. The snapshot's
   * App ID wins over the current active workflow so a queued paid job can
   * never silently switch Apps after the user changes Settings mid-queue. */
  getForSubmission(id: string, mode: H3Mode | undefined, appId?: string | null): VideoProvider | undefined {
    if (id !== 'runninghub') return this.get(id, mode);
    const resolved = this.getProfileForMode(mode);
    if (!appId || resolved?.appId === appId) return this.get(id, mode);
    const profile = this.getProfile();
    if (profile) {
      const workflow = profile.apps.find((entry) => entry.appId === appId);
      if (workflow) return new RunningHubAiAppProvider({ apiKey: this.getEffectiveApiKey(), profile: workflowAsProfile(workflow, profile) });
      const frame = this.getFrameProfile();
      if (frame?.appId === appId) return new RunningHubAiAppProvider({ apiKey: this.getEffectiveApiKey(), profile: frame });
      const legacyVideo = this.getVideoReferenceProfile();
      if (legacyVideo.appId === appId) return new RunningHubAiAppProvider({ apiKey: this.getEffectiveApiKey(), profile: legacyVideo });
    }
    return undefined;
  }

  /** Scheduler limit. Unknown/invalid values always collapse to the safest
   * single-task behavior; Mock is intentionally wider for offline testing. */
  concurrencyLimit(id: string): number {
    if (id === 'mock') return 4;
    const raw = id === 'runninghub'
      ? this.getProfile()?.concurrency
      : id === 'comfyui'
        ? this.getComfyUiProfile().concurrency
        : 1;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 ? Math.min(4, n) : 1;
  }

  setConcurrency(id: 'runninghub' | 'comfyui', value: unknown): number {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error('concurrency must be an integer from 1 to 4');
    if (id === 'runninghub') {
      const current = this.getProfile() ?? defaultAiAppProfile();
      this.saveProfile({ ...current, concurrency: n });
    } else {
      const current = this.getComfyUiProfile();
      // A scheduler-only change does not invalidate a verified workflow.
      this.persistComfyUiProfile(sanitizeComfyUiProfile({ ...current, concurrency: n }));
    }
    return n;
  }

  async capabilities(id: string, mode?: H3Mode): Promise<ProviderCapabilities | undefined> {
    if (id === 'runninghub' && mode) {
      const profile = this.getProfileForMode(mode);
      if (!profile) return undefined;
      // P0-6: only node-detected or verified evidence is executable.
      return ['nodes_detected', 'verified'].includes(profile.verification.status)
        ? profile.capabilities
        : { supportedModes: [] };
    }
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
    if (prov instanceof ComfyUiProvider) {
      const status = this.getComfyUiProfile().verification.status;
      if (status === 'unconfigured' || status === 'failed') caps = { supportedModes: [] };
    }
    this.capsCache.set(id, caps);
    return caps;
  }

  /** Modes the whole RunningHub account can execute, including a separate
   * frame App. Render/preflight still resolve per mode through get()/
   * capabilities(id, mode); this union only describes what the UI may offer. */
  async accountCapabilities(id: string): Promise<ProviderCapabilities | undefined> {
    const caps = await this.capabilities(id);
    if (id !== 'runninghub') return caps;
    const modes = new Set<H3Mode>(caps?.supportedModes ?? []);
    const add = (profile: AiAppProfile | null | undefined) => {
      if (!profile || !['nodes_detected', 'verified'].includes(profile.verification.status)) return;
      for (const mode of profile.capabilities.supportedModes) modes.add(mode);
    };
    const profile = this.getProfile();
    add(profile);
    for (const workflow of profile?.apps ?? []) add(workflowAsProfile(workflow, profile!));
    add(this.getFrameProfile());
    const legacyVideo = this.getVideoReferenceProfile();
    if (['nodes_detected', 'verified'].includes(legacyVideo.verification.status)) add(legacyVideo);
    return { ...(caps ?? { supportedModes: [] }), supportedModes: H3_MODES.filter((mode) => modes.has(mode)) };
  }

  async statuses(): Promise<ProviderStatus[]> {
    // Auto-detect in the background when we have a key but no node data yet —
    // never blocks the response (the probe can take up to 30s).
    void this.maybeAutoDetect();
    const out: ProviderStatus[] = [];
    for (const [id, prov] of this.providers) {
      const caps = await this.accountCapabilities(id);
      const isRh = prov instanceof RunningHubAiAppProvider;
      const isComfy = prov instanceof ComfyUiProvider;
      const rhProfile = isRh ? this.getProfile() : null;
      const comfyProfile = isComfy ? this.getComfyUiProfile() : null;
      const workflows: ProviderWorkflowSummary[] | undefined = rhProfile
        ? rhProfile.apps.map((workflow) => ({
            id: workflow.id,
            name: workflow.name,
            appId: workflow.appId,
            description: workflow.description,
            active: workflow.id === rhProfile.activeWorkflowId,
            runnable: Boolean(workflow.runnable),
            verification: workflow.verification ?? emptyVerification(),
            modes: workflow.modes ?? [],
            readiness: workflow.readiness ?? [],
          }))
        : undefined;
      out.push({
        id,
        name: prov.name,
        kind: isRh ? 'runninghub_ai_app' : isComfy ? 'comfyui_local' : 'mock',
        configured: prov.configured,
        verification: rhProfile?.verification ?? comfyProfile?.verification ?? { status: 'unconfigured', checkedAt: null, note: 'mock provider' },
        capabilities: caps ?? null,
        ...(rhProfile ? {
          activeWorkflowId: rhProfile.activeWorkflowId ?? null,
          activeModes: ['nodes_detected', 'verified'].includes(rhProfile.verification.status)
            ? rhProfile.capabilities.supportedModes
            : [],
          workflows,
        } : {}),
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
    return this.sanitizeProfile(row ? jget<unknown>(row.profile_json, defaultAiAppProfile()) : defaultAiAppProfile());
  }

  private isFrameMode(mode?: H3Mode): boolean {
    return mode === 'i2va' || mode === 'l2va' || mode === 'fl2va';
  }

  /** Separate node evidence for the frame App; never borrow the primary App mapping. */
  getFrameProfile(): AiAppProfile | null {
    const row = this.getRegistryDb().get<{ profile_json: string }>("SELECT profile_json FROM provider_profiles WHERE id = 'runninghub_frames'");
    if (!row) return null;
    const profile = this.sanitizeProfile(jget(row.profile_json, {}));
    const primary = this.getProfile();
    if (profile.region !== primary?.region) return { ...profile, nodes: [], verification: { status: 'unconfigured', checkedAt: null, note: 'Account region changed; configure and detect the frame App for this region' } };
    return profile;
  }

  /** Resolve the workflow that owns a mode. Frame modes keep their separate
   * App evidence; every other mode picks the active workflow when it declares
   * the mode, otherwise the first saved workflow that does. Never falls back
   * to an unrelated App's node mapping. */
  getProfileForMode(mode?: H3Mode): AiAppProfile | null {
    const primary = this.getProfile();
    if (!primary) return null;
    if (this.isFrameMode(mode)) return this.getFrameProfile() ?? primary;
    if (mode === 'vref2va') {
      const active = this.activeWorkflowAsProfile(primary);
      if (active.capabilities.supportedModes.includes(mode)) return active;
      const workflow = this.findWorkflowForMode(primary, mode);
      if (workflow) return workflowAsProfile(workflow, primary);
      const legacy = this.getVideoReferenceProfile();
      if (['nodes_detected', 'verified'].includes(legacy.verification.status)
        && legacy.capabilities.supportedModes.includes(mode)) return legacy;
      return primary;
    }
    const active = this.activeWorkflowAsProfile(primary);
    if (!mode || active.capabilities.supportedModes.includes(mode)) return active;
    const workflow = this.findWorkflowForMode(primary, mode);
    return workflow ? workflowAsProfile(workflow, primary) : active;
  }

  private activeWorkflowAsProfile(profile: AiAppProfile): AiAppProfile {
    const active = profile.apps.find((workflow) => workflow.id === profile.activeWorkflowId);
    return active ? workflowAsProfile(active, profile) : profile;
  }

  private findWorkflowForMode(profile: AiAppProfile, mode: H3Mode): WorkflowProfile | null {
    const usable = (workflow: WorkflowProfile) =>
      Boolean(workflow.inputs?.prompt.nodeId && workflow.capabilities?.supportedModes.includes(mode));
    const active = profile.apps.find((workflow) => workflow.id === profile.activeWorkflowId);
    if (active && usable(active)) return active;
    return profile.apps.find(usable) ?? null;
  }

  private persistFrameProfile(profile: AiAppProfile): AiAppProfile {
    // A frame profile has no secondary workflow list; synthesize its single
    // entry from the top-level evidence so a later verification confirmation
    // cannot be shadowed by a stale `apps[]` mirror.
    const clean = this.sanitizeProfile({ ...profile, apps: [] });
    this.getRegistryDb().run('INSERT INTO provider_profiles (id, profile_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at', ['runninghub_frames', j(clean), new Date().toISOString()]);
    this.refresh();
    return clean;
  }

  saveFrameProfile(raw: unknown): AiAppProfile {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const primary = this.getProfile()!;
    const previous = this.getFrameProfile();
    const appId = typeof input.appId === 'string' ? input.appId.trim() : previous?.appId;
    if (!appId) throw new Error('Frame App ID required');
    const base = previous ?? { ...defaultAiAppProfile(primary.region), inputs: mapDiscoveredNodes([]), capabilities: { supportedModes: [] } };
    const profile = this.sanitizeProfile({ ...base, appId, region: primary.region,
      concurrency: primary.concurrency, apps: [],
      ...(input.inputs ? { inputs: { ...base.inputs, ...(input.inputs as object) } } : {}),
    });
    if (!previous || profile.region !== previous.region || profile.appId !== previous.appId || JSON.stringify(profile.inputs) !== JSON.stringify(previous.inputs)) {
      profile.nodes = [];
      profile.capabilities = { supportedModes: [] };
      profile.verification = { status: 'unconfigured', checkedAt: null, note: 'Frame App changed; detect its own node mapping' };
    }
    return this.persistFrameProfile(profile);
  }

  async detectFrameProfile(): Promise<AiAppProfile> {
    const profile = this.getFrameProfile();
    if (!profile) throw new Error('Configure a frame App first');
    try {
      const provider = new RunningHubAiAppProvider({ apiKey: this.getEffectiveApiKey(), profile });
      const nodes = await provider.discoverNodes();
      const inputs = mapDiscoveredNodes(nodes);
      const modes = inferSupportedModes(inputs, nodes).filter(mode => this.isFrameMode(mode));
      if (!inputs.prompt.nodeId || !modes.length) throw new Error('No unambiguous first/last-frame ports found; inspect the App example before mapping');
      return this.persistFrameProfile({ ...profile, nodes, inputs,
        capabilities: { ...profile.capabilities, supportedModes: modes,
          maxImageRefs: Number(Boolean(inputs.firstFrame?.nodeId)) + Number(Boolean(inputs.lastFrame?.nodeId)),
          maxAudioRefs: 0, maxVideoRefs: 0,
          maxTotalRefs: Number(Boolean(inputs.firstFrame?.nodeId)) + Number(Boolean(inputs.lastFrame?.nodeId)),
        }, verification: { status: 'nodes_detected', checkedAt: new Date().toISOString(), note: 'Frame node mapping detected; no paid render yet' },
      });
    } catch (error) {
      return this.persistFrameProfile({ ...profile, capabilities: { supportedModes: [] },
        verification: { status: 'failed', checkedAt: new Date().toISOString(), note: error instanceof Error ? error.message : String(error) } });
    }
  }

  confirmFrameVerified(appId: string): void {
    const profile = this.getFrameProfile();
    if (!profile || profile.appId !== appId) return;
    this.persistFrameProfile({ ...profile, verification: { status: 'verified', checkedAt: new Date().toISOString(), note: 'A real frame-mode submission returned a task ID' } });
  }

  getVideoReferenceProfile(): AiAppProfile {
    const region = this.getProfile()?.region ?? 'cn';
    const row = this.getRegistryDb().get<{ profile_json: string }>("SELECT profile_json FROM provider_profiles WHERE id = 'runninghub_video_reference'");
    const fallback = { ...defaultAiAppProfile(region), appId: '2093714693130113026', inputs: mapDiscoveredNodes([]) };
    const profile = this.sanitizeProfile(row ? jget(row.profile_json, fallback) : fallback);
    if (profile.region !== region) return this.sanitizeProfile(fallback);
    return profile;
  }

  private persistVideoReferenceProfile(profile: AiAppProfile): AiAppProfile {
    const clean = this.sanitizeProfile({ ...profile, apps: [] });
    this.getRegistryDb().run('INSERT INTO provider_profiles (id, profile_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at', ['runninghub_video_reference', j(clean), new Date().toISOString()]);
    this.refresh();
    return clean;
  }

  async detectVideoReference(): Promise<AiAppProfile> {
    const profile = this.getVideoReferenceProfile();
    try {
      const provider = new RunningHubAiAppProvider({ apiKey: this.getEffectiveApiKey(), profile });
      const nodes = await provider.discoverNodes();
      const inputs = mapDiscoveredNodes(nodes);
      if (inputs.refVideos?.length !== 1 || !inputs.prompt.nodeId || inputs.refImages.length > 3) throw new Error('需要明确的一个视频输入、提示词输入及至多三个参考图片输入，请检查 apiCallDemo 映射');
      return this.persistVideoReferenceProfile({ ...profile, nodes, inputs, capabilities: { supportedModes: ['vref2va'], maxVideoRefs: 1, maxImageRefs: inputs.refImages.length, maxAudioRefs: 0, maxTotalRefs: 1 + inputs.refImages.length }, verification: { status: 'nodes_detected', checkedAt: new Date().toISOString(), note: '视频必填，图片可选；节点已探测，尚未真实生成' } });
    } catch (error) {
      return this.persistVideoReferenceProfile({ ...profile, capabilities: { supportedModes: [] }, verification: { status: 'failed', checkedAt: new Date().toISOString(), note: error instanceof Error ? error.message : String(error) } });
    }
  }

  confirmVideoReferenceVerified() {
    const profile = this.getVideoReferenceProfile();
    return this.persistVideoReferenceProfile({ ...profile, verification: { status: 'verified', checkedAt: new Date().toISOString(), note: '真实视频参考任务已提交' } });
  }

  /**
   * Upgrade every saved AI App entry into a self-contained workflow profile.
   * A bare `{ id, name, appId }` reference remains executable only when it can
   * inherit the legacy top-level mapping; otherwise it is saved but blocked.
   */
  private sanitizeProfile(raw: unknown): AiAppProfile {
    const base = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const region: RunningHubRegion = base.region === 'global'
      ? 'global'
      : base.region === 'cn'
        ? 'cn'
        : typeof base.invokeUrl === 'string' && /\/\/www\.runninghub\.ai(?:\/|$)/i.test(base.invokeUrl)
          ? 'global'
          : 'cn';
    const d = defaultAiAppProfile(region);
    const topAppId = typeof base.appId === 'string' && base.appId.trim() ? base.appId.trim() : d.appId;
    const topNodes = Array.isArray(base.nodes) ? base.nodes as AiAppProfile['nodes'] : [];
    const topInputs = sanitizeInputs(base.inputs, d.inputs);
    const topCapabilities = sanitizeCapabilities(base.capabilities, topInputs, topNodes) ?? d.capabilities;
    const topVerification = sanitizeVerification(base.verification, d.verification);
    const explicitActive = typeof base.activeWorkflowId === 'string' && base.activeWorkflowId.trim()
      ? base.activeWorkflowId.trim()
      : '';
    let apps = Array.isArray(base.apps)
      ? base.apps.map((entry) => sanitizeWorkflow(entry)).filter((entry): entry is WorkflowProfile => Boolean(entry))
      : [];
    if (!apps.length) {
      apps = [{
        id: 'primary',
        name: '主视频生成',
        appId: topAppId,
        description: '默认 H3 视频生成 App',
        inputs: topInputs,
        nodes: topNodes,
        capabilities: topCapabilities,
        verification: topVerification,
        providerParamBindings: sanitizeBindings(base.providerParamBindings),
      }];
    }
    const ids = new Map<string, number>();
    apps = apps.map((entry) => {
      const n = ids.get(entry.id) ?? 0;
      ids.set(entry.id, n + 1);
      return n === 0 ? entry : { ...entry, id: `${entry.id}-${n + 1}` };
    });
    let active = explicitActive ? apps.find((entry) => entry.id === explicitActive) : undefined;
    if (!active) active = apps.find((entry) => entry.appId === topAppId);
    const appIdMismatch = !apps.some((entry) => entry.appId === topAppId);
    const legacyTopLevel = (appIdMismatch && (!explicitActive || active?.appId !== topAppId))
      || (active?.appId === topAppId && (!active.inputs || active.verification?.status === 'unconfigured'));
    if (legacyTopLevel) {
      // Older profiles stored the real primary App at the top level while
      // `apps[]` still contained secondary/stale entries. Promote the
      // top-level mapping into the active entry once; later saves mirror the
      // active entry, so an explicitly selected unmapped workflow stays blocked.
      const id = explicitActive || active?.id || apps[0]?.id || 'primary';
      const promoted: WorkflowProfile = {
        id,
        name: active?.name ?? '主视频生成',
        appId: topAppId,
        ...(active?.description ? { description: active.description } : {}),
        inputs: topInputs,
        nodes: topNodes,
        capabilities: topCapabilities,
        verification: topVerification,
        providerParamBindings: sanitizeBindings(base.providerParamBindings),
      };
      apps = [promoted, ...apps.filter((entry) => entry.id !== id)];
      active = promoted;
    }
    if (!active) active = apps[0]!;
    const activeId = active.id;
    const ordered = [active, ...apps.filter((entry) => entry.id !== activeId)].map(enrichWorkflow);
    const inputs = active.inputs ?? disabledInputs();
    const capabilities = active.capabilities ?? { supportedModes: [] };
    const verification = active.verification ?? emptyVerification();
    const profile: AiAppProfile = {
      ...d,
      ...base,
      region,
      concurrency: Number.isInteger(Number(base.concurrency))
        ? Math.min(4, Math.max(1, Number(base.concurrency)))
        : d.concurrency,
      appId: active.appId,
      invokeUrl: `${runningHubOrigin(region)}/openapi/v2/run/ai-app/${active.appId}`,
      nodes: active.nodes ?? [],
      inputs,
      capabilities,
      verification,
      apps: ordered,
      activeWorkflowId: activeId,
      providerParamBindings: active.providerParamBindings,
    };
    delete (profile as unknown as Record<string, unknown>).bindingSlots;
    delete (profile as unknown as Record<string, unknown>).slotsByMode;
    delete (profile as unknown as Record<string, unknown>).workflowReadiness;
    delete (profile as unknown as Record<string, unknown>).workflowSummaries;
    delete (profile as unknown as Record<string, unknown>).activeModes;
    return profile;
  }

  saveProfile(raw: unknown): AiAppProfile {
    const previous = this.getProfile() ?? defaultAiAppProfile();
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const explicitActive = typeof input.activeWorkflowId === 'string' && input.activeWorkflowId.trim()
      ? input.activeWorkflowId.trim()
      : undefined;
    if (explicitActive && !previous.apps.some((entry) => entry.id === explicitActive)
      && !(Array.isArray(input.apps) && input.apps.some((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).id === explicitActive))) {
      throw new Error(`activeWorkflowId "${explicitActive}" does not match any saved workflow`);
    }
    let appsRaw: unknown[] | null = Array.isArray(input.apps) ? input.apps : null;
    if (!appsRaw) {
      // Legacy PUTs without apps update only the active workflow.
      const activeId = previous.activeWorkflowId ?? previous.apps[0]?.id;
      appsRaw = previous.apps.map((entry) => {
        if (entry.id !== activeId) return entry;
        return {
          ...entry,
          ...(input.appId === undefined ? {} : { appId: input.appId }),
          ...(input.inputs === undefined ? {} : { inputs: input.inputs }),
          ...(input.nodes === undefined ? {} : { nodes: input.nodes }),
          ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
          ...(input.verification === undefined ? {} : { verification: input.verification }),
          ...(input.providerParamBindings === undefined ? {} : { providerParamBindings: input.providerParamBindings }),
        };
      });
    }
    const mergedApps = appsRaw.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const rec = entry as Record<string, unknown>;
      const id = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : '';
      const appId = typeof rec.appId === 'string' ? rec.appId.trim() : '';
      const prior = previous.apps.find((item) => item.id === id)
        ?? previous.apps.find((item) => item.appId === appId);
      if (!prior) return rec;
      const declaresMapping = Object.prototype.hasOwnProperty.call(rec, 'inputs')
        || Object.prototype.hasOwnProperty.call(rec, 'nodes')
        || Object.prototype.hasOwnProperty.call(rec, 'capabilities')
        || Object.prototype.hasOwnProperty.call(rec, 'verification');
      if (declaresMapping) return rec;
      if (appId && appId !== prior.appId) {
        return { ...prior, ...rec, appId, inputs: undefined, nodes: [], capabilities: { supportedModes: [] }, verification: emptyVerification('AI App 已修改；请检测新 App 的节点映射') };
      }
      return { ...prior, ...rec };
    });
    const requestedActive = explicitActive ?? previous.activeWorkflowId;
    // A truly explicit switch (activation) takes its mapping from the target;
    // a PUT that merely echoes the existing activeWorkflowId is a legacy
    // top-level update and must keep its submitted evidence.
    const activeSwitch = Boolean(explicitActive && explicitActive !== previous.activeWorkflowId);
    const activeRaw = requestedActive
      ? mergedApps.find((entry) => entry && typeof entry === 'object' && (entry as Record<string, unknown>).id === requestedActive)
      : undefined;
    const activeEntry = activeRaw && typeof activeRaw === 'object' ? activeRaw as Record<string, unknown> : null;
    let profile = this.sanitizeProfile({
      ...previous,
      ...input,
      apps: mergedApps,
      activeWorkflowId: requestedActive,
      // These fields mirror the active workflow only; never let a stale PUT
      // body override the workflow evidence. An explicit active switch takes
      // its App ID and mapping from that workflow, not from the old mirror.
      appId: activeSwitch ? (typeof activeEntry?.appId === 'string' ? activeEntry.appId : input.appId ?? previous.appId) : input.appId ?? previous.appId,
      inputs: activeSwitch ? (activeEntry?.inputs ?? input.inputs ?? previous.inputs) : input.inputs ?? previous.inputs,
      nodes: activeSwitch ? (activeEntry?.nodes ?? input.nodes ?? previous.nodes) : input.nodes ?? previous.nodes,
      capabilities: activeSwitch ? (activeEntry?.capabilities ?? input.capabilities ?? previous.capabilities) : input.capabilities ?? previous.capabilities,
      verification: activeSwitch ? (activeEntry?.verification ?? input.verification ?? previous.verification) : input.verification ?? previous.verification,
    });
    const regionChanged = profile.region !== previous.region;
    const changed = new Set<string>();
    for (const entry of profile.apps) {
      const prior = previous.apps.find((item) => item.id === entry.id);
      if (!prior || prior.appId !== entry.appId || JSON.stringify(prior.inputs) !== JSON.stringify(entry.inputs)) {
        changed.add(entry.id);
      }
    }
    if (regionChanged) {
      profile = {
        ...profile,
        apps: profile.apps.map((entry) => ({
          ...entry,
          nodes: [],
          capabilities: { ...(entry.capabilities ?? { supportedModes: [] }), supportedModes: [] },
          verification: emptyVerification('RunningHub 站点已修改；请重新检测该 App 的节点映射'),
        })),
      };
    } else if (changed.size) {
      profile = {
        ...profile,
        apps: profile.apps.map((entry) => changed.has(entry.id)
          ? {
              ...entry,
              nodes: [],
              capabilities: { ...(entry.capabilities ?? { supportedModes: [] }), supportedModes: [] },
              verification: emptyVerification('AI App 或节点映射已修改；请重新检测'),
            }
          : entry),
      };
    }
    // Re-mirror the active workflow after evidence resets. Reset the
    // top-level mirror too, otherwise sanitize would promote stale verified
    // top-level evidence back into the freshly invalidated workflow.
    const mirrored = profile.apps.find((entry) => entry.id === profile.activeWorkflowId);
    if (mirrored) {
      profile = {
        ...profile,
        appId: mirrored.appId,
        inputs: mirrored.inputs ?? disabledInputs(),
        nodes: mirrored.nodes ?? [],
        capabilities: mirrored.capabilities ?? { supportedModes: [] },
        verification: mirrored.verification ?? emptyVerification(),
      };
    }
    profile = this.sanitizeProfile(profile);
    const saved = this.persistProfile(profile);
    if (regionChanged) {
      const storyboard = this.getStoryboardProfile();
      this.persistStoryboardProfile({
        ...storyboard,
        nodes: [],
        verification: { status: 'unconfigured', checkedAt: null, note: 'RunningHub 站点已修改，请重新检测 Storyboard AI App 节点' },
      });
    }
    return saved;
  }

  private persistProfile(profile: AiAppProfile): AiAppProfile {
    this.getRegistryDb().run(
      'INSERT INTO provider_profiles (id, profile_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at',
      ['runninghub', j(profile), new Date().toISOString()],
    );
    this.refresh();
    return profile;
  }

  setRunningHubRegion(raw: unknown): { profile: AiAppProfile; storyboardProfile: StoryboardProviderProfile } {
    if (raw !== 'cn' && raw !== 'global') throw new Error('RunningHub region must be cn or global');
    const region = raw as RunningHubRegion;
    const current = this.getProfile() ?? defaultAiAppProfile();
    if (current.region === region) return { profile: current, storyboardProfile: this.getStoryboardProfile() };
    const profile = this.saveProfile({ ...current, region });
    return { profile, storyboardProfile: this.getStoryboardProfile() };
  }

  /**
   * Detect nodes: fetch the app's real node layout with the user's key and
   * map it to business inputs. P0-6: this is NOT a verification — the mapping
   * is heuristic until a real submission succeeds against it, so the status
   * becomes 'nodes_detected', not 'verified'.
   */
  private updateWorkflowEvidence(profile: AiAppProfile, id: string, patch: Partial<WorkflowProfile>): AiAppProfile {
    const apps = profile.apps.map((entry) => entry.id === id ? { ...entry, ...patch } : entry);
    return this.persistProfile(this.sanitizeProfile({
      ...profile,
      apps,
      activeWorkflowId: profile.activeWorkflowId ?? apps[0]?.id,
      appId: profile.appId,
      inputs: profile.inputs,
      nodes: profile.nodes,
      capabilities: profile.capabilities,
      verification: profile.verification,
    }));
  }

  async detectAndVerify(): Promise<AiAppProfile> {
    const p = this.getProject();
    if (!p) throw new Error('no project open');
    const current = this.getProfile() ?? defaultAiAppProfile();
    const provider = this.providers.get('runninghub');
    if (!provider || !(provider instanceof RunningHubAiAppProvider)) {
      throw new Error('runninghub provider not active (mock mode?)');
    }
    const activeId = current.activeWorkflowId ?? current.apps[0]?.id ?? 'primary';
    let nodes: AiAppProfile['nodes'];
    let note: string;
    try {
      nodes = await provider.discoverNodes();
      note = `detected ${nodes.length} node(s) via apiCallDemo — mapping not yet confirmed by a real render`;
    } catch (e) {
      nodes = current.nodes;
      note = `detection failed: ${e instanceof Error ? e.message : e}`;
      return this.updateWorkflowEvidence(current, activeId, {
        nodes: [],
        capabilities: { supportedModes: [] },
        verification: { status: 'failed', checkedAt: new Date().toISOString(), note },
      });
    }
    const mapped = mapDiscoveredNodes(nodes);
    return this.updateWorkflowEvidence(current, activeId, {
      nodes,
      inputs: mapped,
      capabilities: discoveredCapabilities(mapped, nodes, current.capabilities, current.apps.find((entry) => entry.id === activeId)?.kind),
      verification: { status: 'nodes_detected', checkedAt: new Date().toISOString(), note },
    });
  }

  /** Verify one saved workflow without changing which workflow is active. */
  async verifyWorkflow(id: string): Promise<WorkflowProfile> {
    const profile = this.getProfile() ?? defaultAiAppProfile();
    const workflow = profile.apps.find((entry) => entry.id === id);
    if (!workflow) throw new Error(`workflow not found: ${id}`);
    try {
      const provider = new RunningHubAiAppProvider({ apiKey: this.getEffectiveApiKey(), profile: workflowAsProfile(workflow, profile) });
      const nodes = await provider.discoverNodes();
      const mapped = mapDiscoveredNodes(nodes);
      const capabilities = discoveredCapabilities(mapped, nodes, workflow.capabilities ?? { supportedModes: [] }, workflow.kind);
      if (!mapped.prompt.nodeId || !capabilities.supportedModes.length) {
        throw new Error('未识别到可用的 Prompt 或参考输入映射，请检查 apiCallDemo 节点');
      }
      if (capabilities.supportedModes.includes('faceswap') && ((mapped.refVideos ?? []).filter((slot) => slot.nodeId).length !== 1 || mapped.refImages.filter((slot) => slot.nodeId).length !== 1)) {
        throw new Error('换脸模式需要恰好一个人脸图片槽位和一个源视频槽位');
      }
      const updated = this.updateWorkflowEvidence(profile, id, {
        nodes,
        inputs: mapped,
        capabilities,
        verification: { status: 'nodes_detected', checkedAt: new Date().toISOString(), note: `已检测 ${nodes.length} 个节点；真实提交成功后才标记为已验证` },
      });
      return updated.apps.find((entry) => entry.id === id)!;
    } catch (error) {
      const updated = this.updateWorkflowEvidence(profile, id, {
        nodes: [],
        capabilities: { supportedModes: [] },
        verification: { status: 'failed', checkedAt: new Date().toISOString(), note: error instanceof Error ? error.message : String(error) },
      });
      const failed = updated.apps.find((entry) => entry.id === id)!;
      throw Object.assign(new Error(failed.verification?.note ?? 'workflow verification failed'), { workflow: failed });
    }
  }

  /** Create or update a workflow entry. Renaming preserves evidence; changing
   * the App ID or node mapping invalidates it. */
  upsertWorkflow(raw: unknown): WorkflowProfile {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const profile = this.getProfile() ?? defaultAiAppProfile();
    const requestedId = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : '';
    const appId = typeof input.appId === 'string' ? input.appId.trim() : '';
    if (!appId) throw new Error('appId is required');
    const existing = profile.apps.find((entry) => (requestedId && entry.id === requestedId) || entry.appId === appId) ?? null;
    const id = requestedId || existing?.id || `wf-${appId}`;
    const next: WorkflowProfile = {
      ...(existing ?? {}),
      id,
      appId,
      name: typeof input.name === 'string' && input.name.trim() ? input.name.trim() : existing?.name ?? `AI App ${appId}`,
      ...(typeof input.description === 'string' ? { description: input.description.trim() } : {}),
      ...(sanitizeKind(input.kind) ? { kind: sanitizeKind(input.kind) } : {}),
      ...(input.inputs !== undefined ? { inputs: sanitizeInputs(input.inputs, disabledInputs()) } : {}),
      ...(input.providerParamBindings !== undefined ? { providerParamBindings: sanitizeBindings(input.providerParamBindings) } : {}),
      verification: existing?.verification ?? emptyVerification(),
    };
    delete next.runnable;
    delete next.modes;
    delete next.readiness;
    const apps = existing
      ? profile.apps.map((entry) => entry.id === existing.id ? next : entry)
      : [...profile.apps, next];
    const saved = this.saveProfile({
      ...profile,
      apps,
      activeWorkflowId: profile.activeWorkflowId,
      appId: profile.appId,
      inputs: profile.inputs,
      nodes: profile.nodes,
      capabilities: profile.capabilities,
      verification: profile.verification,
    });
    return saved.apps.find((entry) => entry.id === id)!;
  }

  /** Active workflow selection is explicit and requires a real node mapping. */
  activateWorkflow(id: string): AiAppProfile {
    const profile = this.getProfile() ?? defaultAiAppProfile();
    const workflow = profile.apps.find((entry) => entry.id === id);
    if (!workflow) throw new Error(`workflow not found: ${id}`);
    if (!workflow.inputs?.prompt.nodeId || !workflow.capabilities?.supportedModes.length) {
      throw new Error('该 AI App 还没有节点映射，不能设为当前工作流；请先检测节点');
    }
    if (workflow.verification?.status === 'failed') {
      throw new Error('该 AI App 节点检测失败，请重新检测后再设为当前工作流');
    }
    return this.saveProfile({
      ...profile,
      activeWorkflowId: id,
      appId: profile.appId,
      inputs: profile.inputs,
      nodes: profile.nodes,
      capabilities: profile.capabilities,
      verification: profile.verification,
    });
  }

  /** Render the exact nodeInfoList a mode WOULD submit. Local and free. */
  previewWorkflow(id: string, mode: H3Mode, overrides: { durationSeconds?: number; aspectRatio?: string; megapixels?: number } = {}): {
    workflowId: string;
    appId: string;
    mode: H3Mode;
    nodeInfoList: Array<{ nodeId: string; fieldName: string; fieldValue: string }>;
    note: string;
  } {
    const profile = this.getProfile() ?? defaultAiAppProfile();
    const workflow = profile.apps.find((entry) => entry.id === id);
    if (!workflow) throw new Error(`workflow not found: ${id}`);
    if (!workflow.inputs?.prompt.nodeId) throw new Error('该工作流还没有节点映射');
    if (!workflow.capabilities?.supportedModes.includes(mode)) throw new Error(`该工作流未声明 ${mode} 模式`);
    if (!['nodes_detected', 'verified'].includes(workflow.verification?.status ?? '')) {
      throw new Error('该工作流尚未通过节点检测，不能预览提交载荷');
    }
    const provider = new RunningHubAiAppProvider({ apiKey: this.getEffectiveApiKey(), profile: workflowAsProfile(workflow, profile) });
    const references = previewReferences(mode);
    const nodeInfoList = provider.previewNodeInfoList({
      mode,
      prompt: '<compiled prompt>',
      durationSeconds: overrides.durationSeconds ?? 5,
      aspectRatio: overrides.aspectRatio ?? '16:9',
      megapixels: overrides.megapixels,
      references,
      providerParams: {},
    });
    return {
      workflowId: id,
      appId: workflow.appId,
      mode,
      nodeInfoList,
      note: '这是不联网、不提交的本地载荷预览；上传文件名以上传后的真实值为准。',
    };
  }

  /**
   * Called after a real provider submission returns a taskId: the mapping is
   * now confirmed executable → 'verified', which unlocks full capabilities.
   */
  confirmVerified(): AiAppProfile {
    const profile = this.getProfile() ?? defaultAiAppProfile();
    const id = profile.activeWorkflowId ?? profile.apps[0]?.id;
    if (!id) return profile;
    return this.updateWorkflowEvidence(profile, id, {
      verification: { status: 'verified', checkedAt: new Date().toISOString(), note: 'a real render submission succeeded against this profile' },
    });
  }

  /** Confirm the workflow that actually produced a task ID (which may not be
   * the active one, e.g. faceswap or a frame App). */
  confirmSubmission(appId: string, mode?: H3Mode): void {
    try {
      if (this.isFrameMode(mode) && this.getFrameProfile()?.appId === appId) {
        this.confirmFrameVerified(appId);
        return;
      }
      if (mode === 'vref2va') {
        const legacy = this.getVideoReferenceProfile();
        if (legacy.appId === appId) {
          this.confirmVideoReferenceVerified();
          return;
        }
      }
      const profile = this.getProfile() ?? defaultAiAppProfile();
      const workflow = profile.apps.find((entry) => entry.appId === appId);
      if (workflow) {
        this.updateWorkflowEvidence(profile, workflow.id, {
          verification: { status: 'verified', checkedAt: new Date().toISOString(), note: 'a real render submission succeeded against this workflow' },
        });
        return;
      }
      this.confirmVerified();
    } catch {
      /* profile persistence is best-effort after a paid submit */
    }
  }

  getStoryboardProfile(): StoryboardProviderProfile {
    const fallback = defaultStoryboardProviderProfile(this.getProfile()?.region ?? 'cn');
    const row = this.getRegistryDb().get<{ profile_json: string }>("SELECT profile_json FROM provider_profiles WHERE id = 'runninghub-storyboard'");
    return this.sanitizeStoryboardProfile(row ? jget<unknown>(row.profile_json, fallback) : fallback);
  }

  private sanitizeStoryboardProfile(raw: unknown): StoryboardProviderProfile {
    const region = this.getProfile()?.region ?? 'cn';
    const d = defaultStoryboardProviderProfile(region);
    const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const inputs = (value.inputs && typeof value.inputs === 'object' ? value.inputs : {}) as Record<string, unknown>;
    const slot = (key: keyof StoryboardProviderProfile['inputs']) => {
      const candidate = (inputs[key] && typeof inputs[key] === 'object' ? inputs[key] : {}) as Record<string, unknown>;
      return {
        nodeId: typeof candidate.nodeId === 'string' ? candidate.nodeId.trim() : d.inputs[key].nodeId,
        fieldName: typeof candidate.fieldName === 'string' && candidate.fieldName.trim() ? candidate.fieldName.trim() : d.inputs[key].fieldName,
      };
    };
    const sizes = (value.sizeValues && typeof value.sizeValues === 'object' ? value.sizeValues : {}) as Record<string, unknown>;
    const appId = typeof value.appId === 'string' && value.appId.trim() ? value.appId.trim() : d.appId;
    const cost = value.estimatedCostCny === null ? null : Number(value.estimatedCostCny);
    return {
      ...d,
      region,
      enabled: value.enabled === undefined ? d.enabled : value.enabled === true,
      appId,
      invokeUrl: `${runningHubOrigin(region)}/openapi/v2/run/ai-app/${appId}`,
      estimatedCostCny: cost === null || (Number.isFinite(cost) && cost >= 0) ? cost : d.estimatedCostCny,
      inputs: { prompt: slot('prompt'), size: slot('size'), layoutImage: slot('layoutImage') },
      sizeValues: {
        3: typeof sizes[3] === 'string' && sizes[3] ? sizes[3] : d.sizeValues[3],
        6: typeof sizes[6] === 'string' && sizes[6] ? sizes[6] : d.sizeValues[6],
        9: typeof sizes[9] === 'string' && sizes[9] ? sizes[9] : d.sizeValues[9],
      },
      nodes: Array.isArray(value.nodes) ? value.nodes as StoryboardProviderProfile['nodes'] : d.nodes,
      verification: value.verification && typeof value.verification === 'object'
        ? { ...d.verification, ...(value.verification as object) }
        : d.verification,
    };
  }

  saveStoryboardProfile(raw: unknown): StoryboardProviderProfile {
    const previous = this.getStoryboardProfile();
    let profile = this.sanitizeStoryboardProfile(raw);
    const mappingChanged = profile.region !== previous.region || profile.appId !== previous.appId || JSON.stringify(profile.inputs) !== JSON.stringify(previous.inputs);
    if (mappingChanged) {
      profile = {
        ...profile,
        nodes: [],
        verification: { status: 'unconfigured', checkedAt: null, note: 'AI App 或节点映射已修改，请重新检测' },
      };
    }
    return this.persistStoryboardProfile(profile);
  }

  private persistStoryboardProfile(profile: StoryboardProviderProfile): StoryboardProviderProfile {
    this.getRegistryDb().run(
      'INSERT INTO provider_profiles (id, profile_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at',
      ['runninghub-storyboard', j(profile), new Date().toISOString()],
    );
    return profile;
  }

  async verifyStoryboardProfile(): Promise<StoryboardProviderProfile> {
    const key = this.getEffectiveApiKey();
    if (!key) throw new Error('RunningHub API Key 未配置');
    const current = this.getStoryboardProfile();
    const url = `${runningHubOrigin(current.region)}/api/webapp/apiCallDemo?apiKey=${encodeURIComponent(key)}&webappId=${encodeURIComponent(current.appId)}`;
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      throw new Error(`Storyboard 节点检测失败：${error instanceof Error ? error.message : error}`);
    }
    const json = await response.json().catch(() => null) as { code?: number; msg?: string; message?: string; data?: { nodeInfoList?: Array<Record<string, unknown>> } } | null;
    const rawNodes = json?.data?.nodeInfoList;
    if (!response.ok || (json?.code !== 0 && json?.code !== 200) || !Array.isArray(rawNodes)) {
      const failed = {
        ...current,
        verification: { status: 'failed' as const, checkedAt: new Date().toISOString(), note: json?.msg ?? json?.message ?? `HTTP ${response.status}` },
      };
      this.persistStoryboardProfile(failed);
      throw new Error(failed.verification.note);
    }
    const nodes = rawNodes.map((node) => ({
      nodeId: String(node.nodeId ?? ''),
      nodeName: String(node.nodeName ?? ''),
      fieldName: String(node.fieldName ?? ''),
      fieldType: String(node.fieldType ?? 'STRING'),
      fieldData: node.fieldData == null ? null : String(node.fieldData),
      description: String(node.description ?? node.descriptionCn ?? node.descriptionEn ?? ''),
    }));
    const inputs = mapStoryboardProviderNodes(nodes);
    if (!inputs) throw new Error('未识别到完整的 Prompt、分辨率、参考图节点，请检查 AI App');
    const updated: StoryboardProviderProfile = {
      ...current,
      nodes,
      inputs,
      verification: {
        status: 'nodes_detected',
        checkedAt: new Date().toISOString(),
        note: `已检测 ${nodes.length} 个节点；首次真实生图成功后标记为已验证`,
      },
    };
    return this.persistStoryboardProfile(updated);
  }

  confirmStoryboardVerified(): StoryboardProviderProfile {
    const current = this.getStoryboardProfile();
    return this.persistStoryboardProfile({
      ...current,
      verification: { status: 'verified', checkedAt: new Date().toISOString(), note: '真实 Storyboard 任务已成功提交' },
    });
  }

  getComfyUiProfile(): ComfyUiWorkflowProfile {
    const fallback = defaultComfyUiProfile();
    const row = this.getRegistryDb().get<{ profile_json: string }>("SELECT profile_json FROM provider_profiles WHERE id = 'comfyui'");
    return row ? sanitizeComfyUiProfile(jget<unknown>(row.profile_json, fallback)) : fallback;
  }

  private persistComfyUiProfile(profile: ComfyUiWorkflowProfile): ComfyUiWorkflowProfile {
    this.getRegistryDb().run(
      'INSERT INTO provider_profiles (id, profile_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at',
      ['comfyui', j(profile), new Date().toISOString()],
    );
    this.refresh();
    return profile;
  }

  saveComfyUiProfile(raw: unknown): ComfyUiWorkflowProfile {
    return this.persistComfyUiProfile(sanitizeComfyUiProfile(raw, { resetVerification: true }));
  }

  importComfyUiWorkflow(raw: unknown): ComfyUiWorkflowProfile {
    return this.persistComfyUiProfile(importComfyUiWorkflow(this.getComfyUiProfile(), raw));
  }

  async verifyComfyUi(): Promise<ComfyUiWorkflowProfile> {
    const current = this.getComfyUiProfile();
    const provider = new ComfyUiProvider(current);
    try {
      if (!Object.keys(current.workflow).length) throw new Error('请先导入 ComfyUI API Format 工作流');
      if (!current.capabilities.supportedModes.length) throw new Error('没有识别到可用的 Prompt 或参考图输入映射');
      const slots = [
        current.inputs.prompt,
        current.inputs.mode,
        current.inputs.firstFrame,
        current.inputs.lastFrame,
        ...current.inputs.refImages,
        current.inputs.duration,
        current.inputs.aspectRatio,
        current.inputs.megapixels,
        ...Object.values(current.providerParamBindings ?? {}),
      ].filter((slot): slot is ComfyUiInputBinding => Boolean(slot));
      for (const slot of slots) {
        const node = current.workflow[slot.nodeId];
        if (!node) throw new Error(`映射引用了不存在的节点 ${slot.nodeId}`);
        if (!Object.prototype.hasOwnProperty.call(node.inputs, slot.inputName)) {
          throw new Error(`节点 ${slot.nodeId} 没有输入字段 ${slot.inputName}`);
        }
      }
      await provider.probe();
      return this.persistComfyUiProfile({
        ...current,
        verification: {
          status: 'nodes_detected',
          checkedAt: new Date().toISOString(),
          note: `connected to ${current.baseUrl}${current.apiPrefix}; workflow has ${Object.keys(current.workflow).length} nodes — mapping awaits one successful render`,
        },
      });
    } catch (error) {
      return this.persistComfyUiProfile({
        ...current,
        verification: {
          status: 'failed',
          checkedAt: new Date().toISOString(),
          note: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  confirmProviderVerified(providerId: string): void {
    if (providerId === 'runninghub') {
      this.confirmVerified();
      return;
    }
    if (providerId === 'comfyui') {
      const profile = this.getComfyUiProfile();
      this.persistComfyUiProfile({
        ...profile,
        verification: {
          status: 'verified',
          checkedAt: new Date().toISOString(),
          note: 'a real ComfyUI prompt was accepted with this workflow mapping',
        },
      });
    }
  }
}
