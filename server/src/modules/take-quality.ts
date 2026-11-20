import {
  TAKE_QUALITY_CHECKS,
  type TakeQualityCheckKey,
  type TakeQualityEvidence,
  type TakeQualityItem,
  type TakeQualityReport,
  type TakeQualityStatus,
} from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import type { Ffmpeg } from '../ffmpeg.js';
import { nextId } from '../db/ids.js';
import { j, jget } from '../db/sqlite.js';
import { getShot } from './shots.js';
import { getTake } from './takes.js';
import { analyzeTakeVideo } from './video-analysis.js';

const LABELS: Record<TakeQualityCheckKey, string> = {
  character_presence: '角色存在',
  character_count: '角色数量',
  wardrobe_completeness: '服装完整度',
  unexpected_objects: '异常/现代物体',
  deity_icon: '神像',
  camera_in_frame: '摄像头入画',
  text_watermark: '文字与水印',
  locked_camera_drift: '固定机位漂移',
  unexpected_cut: '意外切镜',
  aspect_ratio: '画幅',
  duration: '时长',
  audio: '音频',
  anatomy_scale: '解剖与尺度',
};

function unknownItems(): TakeQualityItem[] {
  return TAKE_QUALITY_CHECKS.map((key) => ({
    key,
    status: 'unknown',
    evidence: 'unavailable',
    message: `${LABELS[key]}尚未验证，不能标为通过`,
    observed: null,
    overridden: false,
  }));
}

function saveReport(p: ProjectContext, takeId: string, items: TakeQualityItem[], aiComplete: boolean, programmaticComplete = true): TakeQualityReport {
  const take = getTake(p, takeId);
  const id = nextId(p.db, 'quality');
  const createdAt = new Date().toISOString();
  const status = items.some((item) => item.status === 'fail' || item.status === 'warn')
    ? 'attention'
    : items.every((item) => item.status === 'pass') ? 'pass' : 'unverified';
  const report: TakeQualityReport = {
    id,
    takeId,
    shotId: take.shotId,
    items,
    status,
    programmaticComplete,
    aiComplete,
    createdAt,
  };
  p.db.run('INSERT INTO take_quality_reports (id, take_id, shot_id, report_json, created_at) VALUES (?, ?, ?, ?, ?)', [id, takeId, take.shotId, j(report), createdAt]);
  return report;
}

export function latestTakeQuality(p: ProjectContext, takeId: string): TakeQualityReport | null {
  const row = p.db.get<{ report_json: string }>('SELECT report_json FROM take_quality_reports WHERE take_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', [takeId]);
  return row ? jget<TakeQualityReport | null>(row.report_json, null) : null;
}

export function listTakeQuality(p: ProjectContext, takeId: string): TakeQualityReport[] {
  return p.db.all<{ report_json: string }>('SELECT report_json FROM take_quality_reports WHERE take_id = ? ORDER BY created_at DESC, id DESC', [takeId])
    .map((row) => jget<TakeQualityReport | null>(row.report_json, null))
    .filter((report): report is TakeQualityReport => Boolean(report));
}

function setItem(items: TakeQualityItem[], key: TakeQualityCheckKey, patch: Partial<TakeQualityItem>): void {
  const item = items.find((candidate) => candidate.key === key);
  if (!item) return;
  Object.assign(item, patch, { overridden: patch.overridden ?? false });
}

function actualAspect(width: number | null, height: number | null): number | null {
  return width && height ? width / height : null;
}

function expectedAspect(ratio: string): number | null {
  const [width = 0, height = 0] = ratio.split(':').map(Number);
  return width > 0 && height > 0 ? width / height : null;
}

export interface AiQualityObservation {
  key: TakeQualityCheckKey;
  status: Exclude<TakeQualityStatus, 'unknown'>;
  message: string;
  observed?: string;
}

export async function runTakeQuality(
  p: ProjectContext,
  ffmpeg: Ffmpeg,
  takeId: string,
  aiObservations: AiQualityObservation[] = [],
): Promise<TakeQualityReport> {
  const take = getTake(p, takeId);
  const shot = getShot(p, take.shotId);
  const source = p.resolveProjectPath(take.localVideoPath);
  const [probe, analysis] = await Promise.all([ffmpeg.probe(source), analyzeTakeVideo(p, ffmpeg, takeId)]);
  const items = unknownItems();
  const actualDuration = probe.durationSeconds ?? analysis.durationSeconds;
  const durationDelta = Math.abs(actualDuration - shot.durationSeconds);
  setItem(items, 'duration', {
    status: durationDelta <= 0.15 ? 'pass' : 'fail',
    evidence: 'programmatic',
    message: durationDelta <= 0.15 ? '实际时长与 Shot 一致' : `实际时长 ${actualDuration.toFixed(2)}s，Shot 要求 ${shot.durationSeconds.toFixed(2)}s`,
    observed: `${actualDuration.toFixed(3)}s`,
  });
  const actual = actualAspect(probe.width, probe.height);
  const expected = expectedAspect(shot.aspectRatio);
  const aspectMatches = actual !== null && expected !== null && Math.abs(actual - expected) / expected <= 0.02;
  setItem(items, 'aspect_ratio', {
    status: aspectMatches ? 'pass' : 'fail',
    evidence: 'programmatic',
    message: aspectMatches ? `实际画幅符合 ${shot.aspectRatio}` : `实际尺寸 ${probe.width ?? '?'}×${probe.height ?? '?'}，不符合 ${shot.aspectRatio}`,
    observed: `${probe.width ?? '?'}×${probe.height ?? '?'}`,
  });
  const cuts = analysis.sceneCuts.filter((cut) => cut > 0.05);
  setItem(items, 'unexpected_cut', {
    status: cuts.length ? 'fail' : 'pass',
    evidence: 'programmatic',
    message: cuts.length ? `程序检测到 ${cuts.length} 个明显切镜：${cuts.join('、')}s` : '程序未检测到明显切镜；不替代人工内容验收',
    observed: cuts.join(', ') || '0 cuts',
  });
  setItem(items, 'audio', {
    status: shot.production.audio.mode !== 'none' && !probe.hasAudio ? 'fail' : 'warn',
    evidence: 'programmatic',
    message: probe.hasAudio ? '仅确认音轨存在；对白、BGM、同步和尺度仍需试听或 AI 推断' : shot.production.audio.mode === 'none' ? '未检测到音轨；当前 Shot 未指定音频来源，请人工确认是否符合意图' : 'Shot 指定了音频生产链路，但实际文件没有音轨',
    observed: probe.hasAudio ? `audio ${probe.audioDurationSeconds?.toFixed(3) ?? '?'}s` : 'no audio stream',
  });

  const visualKeys = TAKE_QUALITY_CHECKS.filter((key) => !['duration', 'aspect_ratio', 'unexpected_cut', 'audio'].includes(key));
  for (const observation of aiObservations) {
    if (!TAKE_QUALITY_CHECKS.includes(observation.key)) continue;
    const current = items.find((item) => item.key === observation.key);
    if (!current || current.evidence === 'manual') continue;
    if (['duration', 'aspect_ratio', 'audio'].includes(observation.key)) continue;
    if (current.status === 'fail' && observation.status === 'pass') continue;
    setItem(items, observation.key, {
      status: observation.status,
      evidence: 'ai_inference',
      message: `AI 推断：${observation.message}`,
      observed: observation.observed ?? null,
    });
  }
  const previous = latestTakeQuality(p, takeId);
  for (const item of previous?.items ?? []) {
    if (item.evidence !== 'ai_inference' || aiObservations.some((observation) => observation.key === item.key)) continue;
    if (['duration', 'aspect_ratio', 'unexpected_cut', 'audio'].includes(item.key)) continue;
    setItem(items, item.key, { ...item });
  }
  for (const item of previous?.items ?? []) {
    if (!item.overridden || item.evidence !== 'manual') continue;
    setItem(items, item.key, { ...item });
  }
  const aiComplete = visualKeys.every((key) => aiObservations.some((observation) => observation.key === key) || previous?.items.some((item) => item.key === key && item.evidence === 'ai_inference'));
  return saveReport(p, takeId, items, aiComplete);
}

export function overrideTakeQuality(
  p: ProjectContext,
  takeId: string,
  key: TakeQualityCheckKey,
  input: { status: Exclude<TakeQualityStatus, 'unknown'>; message: string },
): TakeQualityReport {
  if (!TAKE_QUALITY_CHECKS.includes(key)) throw new Error('未知质检项目');
  if (!['pass', 'warn', 'fail'].includes(input.status)) throw new Error('人工覆盖必须明确 pass、warn 或 fail');
  if (!input.message.trim()) throw new Error('人工覆盖必须填写依据');
  const previous = latestTakeQuality(p, takeId);
  const items = previous?.items.map((item) => ({ ...item })) ?? unknownItems();
  setItem(items, key, {
    status: input.status,
    evidence: 'manual' satisfies TakeQualityEvidence,
    message: `人工覆盖：${input.message.trim()}`,
    observed: input.message.trim(),
    overridden: true,
  });
  return saveReport(p, takeId, items, previous?.aiComplete ?? false, previous?.programmaticComplete ?? false);
}
