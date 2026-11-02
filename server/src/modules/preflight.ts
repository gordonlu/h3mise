// Preflight — PRD §24. Basic checks run locally with zero AI; semantic checks
// are an optional AI extension point. Never blocks on AI; risk + blocked flag
// from basic checks only.
//
// P0-2: preflight is a RENDER GATE. It runs against the exact normalized
// render intent (the same values that go into RenderRequest), not against
// shot defaults the client could later override. The report is bound to the
// submission via renderIntentHash.

import { createHash } from 'node:crypto';
import { cameraPlanWarnings, normalizeCameraPlan, SHOT_STATUS_LABEL, type H3Mode, type PreflightCheck, type PreflightReport, type PreflightSection, type ProviderCapabilities } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { j, jget } from '../db/sqlite.js';
import { nextId } from '../db/ids.js';
import { getShot, advanceShotStatus, advanceTo, renderReadiness } from './shots.js';
import type { Shot } from '@h3mise/shared';
import { lintPrompt } from './prompt-lint.js';
import { getAudioLineSilences, shotAudioLineContext } from './audio-lines.js';

export interface ReferenceCountViolation {
  key: string;
  message: string;
}

/** Single source of truth for provider reference-slot count limits. Shared by
 * the render preflight and the Studio Canvas connection dispatcher so the two
 * never drift apart. */
export function referenceCountViolations(
  mode: H3Mode,
  references: Array<{ kind: 'image' | 'video' | 'audio' }>,
  caps: ProviderCapabilities | null,
): ReferenceCountViolation[] {
  const out: ReferenceCountViolation[] = [];
  const nImage = references.filter((reference) => reference.kind === 'image').length;
  const nVideo = references.filter((reference) => reference.kind === 'video').length;
  const nAudio = references.filter((reference) => reference.kind === 'audio').length;
  if (mode === 'vref2va') {
    if (nVideo !== 1) out.push({ key: 'ref.video.required', message: '视频参考模式必须绑定一个参考视频' });
    if (caps && nImage > Math.min(3, caps.maxImageRefs ?? 3)) {
      out.push({ key: 'ref.image.limit', message: '参考图片超过视频工作流可用槽位（最多三张，图片可不提供）' });
    }
  }
  if (mode === 'faceswap') {
    if (nVideo !== 1) out.push({ key: 'ref.video.required', message: '换脸模式必须绑定恰好一个源视频' });
    if (nImage !== 1) out.push({ key: 'ref.image.required', message: '换脸模式必须绑定恰好一张人脸图片' });
    if (nAudio > 0) out.push({ key: 'ref.audio.unsupported', message: '换脸模式不接受参考音频，成片保留源视频音频' });
  }
  if (mode === 'ref2va') {
    if (nImage === 0) out.push({ key: 'ref.image.required', message: 'Ref2VA 至少需要一张参考图' });
    if (nVideo > 0 && caps && caps.maxVideoRefs === 0) {
      out.push({ key: 'ref.video.unsupported', message: '当前 Ref2VA 工作流不支持视频参考素材' });
    }
    if (caps?.maxImageRefs != null && nImage > caps.maxImageRefs) {
      out.push({ key: 'ref.count.image', message: `${nImage} 张参考图超过生成服务上限 ${caps.maxImageRefs} 张` });
    }
    if (caps?.maxVideoRefs != null && nVideo > caps.maxVideoRefs) {
      out.push({ key: 'ref.count.video', message: `${nVideo} 个视频参考超过生成服务上限 ${caps.maxVideoRefs} 个` });
    }
    if (caps?.maxAudioRefs != null && nAudio > caps.maxAudioRefs) {
      out.push({ key: 'ref.count.audio', message: `${nAudio} 个参考音频超过生成服务上限 ${caps.maxAudioRefs} 个` });
    }
  }
  return out;
}

/** Previous shot by editorial order (same sequence when the shot has one). */
function previousShot(p: ProjectContext, shot: Shot): Shot | null {
  const row = shot.sequenceId === null
    ? p.db.get<{ id: string; screen_direction: string; title: string }>('SELECT * FROM shots WHERE story_id = ? AND sequence_id IS NULL AND ord < ? ORDER BY ord DESC LIMIT 1', [shot.episodeId, shot.order])
    : p.db.get<{ id: string; screen_direction: string; title: string }>('SELECT * FROM shots WHERE story_id = ? AND sequence_id = ? AND ord < ? ORDER BY ord DESC LIMIT 1', [shot.episodeId, shot.sequenceId, shot.order]);
  if (!row) return null;
  return { ...getShot(p, row.id), screenDirection: (row.screen_direction as Shot['screenDirection']) ?? 'neutral' };
}
import { getPrompt } from './prompt.js';
import { ensureShotEntityImageBindings, getMedia } from './assets.js';
import { pathReadable } from '../ffmpeg.js';
import type { ProviderRegistry } from '../providers/registry.js';

/** The exact, normalized thing a render will do — preflight and submission
 * must share this one object so the paid gate cannot be bypassed. */
export interface RenderIntent {
  shotId: string;
  promptVersionId: string;
  providerId: string;
  mode: H3Mode;
  durationSeconds: number;
  aspectRatio: string;
  resolution?: string;
  megapixels?: number;
  references: Array<{ bindingId: string; assetId: string; kind: 'image' | 'video' | 'audio' }>;
  providerParams: Record<string, unknown>;
}

/** Deterministic fingerprint of a render intent + the provider profile it was
 * validated against. The queue only submits requests whose hash matches the
 * passed preflight report's hash. */
export function renderIntentHash(intent: RenderIntent, profileRef: { appId: string; checkedAt: string | null }): string {
  const canonical = {
    shotId: intent.shotId,
    promptVersionId: intent.promptVersionId,
    providerId: intent.providerId,
    mode: intent.mode,
    durationSeconds: intent.durationSeconds,
    aspectRatio: intent.aspectRatio,
    resolution: intent.resolution ?? null,
    megapixels: intent.megapixels ?? null,
    references: [...intent.references].sort((a, b) => a.bindingId.localeCompare(b.bindingId)),
    providerParams: Object.keys(intent.providerParams)
      .sort()
      .map((k) => [k, intent.providerParams[k]]),
    profileAppId: profileRef.appId,
    profileCheckedAt: profileRef.checkedAt,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 16);
}

export interface BasicPreflightInput {
  shotId: string;
  promptVersionId: string;
  providerId: string;
  megapixels?: number;
  durationSeconds?: number;
  aspectRatio?: string;
  resolution?: string;
  providerParams?: Record<string, unknown>;
}

export async function runBasicPreflight(p: ProjectContext, registry: ProviderRegistry, input: BasicPreflightInput): Promise<PreflightReport> {
  return runBasicPreflightIntent(p, registry, await intentFromInput(p, registry, input));
}

/** Build the canonical render intent for a shot (client overrides optional). */
export async function intentFromInput(
  p: ProjectContext,
  registry: ProviderRegistry,
  input: BasicPreflightInput & Partial<Pick<RenderIntent, 'mode' | 'durationSeconds' | 'aspectRatio' | 'resolution' | 'megapixels' | 'providerParams'>>,
): Promise<RenderIntent> {
  const shot = getShot(p, input.shotId);
  const prompt = getPrompt(p, input.promptVersionId);
  const mode = input.mode ?? prompt.h3Mode ?? 't2va';
  ensureShotEntityImageBindings(p, shot, mode);
  const referenceRows = p.db
    .all<{ id: string; asset_id: string; type: string; roles_json: string | null }>('SELECT * FROM reference_bindings WHERE shot_id = ? ORDER BY created_at, id', [input.shotId])
    .filter((row) => {
      const roles = jget<string[]>(row.roles_json ?? '[]', []);
      const first = roles.includes('first_frame');
      const last = roles.includes('last_frame');
      // Ref2VA consumes EVERY image/audio binding: first/last-frame
      // designations ride along as numbered references and are pinned to the
      // timeline via prompt declarations. Filtering them here desyncs the
      // submitted media from the compiled prompt's <Picture N> tags.
      if (mode === 'vref2va' || mode === 'faceswap') return row.type === 'image' || row.type === 'video';
      if (mode === 'ref2va') return row.type === 'image' || row.type === 'audio';
      if (mode === 'i2va') return first;
      if (mode === 'l2va') return last;
      if (mode === 'fl2va') return first || last;
      return false;
    });
  return {
    shotId: input.shotId,
    promptVersionId: input.promptVersionId,
    providerId: input.providerId,
    mode,
    durationSeconds: input.durationSeconds ?? shot.durationSeconds,
    aspectRatio: input.aspectRatio ?? shot.aspectRatio,
    resolution: input.resolution,
    megapixels: input.megapixels,
    references: referenceRows.map((r) => ({ bindingId: r.id, assetId: r.asset_id, kind: r.type as 'image' | 'video' | 'audio' })),
    providerParams: input.providerParams ?? {},
  };
}

export async function runBasicPreflightIntent(p: ProjectContext, registry: ProviderRegistry, intent: RenderIntent): Promise<PreflightReport> {
  const shot = getShot(p, intent.shotId);
  const prompt = getPrompt(p, intent.promptVersionId);
  const sections: { key: string; label: string; checks: PreflightCheck[] }[] = [
    { key: 'prompt', label: '提示词', checks: [] },
    { key: 'duration', label: '时长', checks: [] },
    { key: 'provider', label: '生成服务', checks: [] },
    { key: 'references', label: '参考素材', checks: [] },
    { key: 'integrity', label: '数据一致性', checks: [] },
    { key: 'credential', label: '访问凭证', checks: [] },
    { key: 'duplicate', label: '重复任务', checks: [] },
    { key: 'continuity', label: '方向连续性', checks: [] },
    { key: 'prompt_lint', label: '提示词 Lint', checks: [] },
    { key: 'audio_line', label: 'Audio Line', checks: [] },
  ];

  // Prompt
  if (prompt.text.trim() === '') {
    sections[0]!.checks.push({ key: 'prompt.empty', severity: 'error', message: '提示词为空' });
  } else {
    sections[0]!.checks.push({ key: 'prompt.ok', severity: 'info', message: `提示词有效（${prompt.h3Mode}，${prompt.text.length} 字符）` });
    // MiniMax H3 hard limit: prompts must not exceed 7000 characters.
    if (prompt.text.length > 7000) {
      sections[0]!.checks.push({
        key: 'prompt.too_long',
        severity: 'error',
        message: `提示词 ${prompt.text.length} 字符，超过 MiniMax H3 上限 7000 字符，请精简后再生成`,
      });
    } else if (prompt.text.length > 6300) {
      sections[0]!.checks.push({
        key: 'prompt.near_limit',
        severity: 'warning',
        message: `提示词 ${prompt.text.length} 字符，已接近 MiniMax H3 上限 7000 字符`,
      });
    }
    // A structurally non-empty compiler result can still contain no story
    // content (the old fallback was only "Reality: strict realism"). Refuse
    // paid submission unless the immutable prompt contains this Shot's
    // canonical title or purpose.
    if (prompt.source === 'deterministic_compiler') {
      const narrativeFacts = [shot.purpose.trim(), shot.title.trim()].filter(Boolean);
      if (narrativeFacts.length > 0 && !narrativeFacts.some((fact) => prompt.text.includes(fact))) {
        sections[0]!.checks.push({
          key: 'prompt.missing_narrative',
          severity: 'error',
          message: '提示词没有包含当前镜头的故事内容，请重新生成Prompt后再提交',
        });
      }
    }
    // Timeline-vs-duration consistency: a prompt whose internal timeline runs
    // past the requested duration gets its pacing silently compressed by the
    // model — warn so the timeline can be rewritten for the real length.
    const stamps = [...prompt.text.matchAll(/(\d{1,2}(?:\.\d+)?)\s*(?:s|秒)/gi)].map((m) => Number(m[1]));
    const maxStamp = stamps.length ? Math.max(...stamps) : 0;
    if (maxStamp > intent.durationSeconds + 0.5) {
      sections[0]!.checks.push({
        key: 'prompt.timeline_mismatch',
        severity: 'warning',
        message: `提示词时间轴最远到 ${maxStamp}s，超过本次生成时长 ${intent.durationSeconds}s——节奏会被模型压缩，建议按 ${intent.durationSeconds}s 重排时间轴`,
      });
    }
  }

  // Duration (checked on the INTENT, not the shot defaults — P0-2)
  const caps = await registry.capabilities(intent.providerId, intent.mode);
  if (!(intent.durationSeconds > 0)) {
    sections[1]!.checks.push({ key: 'duration.invalid', severity: 'error', message: `时长 ${intent.durationSeconds} 秒必须大于 0` });
  } else if (caps && caps.maxDuration && intent.durationSeconds > caps.maxDuration) {
    sections[1]!.checks.push({ key: 'duration.max', severity: 'error', message: `时长 ${intent.durationSeconds} 秒超过生成服务上限 ${caps.maxDuration} 秒` });
  } else if (caps && caps.minDuration && intent.durationSeconds < caps.minDuration) {
    sections[1]!.checks.push({ key: 'duration.min', severity: 'error', message: `时长 ${intent.durationSeconds} 秒低于生成服务下限 ${caps.minDuration} 秒` });
  } else {
    sections[1]!.checks.push({ key: 'duration.ok', severity: 'info', message: `时长 ${intent.durationSeconds} 秒有效` });
  }
  if (intent.durationSeconds !== shot.durationSeconds) {
    sections[1]!.checks.push({
      key: 'duration.override',
      severity: 'info',
      message: `镜头默认 ${shot.durationSeconds} 秒，本次请求 ${intent.durationSeconds} 秒`,
    });
  }

  // Provider + mode + aspect (unknown capability = blocked, P0-6)
  const provider = registry.get(intent.providerId, intent.mode);
  if (!provider) {
    sections[2]!.checks.push({ key: 'provider.missing', severity: 'error', message: `找不到生成服务“${intent.providerId}”` });
  } else {
    if (!caps || !caps.supportedModes.length) {
      sections[2]!.checks.push({
        key: 'provider.unverified',
        severity: 'error',
        message: '生成服务能力尚未验证，请先在设置中检测连接与输入映射',
      });
    } else if (!caps.supportedModes.includes(intent.mode)) {
      sections[2]!.checks.push({
        key: 'provider.mode',
        severity: 'error',
        message: `生成服务不支持 ${intent.mode.toUpperCase()} 模式`,
      });
    } else {
      sections[2]!.checks.push({ key: 'provider.mode.ok', severity: 'info', message: `生成服务支持 ${intent.mode.toUpperCase()} 模式` });
    }
    if (caps?.supportedAspectRatios?.length && !caps.supportedAspectRatios.includes(intent.aspectRatio)) {
      sections[2]!.checks.push({
        key: 'provider.aspect',
        severity: 'error',
        message: `生成服务不支持 ${intent.aspectRatio} 画幅；支持：${caps.supportedAspectRatios.join('、')}`,
      });
    }
    if (intent.megapixels !== undefined) {
      const allowedMegapixels = [0.6, 0.8, 1, 1.2];
      if (!Number.isFinite(intent.megapixels) || !allowedMegapixels.includes(intent.megapixels)) {
        sections[2]!.checks.push({
          key: 'provider.megapixels',
          severity: 'error',
          message: `像素档位 ${intent.megapixels} MP 不受支持；可选：${allowedMegapixels.join('、')} MP`,
        });
      } else {
        sections[2]!.checks.push({ key: 'provider.megapixels.ok', severity: 'info', message: `输出像素：${intent.megapixels} MP` });
      }
    }
    if (provider.configured === false) {
      sections[2]!.checks.push({ key: 'provider.not_configured', severity: 'error', message: `生成服务“${provider.name}”尚未配置或验证` });
    }
  }

  // References: required roles per mode, kind consistency, count caps
  const bindings = intent.references;
  const roleKindOk: Record<string, 'image' | 'video' | 'audio'> = {
    first_frame: 'image',
    last_frame: 'image',
    identity: 'image',
    style_ref: 'image',
    motion: 'video',
    body_motion: 'video',
    camera_motion: 'video',
    audio: 'audio',
  };
  const requiredRoles = new Set<string>();
  if (intent.mode === 'i2va') requiredRoles.add('first_frame');
  if (intent.mode === 'l2va') requiredRoles.add('last_frame');
  if (intent.mode === 'fl2va') {
    requiredRoles.add('first_frame');
    requiredRoles.add('last_frame');
  }
  const relevantIds = new Set(bindings.map((binding) => binding.bindingId));
  const bindingRows = p.db.all<{ id: string; roles_json: string | null; asset_id: string; label: string; created_at: string }>(
    `SELECT id, roles_json, asset_id, label, created_at FROM reference_bindings WHERE shot_id = ? ORDER BY created_at, id`,
    [shot.id],
  ).filter((binding) => relevantIds.has(binding.id));
  const haveRoles = new Set<string>();
  for (const b of bindingRows) {
    const roles = jget<string[]>(b.roles_json ?? '[]', []);
    for (const role of roles) {
      haveRoles.add(role);
      const kind = bindings.find((r) => r.bindingId === b.id)?.kind;
      if (kind && roleKindOk[role] && roleKindOk[role] !== kind) {
        sections[3]!.checks.push({
          key: `ref.kind.${b.id}`,
          severity: 'error',
          message: `参考素材 ${b.id} 的角色“${role}”需要 ${roleKindOk[role]} 类型，当前绑定为 ${kind}`,
        });
      }
    }
  }
  for (const role of requiredRoles) {
    if (!haveRoles.has(role)) {
      sections[3]!.checks.push({ key: `ref.${role}`, severity: 'error', message: `缺少必需的参考素材角色：${role}` });
    }
  }
  if (bindings.length > 0) {
    const names = bindingRows.map((binding) => binding.label || binding.id);
    sections[3]!.checks.push({
      key: 'ref.summary',
      severity: 'info',
      message: `将提交 ${bindings.length} 项参考素材：${names.join('、')}`,
    });
  }
  if (caps) {
    for (const violation of referenceCountViolations(intent.mode, bindings, caps)) {
      sections[3]!.checks.push({ key: violation.key, severity: 'error', message: violation.message });
    }
  }
  if (caps && intent.mode === 'faceswap') {
    const videoBinding = bindings.find((binding) => binding.kind === 'video');
    if (videoBinding) {
      try {
        const video = getMedia(p, videoBinding.assetId);
        if (caps.maxVideoSeconds != null && video.durationSeconds != null && video.durationSeconds > caps.maxVideoSeconds) {
          sections[3]!.checks.push({ key: `ref.video.duration.${videoBinding.bindingId}`, severity: 'error', message: `源视频 ${video.durationSeconds.toFixed(1)} 秒，超过工作流上限 ${caps.maxVideoSeconds} 秒` });
        }
        if (caps.maxVideoBytes != null && video.sizeBytes > caps.maxVideoBytes) {
          sections[3]!.checks.push({ key: `ref.video.size.${videoBinding.bindingId}`, severity: 'error', message: `源视频 ${(video.sizeBytes / 1024 / 1024).toFixed(1)} MB，超过工作流上限 ${(caps.maxVideoBytes / 1024 / 1024).toFixed(1)} MB` });
        }
      } catch {
        // The general asset-integrity pass below reports the missing asset.
      }
    }
    const identityImages = bindingRows.filter((row) => (jget<string[]>(row.roles_json ?? '[]', []) as string[]).includes('identity'));
    if (identityImages.length > 1) {
      sections[3]!.checks.push({ key: 'ref.faceswap.multiple_identity', severity: 'warning', message: '检测到多张身份参考图；换脸建议只使用一张正面人脸图，避免复制人或换脸失败' });
    }
    const costumeSheet = bindingRows.find((row) => /四宫格|服装|costume/i.test(row.label ?? ''));
    if (costumeSheet) {
      sections[3]!.checks.push({ key: 'ref.faceswap.costume_face', severity: 'warning', message: '检测到服装/四宫格参考；服装板不要露脸，否则容易与换脸身份冲突' });
    }
  }
  if (caps && intent.mode === 'ref2va') {
    for (const binding of bindings.filter((item) => item.kind === 'audio')) {
      try {
        const audio = getMedia(p, binding.assetId);
        if (audio.durationSeconds == null || audio.durationSeconds < 2 || audio.durationSeconds > 15) {
          sections[3]!.checks.push({ key: `ref.audio.duration.${binding.bindingId}`, severity: 'error', message: `参考音频 ${audio.label || audio.id} 必须可读取且时长在 2–15 秒之间` });
        }
      } catch {
        // The general asset-integrity pass below reports the missing asset.
      }
    }
    const totalAudioSeconds = bindings
      .filter((item) => item.kind === 'audio')
      .reduce((sum, item) => sum + (getMedia(p, item.assetId).durationSeconds ?? 0), 0);
    if (totalAudioSeconds > 15) {
      sections[3]!.checks.push({ key: 'ref.audio.duration.total', severity: 'error', message: `参考音频总时长 ${totalAudioSeconds.toFixed(1)} 秒，超过 15 秒上限` });
    }
  }
  if (caps && intent.mode === 'ref2va' && bindings.some((binding) => binding.kind === 'audio')) {
    const reuse = caps.audioReuse ?? 'unknown';
    // Workflow capability is the only source of truth. Prompt wording such as
    // "audio reuse", "fully_copy", "原唱" or even "1:1" must never decide
    // whether a paid render is allowed.
    if (reuse === 'copy') {
      sections[3]!.checks.push({ key: 'ref.audio.reuse.copy', severity: 'info', message: '该工作流声明支持 audio reuse：参考音频可作为原音轨复用' });
    } else if (reuse === 'resings') {
      sections[3]!.checks.push({ key: 'ref.audio.reuse.resings', severity: 'warning', message: '该工作流的参考音频会驱动重新演唱，不是原唱复用' });
    } else if (reuse === 'reference_only') {
      sections[3]!.checks.push({ key: 'ref.audio.reuse.reference', severity: 'warning', message: '参考音频仅作为音色/节奏参考，不是原唱复用' });
    } else {
      sections[3]!.checks.push({ key: 'ref.audio.reuse.unknown', severity: 'info', message: '该工作流未声明音频复用能力；若 App 官方支持 audio reuse，请在 workflow capabilities 中设置 audioReuse: "copy"' });
    }
  }
  for (const b of bindingRows) {
    try {
      const asset = getMedia(p, b.asset_id);
      const abs = p.resolveProjectPath(asset.fileName);
      if (!(await pathReadable(abs))) {
        sections[3]!.checks.push({ key: `ref.file.${b.id}`, severity: 'error', message: `本地参考素材文件不存在：${asset.fileName}` });
      }
    } catch (e) {
      sections[3]!.checks.push({ key: `ref.asset.${b.id}`, severity: 'error', message: `参考素材无效：${e instanceof Error ? e.message : e}` });
    }
  }
  if (sections[3]!.checks.length === 0) {
    sections[3]!.checks.push({ key: 'ref.ok', severity: 'info', message: bindings.length ? `已准备 ${bindings.length} 项参考素材` : '当前模式无需参考素材' });
  }

  // Integrity: prompt must belong to this shot; DP version must exist
  if (prompt.shotId !== intent.shotId) {
    sections[4]!.checks.push({
      key: 'integrity.prompt_shot',
      severity: 'error',
      message: `提示词 ${intent.promptVersionId} 属于镜头 ${prompt.shotId}，不属于当前镜头 ${intent.shotId}`,
    });
  }
  if (prompt.directorPlanVersionId) {
    const dpv = p.db.get<{ id: string }>('SELECT id FROM director_plan_versions WHERE id = ?', [prompt.directorPlanVersionId]);
    if (!dpv) sections[4]!.checks.push({ key: 'integrity.dpv', severity: 'error', message: '关联的导演计划版本不存在' });
  }
  if (prompt.source === 'deterministic_compiler') {
    const newerBinding = bindingRows.some((binding) => binding.created_at > prompt.createdAt);
    if (newerBinding) {
      sections[4]!.checks.push({
        key: 'integrity.prompt_references',
        severity: 'error',
        message: '参考素材在提示词生成后发生了变化，请重新从镜头设计生成提示词后再提交',
      });
    }
    // CLOSED LOOP GUARD: a deterministic prompt is a snapshot of the plan,
    // the camera plan, and the screen-direction constraint. If any of them
    // changed after the prompt was compiled, the user's design would silently
    // not reach the generator — fail loudly and ask for a recompile.
    const latestDp = p.db.get<{ id: string }>(
      'SELECT id FROM director_plan_versions WHERE shot_id = ? ORDER BY version DESC LIMIT 1',
      [shot.id],
    );
    const planChanged = latestDp && prompt.directorPlanVersionId !== latestDp.id;
    const cam = p.db.get<{ updated_at: string }>('SELECT updated_at FROM camera_plans WHERE shot_id = ?', [shot.id]);
    const cameraChanged = cam ? cam.updated_at > prompt.createdAt : false;
    const dir = shot.screenDirection ?? 'neutral';
    const expectedPhrase = dir === 'left_to_right' ? 'left to right' : dir === 'right_to_left' ? 'right to left' : null;
    const dirLine = prompt.text.match(/^Screen direction: subjects move from (.+?);/m);
    const directionChanged = expectedPhrase
      ? (!dirLine || dirLine[1] !== expectedPhrase)
      : Boolean(dirLine);
    const staleReasons: string[] = [];
    if (planChanged) staleReasons.push('导演计划已更新');
    if (cameraChanged) staleReasons.push('相机计划已更新');
    if (directionChanged) staleReasons.push('方向约束已变化');
    if (staleReasons.length) {
      sections[4]!.checks.push({
        key: 'integrity.prompt_stale',
        severity: 'error',
        message: `${staleReasons.join('、')}，提示词未反映最新设计——请重新从镜头设计生成提示词后再提交`,
      });
    }
  }
  sections[4]!.checks.push({ key: 'integrity.shot', severity: 'info', message: `镜头 ${shot.id} / ${SHOT_STATUS_LABEL[shot.status]}` });
  const dependency = renderReadiness(p, shot);
  sections[4]!.checks.push({
    key: 'integrity.render_dependency',
    severity: dependency.ready ? 'info' : 'error',
    message: dependency.reason,
  });

  // Credential
  if (provider?.configured === false) {
    sections[5]!.checks.push({ key: 'credential.key', severity: 'error', message: `生成服务“${provider.name}”尚未配置或验证，请先在设置中完成连接和字段映射` });
  } else {
    sections[5]!.checks.push({ key: 'credential.ok', severity: 'info', message: `生成服务“${provider?.name ?? intent.providerId}”配置可用` });
  }

  // Duplicate: one running task plus at most one queued revision is allowed.
  // An active job is a queue state, not a prompt defect — it must not make the
  // prompt risk HIGH or block a revision from being queued.
  const jobs = p.db.all<{ id: string; status: string }>(
    "SELECT id, status FROM render_jobs WHERE shot_id = ? AND status IN ('LOCAL_QUEUED','UPLOADING','SUBMITTING','QUEUED','RUNNING','DOWNLOADING') ORDER BY created_at",
    [shot.id],
  );
  const running = jobs.filter((job) => job.status !== 'LOCAL_QUEUED');
  const queued = jobs.filter((job) => job.status === 'LOCAL_QUEUED');
  if (running.length && queued.length) {
    sections[6]!.checks.push({ key: 'duplicate.revision', severity: 'error', message: `当前镜头已有进行中任务（${running[0]!.id}）和排队修订（${queued[0]!.id}）；请等待或取消一个任务` });
  } else if (running.length) {
    sections[6]!.checks.push({ key: 'duplicate.active', severity: 'warning', message: `当前镜头已有进行中任务（${running[0]!.id}）；本次提交会排队，待前一个任务结束后自动开始` });
  } else if (queued.length) {
    sections[6]!.checks.push({ key: 'duplicate.queued', severity: 'warning', message: `当前镜头已有排队任务（${queued[0]!.id}）；请等待它开始或先取消` });
  } else {
    sections[6]!.checks.push({ key: 'duplicate.ok', severity: 'info', message: '没有重复的生成任务' });
  }

  // Screen direction: warning-only reversal next to the previous shot.
  // A deliberate cut on the 180° line is expressed via intentionalReversal.
  const curDir = shot.screenDirection ?? 'neutral';
  const prev = previousShot(p, shot);
  const prevDir = prev?.screenDirection ?? 'neutral';
  if (curDir !== 'neutral' && prevDir !== 'neutral' && prevDir !== curDir) {
    if (shot.intentionalReversal) {
      sections[7]!.checks.push({
        key: 'continuity.screen_direction.intentional',
        severity: 'info',
        message: `与上一镜头（${prev?.title ?? prev?.id}）方向相反，已标记为刻意反转`,
      });
    } else {
      sections[7]!.checks.push({
        key: 'continuity.screen_direction.reversal',
        severity: 'warning',
        message: `与上一镜头（${prev?.title ?? prev?.id}）方向相反（${prevDir} → ${curDir}）。若是 180° 法则的刻意改编请标记“刻意反转”，否则建议保持一致`,
      });
    }
  } else if (curDir !== 'neutral') {
    const message = prevDir === curDir
      ? `与上一镜头方向一致（${curDir}）`
      : `镜头方向设置为 ${curDir}（上一镜头方向为 ${prevDir === 'neutral' ? '中性/未设置' : prevDir}）`;
    sections[7]!.checks.push({ key: prevDir === curDir ? 'continuity.screen_direction.ok' : 'continuity.screen_direction.set', severity: 'info', message });
  } else {
    sections[7]!.checks.push({ key: 'continuity.screen_direction.none', severity: 'info', message: '未设置镜头方向约束' });
  }

  // Camera plan out-of-safe-area noise surfaces here as a warning so the
  // render gate is aware of a clamped motion plan (never blocks; UI also warns).
  {
    const camPlan = p.db.get<{ plan_json: string }>('SELECT plan_json FROM camera_plans WHERE shot_id = ?', [shot.id]);
    if (camPlan) {
      const warnings = cameraPlanWarnings(normalizeCameraPlan(jget<unknown>(camPlan.plan_json, null)));
      if (warnings.length) {
        sections[7]!.checks.push({
          key: 'continuity.camera_plan.bounds',
          severity: 'warning',
          message: `相机计划：${[...new Set(warnings.map((w) => w.message))].join('；')}`,
        });
      }
    }
  }

  {
    const hasAudioRefs = bindings.some((binding) => binding.kind === 'audio');
    const issues = lintPrompt(prompt.text, {
      mode: intent.mode,
      hasAudioRefs,
      hasDialogue: /["“”」』]|唱|说|歌词|lyrics|dialogue/i.test(prompt.text),
    });
    for (const issue of issues) {
      sections[8]!.checks.push({
        key: issue.key,
        severity: issue.severity,
        message: issue.suggestion ? `${issue.message}——建议：${issue.suggestion}` : issue.message,
      });
    }
    if (!issues.length) sections[8]!.checks.push({ key: 'prompt_lint.ok', severity: 'info', message: '未发现常见否定词、缺失字段或半句问题' });
  }

  {
    const audioLine = shotAudioLineContext(p, shot.id);
    if (!audioLine) {
      sections[9]!.checks.push({ key: 'audio_line.none', severity: 'info', message: '当前镜头没有绑定 Audio Line 切片' });
    } else {
      try {
        getMedia(p, audioLine.line.assetId);
      } catch {
        sections[9]!.checks.push({ key: 'audio_line.asset', severity: 'error', message: 'Audio Line 引用的音频素材不存在' });
      }
      const normalize = (value: string) => value.replace(/[\s，。！？、,.!?;；:：'"“”‘’()（）<>\-]/g, '');
      const dialogueTags = [...prompt.text.matchAll(/<d(?:\s[^>]*)?>([\s\S]*?)<\/d>/gi)]
        .map((match) => match[1]!.trim())
        .filter(Boolean);
      const silences = getAudioLineSilences(p, audioLine.line.id);
      const inSilence = (time: number) => silences.some((silence) => time >= silence.start - 0.15 && time <= silence.end + 0.15);
      for (const segment of audioLine.segments) {
        if (!segment.text.trim()) {
          sections[9]!.checks.push({ key: `audio_line.text.${segment.id}`, severity: 'error', message: `第 ${segment.order} 句缺少实际歌词/台词文本` });
        } else if (!prompt.text.includes(segment.text.trim())) {
          sections[9]!.checks.push({ key: `audio_line.prompt.${segment.id}`, severity: 'error', message: `提示词没有包含第 ${segment.order} 句的完整文本：“${segment.text.trim()}”` });
        }
        if (segment.endSeconds - segment.startSeconds > shot.durationSeconds + 0.05) {
          sections[9]!.checks.push({ key: `audio_line.duration.${segment.id}`, severity: 'warning', message: `第 ${segment.order} 句 ${(segment.endSeconds - segment.startSeconds).toFixed(1)}s 超过镜头 ${shot.durationSeconds}s，可能被压缩或截断` });
        }
        if (silences.length) {
          if (segment.startSeconds > 0.2 && !inSilence(segment.startSeconds)) {
            sections[9]!.checks.push({ key: `audio_line.breath.start.${segment.id}`, severity: 'warning', message: `第 ${segment.order} 句开头不在检测到的静音/气口内，可能切在半句` });
          }
          const lineEnd = Math.max(...audioLine.segments.map((item) => item.endSeconds));
          if (segment.endSeconds < lineEnd - 0.1 && !inSilence(segment.endSeconds)) {
            sections[9]!.checks.push({ key: `audio_line.breath.end.${segment.id}`, severity: 'warning', message: `第 ${segment.order} 句结尾不在检测到的静音/气口内，可能切在半句` });
          }
        }
      }
      for (let index = 1; index < audioLine.segments.length; index += 1) {
        const previous = audioLine.segments[index - 1]!;
        const current = audioLine.segments[index]!;
        if (current.startSeconds < previous.endSeconds - 0.01) {
          sections[9]!.checks.push({ key: `audio_line.overlap.${current.id}`, severity: 'error', message: `第 ${previous.order} 句与第 ${current.order} 句时间重叠` });
        }
      }
      if (dialogueTags.length) {
        for (const tag of dialogueTags) {
          if (!audioLine.segments.some((segment) => normalize(tag).includes(normalize(segment.text)))) {
            sections[9]!.checks.push({ key: 'audio_line.dialogue.extra', severity: 'error', message: `<d> 中出现了未绑定到 Audio Line 的文本：“${tag.slice(0, 60)}”` });
          }
        }
        for (const segment of audioLine.segments) {
          if (!dialogueTags.some((tag) => normalize(tag).includes(normalize(segment.text)))) {
            sections[9]!.checks.push({ key: `audio_line.dialogue.${segment.id}`, severity: 'error', message: `<d> 标记没有包含第 ${segment.order} 句的完整文本` });
          }
        }
      }
      if (sections[9]!.checks.every((check) => check.severity === 'info')) {
        sections[9]!.checks.push({ key: 'audio_line.ok', severity: 'info', message: `已绑定 ${audioLine.segments.length} 句，提示词包含全部实际文本` });
      }
    }
  }

  const report = finalizePreflight(p, sections, intent.shotId, intent.promptVersionId, intent.providerId, null, false);
  return report;
}

export function finalizePreflight(
  p: ProjectContext,
  sections: Array<{ key: string; label: string; checks: PreflightCheck[] }>,
  shotId: string,
  promptVersionId: string | null,
  providerId: string | null,
  semantic: PreflightSection[] | null,
  aiSemanticRun: boolean,
): PreflightReport {
  const statusFor = (s: { key: string; label: string; checks: PreflightCheck[] }): PreflightSection['status'] => {
    if (s.checks.some((c) => c.severity === 'error')) return 'fail';
    if (s.checks.some((c) => c.severity === 'warning')) return 'warn';
    return 'ok';
  };
  const normalized: PreflightSection[] = sections.map((s) => ({ ...s, status: statusFor(s) }));
  const errors = normalized.flatMap((s) => s.checks).filter((c) => c.severity === 'error');
  const warnings = normalized.flatMap((s) => s.checks).filter((c) => c.severity === 'warning');
  const risk: PreflightReport['risk'] = errors.length > 0 ? 'HIGH' : warnings.length > 2 ? 'MEDIUM' : warnings.length > 0 ? 'MEDIUM' : 'LOW';
  const blocked = errors.length > 0;
  const id = nextId(p.db, 'preflight');
  const now = new Date().toISOString();
  p.db.run(
    'INSERT INTO preflight_reports (id, shot_id, prompt_version_id, provider_id, basic_json, semantic_json, risk, blocked, ai_semantic_run, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, shotId, promptVersionId, providerId, j(normalized), semantic ? j(semantic) : null, risk, blocked ? 1 : 0, aiSemanticRun ? 1 : 0, now],
  );
  const shot = getShot(p, shotId);
  if (!blocked) {
    advanceTo(p, shotId, 'PREFLIGHT_READY');
  }
  return {
    id,
    shotId,
    promptVersionId,
    providerId,
    basic: normalized,
    semantic,
    risk,
    blocked,
    aiSemanticRun,
    createdAt: now,
  };
}

export function listPreflightReports(p: ProjectContext, shotId: string): PreflightReport[] {
  return p.db
    .all<{ id: string; shot_id: string; prompt_version_id: string | null; provider_id: string | null; basic_json: string; semantic_json: string | null; risk: string; blocked: number; ai_semantic_run: number; created_at: string }>(
      'SELECT * FROM preflight_reports WHERE shot_id = ? ORDER BY created_at DESC',
      [shotId],
    )
    .map((r) => ({
      id: r.id,
      shotId: r.shot_id,
      promptVersionId: r.prompt_version_id,
      providerId: r.provider_id,
      basic: jget<PreflightSection[]>(r.basic_json, []),
      semantic: r.semantic_json ? jget<PreflightSection[]>(r.semantic_json, []) : null,
      risk: r.risk as PreflightReport['risk'],
      blocked: Boolean(r.blocked),
      aiSemanticRun: Boolean(r.ai_semantic_run),
      createdAt: r.created_at,
    }));
}

export function attachSemanticReview(p: ProjectContext, reportId: string, text: string): PreflightReport {
  const row = p.db.get<{ shot_id: string }>('SELECT shot_id FROM preflight_reports WHERE id = ?', [reportId]);
  if (!row) throw new Error('生成检查记录不存在');
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const hasMismatch = lines.some((line) =>
    (/^MISMATCH:/i.test(line) && !/^MISMATCH:\s*(None|N\/A)/i.test(line))
    || (/^不一致[：:]/.test(line) && !/^不一致[：:]\s*(无|没有)/.test(line)),
  );
  const semantic: PreflightSection[] = [{
    key: 'ai.continuity',
    label: 'AI 连续性',
    status: hasMismatch ? 'warn' : 'ok',
    checks: [{
      key: 'ai.continuity.result',
      severity: hasMismatch ? 'warning' : 'info',
      message: text.trim() || 'AI 未返回连续性检查内容',
    }],
  }];
  p.db.run('UPDATE preflight_reports SET semantic_json = ?, ai_semantic_run = 1 WHERE id = ?', [j(semantic), reportId]);
  const updated = listPreflightReports(p, row.shot_id).find((report) => report.id === reportId);
  if (!updated) throw new Error('生成检查记录更新失败');
  return updated;
}

export function latestPreflight(p: ProjectContext, shotId: string): PreflightReport | null {
  return listPreflightReports(p, shotId)[0] ?? null;
}
