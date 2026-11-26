import {
  DEFAULT_PROJECT_AUDIO,
  normalizeShotProduction,
  runningHub805RecoveryPlan,
  type ProjectAudioSettings,
  type ShotProductionConfig,
  type SubmissionPayloadPreview,
  type SubmissionReferencePreview,
} from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { j, jget } from '../db/sqlite.js';
import { createBinding, getMedia, listBindings } from './assets.js';
import { createShot, getShot, listShots, updateShot } from './shots.js';
import { createPrompt, getPrompt, listPrompts } from './prompt.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { RenderIntent } from './preflight.js';
import { RunningHubAiAppProvider } from '../providers/runninghub.js';
import type { RenderJob } from '@h3mise/shared';
import type { Ffmpeg } from '../ffmpeg.js';
import { dirname, join, relative, sep } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { insertMedia } from './assets.js';
import { productionPromptDirectives } from './production-directives.js';
import { nextId } from '../db/ids.js';

export function updateShotProduction(
  p: ProjectContext,
  shotId: string,
  patch: Partial<Omit<ShotProductionConfig, 'version'>>,
): ShotProductionConfig {
  const shot = getShot(p, shotId);
  for (const cue of patch.audio?.dialogue ?? []) {
    if (!cue || !Number.isFinite(cue.startSeconds) || !Number.isFinite(cue.endSeconds) || cue.startSeconds < 0 || cue.endSeconds <= cue.startSeconds || cue.endSeconds > shot.durationSeconds + 0.001) {
      throw new Error('对白时间必须满足 0 ≤ start < end ≤ Shot 时长，不能静默丢弃无效对白');
    }
  }
  const next = normalizeShotProduction({
    ...shot.production,
    ...patch,
    camera: { ...shot.production.camera, ...patch.camera },
    audio: { ...shot.production.audio, ...patch.audio },
    cctv: { ...shot.production.cctv, ...patch.cctv },
    segment: { ...shot.production.segment, ...patch.segment },
  });
  if (next.camera.heightMeters !== null && (next.camera.heightMeters < 0 || next.camera.heightMeters > 100)) throw new Error('机位高度必须在 0–100 米之间');
  if (next.camera.focalLengthMm !== null && (next.camera.focalLengthMm < 1 || next.camera.focalLengthMm > 2000)) throw new Error('焦段必须在 1–2000mm 之间');
  if (next.camera.tiltDegrees !== null && Math.abs(next.camera.tiltDegrees) > 90) throw new Error('俯角必须在 -90–90 度之间');
  for (const cue of next.audio.dialogue) {
    if (!cue.text) throw new Error('对白文本不能为空');
    if (cue.endSeconds > shot.durationSeconds + 0.001) throw new Error(`对白 ${cue.id} 超出 Shot 时长`);
    if (next.audio.mode === 'native_dialogue' && !cue.speaker) throw new Error('原生对白必须标记说话角色');
  }
  p.db.run('UPDATE shots SET production_json = ?, updated_at = ? WHERE id = ?', [j(next), new Date().toISOString(), shotId]);
  return next;
}

export function getProjectAudio(p: ProjectContext): ProjectAudioSettings {
  const raw = p.db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'production.audio'")?.value;
  const saved = jget<Partial<ProjectAudioSettings>>(raw, {});
  return {
    bgmAssetId: typeof saved.bgmAssetId === 'string' ? saved.bgmAssetId : null,
    bgmGainDb: Number.isFinite(saved.bgmGainDb) ? Number(saved.bgmGainDb) : DEFAULT_PROJECT_AUDIO.bgmGainDb,
    duckingEnabled: saved.duckingEnabled !== false,
    duckingGainDb: Number.isFinite(saved.duckingGainDb) ? Number(saved.duckingGainDb) : DEFAULT_PROJECT_AUDIO.duckingGainDb,
  };
}

export function updateProjectAudio(p: ProjectContext, patch: Partial<ProjectAudioSettings>): ProjectAudioSettings {
  const current = getProjectAudio(p);
  if (patch.bgmAssetId) {
    const asset = getMedia(p, patch.bgmAssetId);
    if (asset.kind !== 'audio') throw new Error('项目 BGM 必须引用音频素材');
  }
  const bgmGainDb = Number(patch.bgmGainDb ?? current.bgmGainDb);
  const duckingGainDb = Number(patch.duckingGainDb ?? current.duckingGainDb);
  if (!Number.isFinite(bgmGainDb) || !Number.isFinite(duckingGainDb)) throw new Error('音频增益必须是有效数字');
  const next: ProjectAudioSettings = {
    bgmAssetId: patch.bgmAssetId === undefined ? current.bgmAssetId : patch.bgmAssetId,
    bgmGainDb: Math.max(-60, Math.min(12, bgmGainDb)),
    duckingEnabled: patch.duckingEnabled ?? current.duckingEnabled,
    duckingGainDb: Math.max(-60, Math.min(0, duckingGainDb)),
  };
  p.db.run("INSERT INTO settings (key, value) VALUES ('production.audio', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [j(next)]);
  return next;
}

function referencePreviews(p: ProjectContext, intent: RenderIntent): SubmissionReferencePreview[] {
  const counters = { image: 0, video: 0, audio: 0 };
  const labels = { image: 'Picture', video: 'Video', audio: 'Audio' } as const;
  return intent.references.map((reference, index) => {
    const binding = listBindings(p, intent.shotId).find((item) => item.id === reference.bindingId);
    let asset: ReturnType<typeof getMedia> | null = null;
    try { asset = getMedia(p, reference.assetId); } catch { /* Preflight reports asset integrity separately. */ }
    const order = ++counters[reference.kind];
    return {
      tag: `<${labels[reference.kind]} ${order}>`,
      bindingId: reference.bindingId,
      assetId: reference.assetId,
      order: index + 1,
      kind: reference.kind,
      label: binding?.label || asset?.label || reference.bindingId,
      assetLabel: asset?.label || binding?.label || reference.bindingId,
      roles: binding?.roles ?? [],
      referenceUse: binding?.referenceUse ?? 'general',
      framePolicy: binding?.framePolicy ?? 'unassigned',
      width: asset?.width ?? null,
      height: asset?.height ?? null,
      providerRef: intent.providerId === 'runninghub' ? `{{upload:${reference.bindingId}}}` : `mock://${reference.assetId}`,
    };
  });
}

export function buildSubmissionPreview(p: ProjectContext, registry: ProviderRegistry, intent: RenderIntent): SubmissionPayloadPreview {
  const shot = getShot(p, intent.shotId);
  const prompt = getPrompt(p, intent.promptVersionId);
  const references = referencePreviews(p, intent);
  const runningHubProfile = intent.providerId === 'runninghub' ? registry.getProfileForMode(intent.mode, intent.workflowId) : null;
  const comfyProfile = intent.providerId === 'comfyui' ? registry.getComfyUiProfile() : null;
  const appId = intent.providerId === 'runninghub'
    ? runningHubProfile?.appId ?? 'unconfigured'
    : intent.providerId === 'comfyui' ? `comfyui:${comfyProfile?.clientId ?? 'local'}` : 'mock-offline';
  const verificationStatus = intent.providerId === 'runninghub'
    ? runningHubProfile?.verification.status ?? 'unconfigured'
    : intent.providerId === 'comfyui' ? comfyProfile?.verification.status ?? 'unconfigured' : 'verified';
  const capabilities = intent.providerId === 'runninghub' ? runningHubProfile?.capabilities : intent.providerId === 'comfyui' ? comfyProfile?.capabilities : null;
  const tested = intent.providerId === 'mock' || Boolean(capabilities?.testedCombinations?.some((cell) =>
    cell.mode === intent.mode
    && cell.durationSeconds === intent.durationSeconds
    && cell.aspectRatio === intent.aspectRatio
    && cell.megapixels === (intent.megapixels ?? null)
    && (intent.providerId !== 'runninghub' || verificationStatus === 'verified')));
  const exactCombination = tested ? 'tested' : verificationStatus === 'verified' ? 'declared' : 'unknown';
  const estimate = capabilities?.costEstimate;
  const perTask = typeof estimate?.cnyPerTask === 'number' && Number.isFinite(estimate.cnyPerTask) ? estimate.cnyPerTask : null;
  const perSecond = typeof estimate?.cnyPerSecond === 'number' && Number.isFinite(estimate.cnyPerSecond) ? estimate.cnyPerSecond : null;
  const hasCostEstimate = perTask !== null || perSecond !== null;
  const estimatedCny = intent.providerId === 'mock'
    ? 0
    : hasCostEstimate
      ? Math.round(((perTask ?? 0) + (perSecond ?? 0) * intent.durationSeconds) * 10000) / 10000
      : null;
  let providerPayload: Record<string, unknown>;
  if (intent.providerId === 'runninghub') {
    const provider = registry.get(intent.providerId, intent.mode, intent.workflowId);
    if (!(provider instanceof RunningHubAiAppProvider)) {
      providerPayload = { error: '当前 RunningHub 工作流不能生成节点预览' };
    } else {
      try {
        const nodeInfoList = provider.previewNodeInfoList({
          aiAppId: runningHubProfile?.appId,
          mode: intent.mode,
          prompt: prompt.text,
          durationSeconds: intent.durationSeconds,
          aspectRatio: intent.aspectRatio,
          resolution: intent.resolution,
          megapixels: intent.megapixels,
          references: intent.references.map((reference) => {
            const binding = listBindings(p, intent.shotId).find((item) => item.id === reference.bindingId);
            return {
              asset: getMedia(p, reference.assetId),
              roles: binding?.roles ?? [],
              label: binding?.label ?? reference.bindingId,
              providerRef: `{{upload:${reference.bindingId}}}`,
            };
          }),
          providerParams: intent.providerParams,
        });
        providerPayload = {
          endpoint: `/openapi/v2/run/ai-app/${appId}`,
          nodeInfoList,
          instanceType: runningHubProfile?.instanceType ?? 'default',
          usePersonalQueue: 'false',
          uploadNote: '{{upload:...}} 是付费前占位符；提交时由同一顺序的真实上传文件名替换。',
        };
      } catch (error) {
        providerPayload = { error: error instanceof Error ? error.message : String(error) };
      }
    }
  } else {
    providerPayload = {
      provider: intent.providerId,
      appId,
      mode: intent.mode,
      prompt: prompt.text,
      durationSeconds: intent.durationSeconds,
      aspectRatio: intent.aspectRatio,
      megapixels: intent.megapixels ?? null,
      references,
      providerParams: intent.providerParams,
      output: { takes: 1, variants: [], silentVariant: false },
    };
  }
  return {
    shotId: shot.id,
    promptVersionId: prompt.id,
    promptStage: prompt.stage,
    promptText: prompt.text,
    providerId: intent.providerId,
    workflowId: intent.workflowId ?? runningHubProfile?.activeWorkflowId ?? null,
    appId,
    mode: intent.mode,
    durationSeconds: intent.durationSeconds,
    aspectRatio: intent.aspectRatio,
    megapixels: intent.megapixels ?? null,
    references,
    parameters: {
      resolution: intent.resolution ?? null,
      providerParams: intent.providerParams,
      camera: shot.production.camera,
      audioMode: shot.production.audio.mode,
      cctvOverlay: shot.production.cctv,
    },
    providerPayload,
    verification: {
      status: verificationStatus,
      exactCombination,
      note: exactCombination === 'tested'
        ? '该 Provider/App/模式/时长/画幅/MP 组合有明确实测记录。'
        : exactCombination === 'declared'
          ? 'App 已有提交验证，但这个精确参数组合尚未单独实测。'
          : '节点检测或未知状态不等于实测通过；当前组合能力未知。',
    },
    cost: {
      estimatedCny,
      evidence: intent.providerId === 'mock' ? 'mock' : hasCostEstimate ? 'user_estimate' : 'unknown',
      failureCharge: intent.providerId === 'mock' ? 'not_charged' : estimate?.failureCharge ?? 'unknown',
      note: intent.providerId === 'mock' ? 'Mock 离线生成，不产生费用。' : hasCostEstimate ? '费用为用户填写的估计，失败扣费规则按所保存证据展示。' : '没有可靠成本或失败扣费证据，不能声称免费或失败不扣费。',
    },
    generatedAt: new Date().toISOString(),
  };
}

export function createLockedCameraSegment(
  p: ProjectContext,
  shotId: string,
  input: { kind: 'continuous' | 'time_jump' | 'surveillance_skip'; durationSeconds?: number; timeJumpSeconds?: number; frameSkip?: number },
): { source: ReturnType<typeof getShot>; segment: ReturnType<typeof getShot> } {
  const source = getShot(p, shotId);
  const groupId = source.production.segment.groupId ?? `camera-${source.id}`;
  const siblings = listShots(p).filter((shot) => shot.id === source.id || shot.production.segment.groupId === groupId);
  const count = siblings.length + 1;
  const sourceProduction = normalizeShotProduction({
    ...source.production,
    camera: { ...source.production.camera, locked: true },
    segment: { ...source.production.segment, groupId, kind: source.production.segment.groupId ? source.production.segment.kind : 'continuous', index: source.production.segment.index, count },
  });
  for (const sibling of siblings) {
    const production = sibling.id === source.id
      ? sourceProduction
      : normalizeShotProduction({ ...sibling.production, segment: { ...sibling.production.segment, count } });
    p.db.run('UPDATE shots SET production_json = ?, updated_at = ? WHERE id = ?', [j(production), new Date().toISOString(), sibling.id]);
  }
  const insertionOrder = Math.max(source.order, ...siblings.map((sibling) => sibling.order)) + 1;
  p.db.run('UPDATE shots SET ord = ord + 1, updated_at = ? WHERE story_id = ? AND ord >= ?', [new Date().toISOString(), source.episodeId, insertionOrder]);
  const segment = createShot(p, {
    title: `${source.title.replace(/ · Part \d+$/, '')} · Part ${count}`,
    sequenceId: source.sequenceId,
    storyBeatId: source.storyBeatId,
    purpose: source.purpose,
    shotFunction: source.shotFunction,
    durationSeconds: input.durationSeconds ?? source.durationSeconds,
    aspectRatio: source.aspectRatio,
    h3Mode: source.h3Mode,
    primaryCharacterId: source.primaryCharacterId,
    sceneId: source.sceneId,
    renderDependencyMode: input.kind === 'continuous' ? 'previous_take' : 'independent',
    dependsOnShotId: input.kind === 'continuous' ? source.id : null,
    screenDirection: source.screenDirection,
    intentionalReversal: source.intentionalReversal,
    order: insertionOrder,
  });
  const production = normalizeShotProduction({
    ...sourceProduction,
    segment: {
      ...sourceProduction.segment,
      kind: input.kind,
      index: count,
      count,
      timeJumpSeconds: input.timeJumpSeconds ?? 0,
      frameSkip: input.frameSkip ?? 1,
    },
  });
  p.db.run('UPDATE shots SET production_json = ? WHERE id = ?', [j(production), segment.id]);
  for (const binding of listBindings(p, source.id)) {
    createBinding(p, {
      assetId: binding.assetId,
      roles: binding.roles,
      preserve: binding.preserve,
      ignore: binding.ignore,
      label: binding.label,
      shotId: segment.id,
      targetEntityId: binding.targetEntityId,
      referenceUse: binding.referenceUse,
      framePolicy: binding.framePolicy,
      audioPolicy: binding.audioPolicy,
    });
  }
  const prompt = listPrompts(p, source.id).filter((item) => item.stage === 'final').at(-1);
  if (prompt) {
    const segmentDirective = productionPromptDirectives(production, listBindings(p, segment.id))
      .split(/\r?\n/).find((line) => line.startsWith('locked_camera_segment:')) ?? '';
    const withoutOldDirective = prompt.text.replace(/^locked_camera_segment:.*$(?:\n\n)?/gim, '').trim();
    const text = [withoutOldDirective, segmentDirective].filter(Boolean).join('\n\n');
    createPrompt(p, {
      shotId: segment.id,
      source: prompt.source,
      h3Mode: prompt.h3Mode,
      text,
      revisionReason: `Same locked camera segment ${count}/${count}`,
      preservedAspects: ['camera', 'references', 'wardrobe', 'scene'],
    });
  }
  return { source: getShot(p, source.id), segment: getShot(p, segment.id) };
}

export function recoveryPlanForJob(p: ProjectContext, job: RenderJob) {
  if (job.provider !== 'runninghub' || job.status !== 'FAILED' || !/(?:^|\D)805(?:\D|$)/.test(job.error ?? '')) return null;
  const shot = getShot(p, job.shotId);
  return runningHub805RecoveryPlan(
    job.requestSnapshot?.durationSeconds ?? shot.durationSeconds,
    job.requestSnapshot?.megapixels ?? null,
    shot.production.segment.groupId,
  );
}

export async function prepareReferenceImage(
  p: ProjectContext,
  ffmpeg: Ffmpeg,
  bindingId: string,
  policy: 'crop' | 'outpaint',
) {
  const binding = listBindings(p).find((item) => item.id === bindingId);
  if (!binding?.shotId) throw new Error('只有 Shot 参考图可以生成画幅派生素材');
  const shot = getShot(p, binding.shotId);
  const source = getMedia(p, binding.assetId);
  if (source.kind !== 'image') throw new Error('画幅派生只支持图片素材');
  const [ratioWidth = 0, ratioHeight = 0] = shot.aspectRatio.split(':').map(Number);
  if (!(ratioWidth > 0 && ratioHeight > 0)) throw new Error('Shot 画幅无效');
  const height = 960;
  const width = Math.round((height * ratioWidth / ratioHeight) / 2) * 2;
  const baseLabel = (source.label || binding.label).replace(/(?: · (?:居中裁切|模糊扩图) \d+:\d+)+$/u, '');
  const derivedLabel = `${baseLabel} · ${policy === 'crop' ? '居中裁切' : '模糊扩图'} ${shot.aspectRatio}`;
  if (binding.framePolicy === policy && source.width === width && source.height === height) {
    if (source.label !== derivedLabel) p.db.run('UPDATE media_assets SET label = ? WHERE id = ?', [derivedLabel, source.id]);
    return binding;
  }
  const derivedId = nextId(p.db, 'media');
  const outputPath = join(p.paths.assets, 'derived', `${binding.id}-${derivedId}-${policy}-${width}x${height}.png`);
  await mkdir(dirname(outputPath), { recursive: true });
  const inputPath = p.resolveProjectPath(source.fileName);
  if (policy === 'crop') {
    await ffmpeg.runRaw(['-y', '-i', inputPath, '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`, '-frames:v', '1', outputPath]);
  } else {
    const filter = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=30[bg];[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2`;
    await ffmpeg.runRaw(['-y', '-i', inputPath, '-filter_complex', filter, '-frames:v', '1', outputPath]);
  }
  const file = await stat(outputPath);
  const asset = insertMedia(p, {
    id: derivedId,
    kind: 'image',
    fileName: relative(p.root, outputPath).split(sep).join('/'),
    mimeType: 'image/png',
    sizeBytes: file.size,
    width,
    height,
    source: 'other',
    label: derivedLabel,
    tags: ['derived', policy, `source:${source.id}`],
  });
  // The derived image is a shot-local override. Detach it from the managed
  // entity binding; otherwise ensureShotEntityImageBindings() would delete it
  // on the next preflight and restore the original unfitted image.
  p.db.run(
    'UPDATE reference_bindings SET asset_id = ?, frame_policy = ?, source_entity_id = NULL, label = ? WHERE id = ?',
    [asset.id, policy, derivedLabel, binding.id],
  );
  return listBindings(p, binding.shotId).find((item) => item.id === binding.id)!;
}
