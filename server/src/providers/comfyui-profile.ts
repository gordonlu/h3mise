import { randomUUID } from 'node:crypto';
import type {
  ComfyUiApiNode,
  ComfyUiInputBinding,
  ComfyUiWorkflowProfile,
  H3Mode,
  ProviderVerification,
} from '@h3mise/shared';

const EMPTY_VERIFICATION: ProviderVerification = {
  status: 'unconfigured',
  checkedAt: null,
  note: 'import a ComfyUI workflow in API format, then test the connection and mapping',
};

export function defaultComfyUiProfile(): ComfyUiWorkflowProfile {
  return {
    provider: 'comfyui',
    concurrency: 1,
    baseUrl: 'http://127.0.0.1:8188',
    apiPrefix: '',
    clientId: `h3mise-${randomUUID()}`,
    allowRemote: false,
    workflow: {},
    inputs: { refImages: [] },
    capabilities: {
      supportedModes: [],
      maxImageRefs: 0,
      maxVideoRefs: 0,
      maxAudioRefs: 0,
      maxTotalRefs: 0,
      audioSupported: false,
    },
    verification: { ...EMPTY_VERIFICATION },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function unwrapComfyUiWorkflow(raw: unknown): Record<string, ComfyUiApiNode> {
  const base = isRecord(raw) ? raw : {};
  const candidate = isRecord(base.prompt) ? base.prompt : isRecord(base.workflow) ? base.workflow : base;
  const workflow: Record<string, ComfyUiApiNode> = {};
  for (const [id, value] of Object.entries(candidate)) {
    if (!isRecord(value) || typeof value.class_type !== 'string' || !isRecord(value.inputs)) continue;
    const meta = isRecord(value._meta) ? value._meta : undefined;
    workflow[id] = {
      class_type: value.class_type,
      inputs: structuredClone(value.inputs),
      ...(meta ? { _meta: structuredClone(meta) as ComfyUiApiNode['_meta'] } : {}),
    };
  }
  return workflow;
}

interface Candidate {
  nodeId: string;
  inputName: string;
  haystack: string;
}

/** Best-effort mapping from node titles/input names. Ambiguous fields remain
 * disabled and are expected to be confirmed by a user or their Agent. */
export function inferComfyUiBindings(workflow: Record<string, ComfyUiApiNode>): Pick<ComfyUiWorkflowProfile, 'inputs' | 'outputNodeId' | 'capabilities'> {
  const candidates: Candidate[] = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    const title = node._meta?.title ?? '';
    for (const [inputName, value] of Object.entries(node.inputs)) {
      // Connection tuples are graph edges, not editable widget values.
      if (Array.isArray(value)) continue;
      candidates.push({ nodeId, inputName, haystack: `${title} ${node.class_type} ${inputName}`.toLowerCase() });
    }
  }
  const binding = (item: Candidate | undefined): ComfyUiInputBinding | undefined =>
    item ? { nodeId: item.nodeId, inputName: item.inputName } : undefined;
  const pick = (re: RegExp, reject?: RegExp) => candidates.find((item) => re.test(item.haystack) && !(reject?.test(item.haystack)));
  const imageCandidates = candidates.filter((item) => /(^|\s|_)image($|\s|_)|loadimage|图片|图像/i.test(item.haystack));
  const first = imageCandidates.find((item) => /first.?frame|start.?frame|首帧|起始帧/i.test(item.haystack));
  const last = imageCandidates.find((item) => /last.?frame|end.?frame|尾帧|结束帧/i.test(item.haystack));
  const frameIds = new Set([first?.nodeId, last?.nodeId].filter(Boolean));
  const refs = imageCandidates.filter((item) => !frameIds.has(item.nodeId) && /ref(erence)?.?image|参考图|参考图片/i.test(item.haystack));
  const prompt = pick(/prompt|positive.?text|提示词|正向描述/i, /negative|负向/i)
    ?? pick(/cliptextencode.*\btext\b/i, /negative|负向/i);
  const inputs: ComfyUiWorkflowProfile['inputs'] = {
    prompt: binding(prompt),
    mode: binding(pick(/(^|\s|_)mode($|\s|_)|生成模式/i)),
    firstFrame: binding(first),
    lastFrame: binding(last),
    refImages: refs.map((item) => binding(item)!),
    duration: binding(pick(/duration|seconds|时长/i)),
    aspectRatio: binding(pick(/aspect.?ratio|宽高比|画幅|比例/i)),
    megapixels: binding(pick(/megapixel|百万像素/i)),
  };
  const supportedModes = inferComfyUiModes(inputs);
  const outputNodeId = Object.entries(workflow).find(([, node]) =>
    /save.*video|video.*combine|saveanimated|保存.*视频/i.test(`${node._meta?.title ?? ''} ${node.class_type}`),
  )?.[0];
  return {
    inputs,
    outputNodeId,
    capabilities: {
      supportedModes,
      maxImageRefs: inputs.refImages.length,
      maxVideoRefs: 0,
      maxAudioRefs: 0,
      maxTotalRefs: inputs.refImages.length,
      audioSupported: false,
    },
  };
}

export function inferComfyUiModes(inputs: ComfyUiWorkflowProfile['inputs']): H3Mode[] {
  const enabled = (slot: ComfyUiInputBinding | undefined) => Boolean(slot?.nodeId && slot.inputName);
  const modes: H3Mode[] = [];
  if (enabled(inputs.prompt)) modes.push('t2va');
  if (enabled(inputs.firstFrame)) modes.push('i2va');
  if (enabled(inputs.lastFrame)) modes.push('l2va');
  if (enabled(inputs.firstFrame) && enabled(inputs.lastFrame)) modes.push('fl2va');
  if (inputs.refImages.some(enabled)) modes.push('ref2va');
  return modes;
}

function sanitizeBinding(value: unknown): ComfyUiInputBinding | undefined {
  if (!isRecord(value)) return undefined;
  const nodeId = typeof value.nodeId === 'string' ? value.nodeId.trim() : '';
  const inputName = typeof value.inputName === 'string' ? value.inputName.trim() : '';
  if (!nodeId || !inputName) return undefined;
  const valueMap = isRecord(value.valueMap)
    ? Object.fromEntries(Object.entries(value.valueMap).filter(([, item]) => ['string', 'number', 'boolean'].includes(typeof item))) as Record<string, string | number | boolean>
    : undefined;
  return { nodeId, inputName, ...(valueMap && Object.keys(valueMap).length ? { valueMap } : {}) };
}

export function sanitizeComfyUiProfile(raw: unknown, options?: { resetVerification?: boolean }): ComfyUiWorkflowProfile {
  const d = defaultComfyUiProfile();
  const base = isRecord(raw) ? raw : {};
  const workflow = unwrapComfyUiWorkflow(base.workflow ?? {});
  const inferred = inferComfyUiBindings(workflow);
  const inputRaw = isRecord(base.inputs) ? base.inputs : {};
  const hasExplicitInputs = Object.keys(inputRaw).length > 0;
  const explicitRefs = Array.isArray(inputRaw.refImages) ? inputRaw.refImages.map(sanitizeBinding).filter(Boolean) as ComfyUiInputBinding[] : [];
  const inputs: ComfyUiWorkflowProfile['inputs'] = hasExplicitInputs
    ? {
        prompt: sanitizeBinding(inputRaw.prompt),
        mode: sanitizeBinding(inputRaw.mode),
        firstFrame: sanitizeBinding(inputRaw.firstFrame),
        lastFrame: sanitizeBinding(inputRaw.lastFrame),
        refImages: explicitRefs,
        duration: sanitizeBinding(inputRaw.duration),
        aspectRatio: sanitizeBinding(inputRaw.aspectRatio),
        megapixels: sanitizeBinding(inputRaw.megapixels),
      }
    : inferred.inputs;
  const supportedModes = inferComfyUiModes(inputs);
  const rawVerification = isRecord(base.verification) ? base.verification : {};
  const allowedStatuses = new Set(['unconfigured', 'nodes_detected', 'verified', 'failed']);
  const verification: ProviderVerification = options?.resetVerification
    ? { ...EMPTY_VERIFICATION }
    : {
        status: allowedStatuses.has(String(rawVerification.status)) ? rawVerification.status as ProviderVerification['status'] : d.verification.status,
        checkedAt: typeof rawVerification.checkedAt === 'string' ? rawVerification.checkedAt : null,
        note: typeof rawVerification.note === 'string' ? rawVerification.note : d.verification.note,
      };
  const prefixRaw = typeof base.apiPrefix === 'string' ? base.apiPrefix.trim() : '';
  const apiPrefix = prefixRaw && prefixRaw !== '/' ? `/${prefixRaw.replace(/^\/+|\/+$/g, '')}` : '';
  const providerParamsRaw = isRecord(base.providerParamBindings) ? base.providerParamBindings : {};
  const providerParamBindings = Object.fromEntries(
    Object.entries(providerParamsRaw).map(([key, value]) => [key, sanitizeBinding(value)]).filter((entry): entry is [string, ComfyUiInputBinding] => Boolean(entry[1])),
  );
  return {
    provider: 'comfyui',
    concurrency: Number.isInteger(Number(base.concurrency))
      ? Math.min(4, Math.max(1, Number(base.concurrency)))
      : d.concurrency,
    baseUrl: typeof base.baseUrl === 'string' && base.baseUrl.trim() ? base.baseUrl.trim().replace(/\/+$/, '') : d.baseUrl,
    apiPrefix,
    clientId: typeof base.clientId === 'string' && base.clientId.trim() ? base.clientId.trim() : d.clientId,
    allowRemote: base.allowRemote === true,
    workflow,
    inputs,
    outputNodeId: typeof base.outputNodeId === 'string' && base.outputNodeId.trim() ? base.outputNodeId.trim() : inferred.outputNodeId,
    providerParamBindings,
    capabilities: {
      ...(isRecord(base.capabilities) ? base.capabilities : {}),
      supportedModes,
      maxImageRefs: inputs.refImages.length,
      maxVideoRefs: 0,
      maxAudioRefs: 0,
      maxTotalRefs: inputs.refImages.length,
      audioSupported: false,
    },
    verification,
  };
}

export function importComfyUiWorkflow(current: ComfyUiWorkflowProfile, rawWorkflow: unknown): ComfyUiWorkflowProfile {
  const workflow = unwrapComfyUiWorkflow(rawWorkflow);
  if (!Object.keys(workflow).length) throw new Error('ComfyUI workflow is empty or not in API format');
  const inferred = inferComfyUiBindings(workflow);
  return sanitizeComfyUiProfile({
    ...current,
    workflow,
    inputs: inferred.inputs,
    outputNodeId: inferred.outputNodeId,
    verification: EMPTY_VERIFICATION,
  }, { resetVerification: true });
}
