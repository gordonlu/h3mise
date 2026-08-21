// Preflight — PRD §24. Basic checks run locally with zero AI; semantic checks
// are an optional AI extension point. Never blocks on AI; risk + blocked flag
// from basic checks only.
//
// P0-2: preflight is a RENDER GATE. It runs against the exact normalized
// render intent (the same values that go into RenderRequest), not against
// shot defaults the client could later override. The report is bound to the
// submission via renderIntentHash.

import { createHash } from 'node:crypto';
import { SHOT_STATUS_LABEL, type H3Mode, type PreflightCheck, type PreflightReport, type PreflightSection } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { j, jget } from '../db/sqlite.js';
import { nextId } from '../db/ids.js';
import { getShot, advanceShotStatus, advanceTo } from './shots.js';
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
}

export async function runBasicPreflight(p: ProjectContext, registry: ProviderRegistry, input: BasicPreflightInput): Promise<PreflightReport> {
  return runBasicPreflightIntent(p, registry, await intentFromInput(p, registry, input));
}

/** Build the canonical render intent for a shot (client overrides optional). */
export async function intentFromInput(
  p: ProjectContext,
  registry: ProviderRegistry,
  input: BasicPreflightInput & Partial<Pick<RenderIntent, 'mode' | 'durationSeconds' | 'aspectRatio' | 'resolution' | 'providerParams'>>,
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
      if (mode === 'ref2va') return !first && !last;
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
  ];

  // Prompt
  if (prompt.text.trim() === '') {
    sections[0]!.checks.push({ key: 'prompt.empty', severity: 'error', message: '提示词为空' });
  } else {
    sections[0]!.checks.push({ key: 'prompt.ok', severity: 'info', message: `提示词有效（${prompt.h3Mode}，${prompt.text.length} 字符）` });
  }

  // Duration (checked on the INTENT, not the shot defaults — P0-2)
  const caps = await registry.capabilities(intent.providerId);
  if (!(intent.durationSeconds > 0)) {
    sections[1]!.checks.push({ key: 'duration.invalid', severity: 'error', message: `时长 ${intent.durationSeconds} 秒必须大于 0` });
  } else if (caps && caps.maxDuration && intent.durationSeconds > caps.maxDuration) {
    sections[1]!.checks.push({ key: 'duration.max', severity: 'error', message: `时长 ${intent.durationSeconds} 秒超过生成服务上限 ${caps.maxDuration} 秒` });
  } else if (caps && caps.minDuration && intent.durationSeconds < caps.minDuration) {
    sections[1]!.checks.push({ key: 'duration.min', severity: 'error', message: `时长 ${intent.durationSeconds} 秒低于生成服务下限 ${caps.minDuration} 秒` });
  } else {
    sections[1]!.checks.push({ key: 'duration.ok', severity: 'info', message: `时长 ${intent.durationSeconds} 秒有效` });
  }

  // Provider + mode + aspect (unknown capability = blocked, P0-6)
  const provider = registry.get(intent.providerId);
  if (!provider) {
    sections[2]!.checks.push({ key: 'provider.missing', severity: 'error', message: `找不到生成服务“${intent.providerId}”` });
  } else {
    if (!caps || !caps.supportedModes.length) {
      sections[2]!.checks.push({
        key: 'provider.unverified',
        severity: 'error',
        message: '生成服务能力尚未验证，请先在设置中检测并验证 AI App',
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
    if (provider.configured === false) {
      sections[2]!.checks.push({ key: 'provider.not_configured', severity: 'error', message: '尚未配置 RunningHub API Key' });
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
    if (intent.mode === 'ref2va') {
      const nImage = bindings.filter((r) => r.kind === 'image').length;
      const nVideo = bindings.filter((r) => r.kind === 'video').length;
      const nAudio = bindings.filter((r) => r.kind === 'audio').length;
      if (nImage === 0) {
        sections[3]!.checks.push({ key: 'ref.image.required', severity: 'error', message: 'Ref2VA 至少需要一张参考图' });
      }
      if (nVideo > 0) {
        sections[3]!.checks.push({ key: 'ref.video.unsupported', severity: 'error', message: '当前 Ref2VA 工作流不支持视频参考素材' });
      }
      if (caps.maxImageRefs != null && nImage > caps.maxImageRefs) {
        sections[3]!.checks.push({ key: 'ref.count.image', severity: 'error', message: `${nImage} 张参考图超过生成服务上限 ${caps.maxImageRefs} 张` });
      }
      if (caps.maxVideoRefs != null && nVideo > caps.maxVideoRefs) {
        sections[3]!.checks.push({ key: 'ref.count.video', severity: 'error', message: `${nVideo} 个视频参考超过生成服务上限 ${caps.maxVideoRefs} 个` });
      }
      if (caps.maxAudioRefs != null && nAudio > caps.maxAudioRefs) {
        sections[3]!.checks.push({ key: 'ref.count.audio', severity: 'error', message: `${nAudio} 个参考音频超过生成服务上限 ${caps.maxAudioRefs} 个` });
      }
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
  }
  sections[4]!.checks.push({ key: 'integrity.shot', severity: 'info', message: `镜头 ${shot.id} / ${SHOT_STATUS_LABEL[shot.status]}` });

  // Credential
  if (provider?.configured === false) {
    sections[5]!.checks.push({ key: 'credential.key', severity: 'error', message: '缺少 RunningHub API Key，请先在设置中配置' });
  } else {
    sections[5]!.checks.push({ key: 'credential.ok', severity: 'info', message: '访问凭证可用' });
  }

  // Duplicate: an active render is a hard error (PRD: no duplicate paid submit)
  const active = p.db.get<{ id: string }>(
    "SELECT id FROM render_jobs WHERE shot_id = ? AND status IN ('UPLOADING','SUBMITTING','QUEUED','RUNNING','DOWNLOADING') LIMIT 1",
    [shot.id],
  );
  if (active) {
    sections[6]!.checks.push({ key: 'duplicate.active', severity: 'error', message: `当前镜头已有进行中的生成任务（${active.id}）` });
  } else {
    sections[6]!.checks.push({ key: 'duplicate.ok', severity: 'info', message: '没有重复的生成任务' });
  }

  const report = finalizePreflight(p, sections, intent.shotId, intent.promptVersionId, null, false);
  return report;
}

export function finalizePreflight(
  p: ProjectContext,
  sections: Array<{ key: string; label: string; checks: PreflightCheck[] }>,
  shotId: string,
  promptVersionId: string | null,
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
    'INSERT INTO preflight_reports (id, shot_id, prompt_version_id, basic_json, semantic_json, risk, blocked, ai_semantic_run, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, shotId, promptVersionId, j(normalized), semantic ? j(semantic) : null, risk, blocked ? 1 : 0, aiSemanticRun ? 1 : 0, now],
  );
  const shot = getShot(p, shotId);
  if (!blocked) {
    advanceTo(p, shotId, 'PREFLIGHT_READY');
  }
  return {
    id,
    shotId,
    promptVersionId,
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
    .all<{ id: string; shot_id: string; prompt_version_id: string | null; basic_json: string; semantic_json: string | null; risk: string; blocked: number; ai_semantic_run: number; created_at: string }>(
      'SELECT * FROM preflight_reports WHERE shot_id = ? ORDER BY created_at DESC',
      [shotId],
    )
    .map((r) => ({
      id: r.id,
      shotId: r.shot_id,
      promptVersionId: r.prompt_version_id,
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
