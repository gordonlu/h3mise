import type {
  ProductionIssue,
  ProductionIssueSeverity,
  ProductionOverview,
  ProductionShotStatus,
  RenderBatchShotStage,
} from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { getStory, listBeats } from './story.js';
import { listShots } from './shots.js';
import { getTimeline, listTimelineExports } from './timeline.js';
import { planRenderBatch } from './render-batch.js';
import { jget } from '../db/sqlite.js';

const ACTIVE = ['LOCAL_QUEUED', 'UPLOADING', 'SUBMITTING', 'QUEUED', 'RUNNING', 'DOWNLOADING'];

const STAGE_PRIORITY: Record<RenderBatchShotStage, number> = {
  blocked: 0,
  needs_selection: 1,
  waiting_dependency: 2,
  needs_assets: 3,
  needs_prompt: 4,
  needs_preflight: 5,
  ready: 6,
  active: 7,
  done: 8,
};

const STAGE_ISSUE: Partial<Record<RenderBatchShotStage, { severity: ProductionIssueSeverity; title: string }>> = {
  blocked: { severity: 'blocker', title: '生成条件被阻塞' },
  needs_selection: { severity: 'warning', title: '已有候选 Take，等待选片' },
  waiting_dependency: { severity: 'warning', title: '等待上游镜头' },
  needs_assets: { severity: 'warning', title: '参考素材未齐' },
  needs_prompt: { severity: 'warning', title: 'Prompt 尚未准备' },
  needs_preflight: { severity: 'info', title: '需要生成前检查' },
  ready: { severity: 'info', title: '可以开始生成' },
};

function issue(input: ProductionIssue): ProductionIssue {
  return input;
}

function timelineDuration(p: ProjectContext): number {
  const clips = getTimeline(p).clips;
  return Math.max(0, clips.reduce((total, clip) => {
    const takeDuration = p.db.get<{ duration: number }>('SELECT duration FROM takes WHERE id = ?', [clip.takeId])?.duration ?? 0;
    return total + Math.max(0, (clip.trimOut ?? takeDuration) - clip.trimIn);
  }, 0) - clips.slice(1).reduce((total, clip) => total + (clip.transition === 'cut' || clip.transition === 'none' ? 0 : clip.transitionDuration), 0));
}

export async function productionOverview(p: ProjectContext, registry: ProviderRegistry): Promise<ProductionOverview> {
  const story = getStory(p);
  const shots = listShots(p);
  const beats = listBeats(p);
  const activeAuto = p.db.get<{ settings_json: string }>("SELECT settings_json FROM auto_produce_runs WHERE status NOT IN ('succeeded','failed','cancelled') ORDER BY started_at DESC LIMIT 1");
  const providerId = activeAuto
    ? jget<{ providerId?: string }>(activeAuto.settings_json, {}).providerId ?? p.config.default_provider ?? 'runninghub'
    : p.config.default_provider ?? 'runninghub';
  const provider = registry.get(providerId);
  const batch = await planRenderBatch(p, registry, { providerId });
  const timeline = getTimeline(p);
  const exports = listTimelineExports(p);
  const issues: ProductionIssue[] = [];
  const shotDurationSeconds = shots.reduce((sum, shot) => sum + shot.durationSeconds, 0);

  if (!story.synopsis.trim() && !story.body.trim()) {
    issues.push(issue({ id: 'story-empty', severity: 'warning', category: 'story', title: '故事内容还是空的', detail: '先补充梗概或完整故事，后续镜头才有稳定依据。', to: '/story' }));
  }
  if (shots.length === 0) {
    issues.push(issue({ id: 'shots-empty', severity: 'blocker', category: 'story', title: '还没有镜头', detail: '把故事拆成 Shot 后，才能安排资产、生成和选片。', to: '/shots' }));
  }
  if (story.plannedDurationSeconds > 0 && shots.length > 0) {
    const delta = Math.abs(story.plannedDurationSeconds - shotDurationSeconds);
    if (delta > Math.max(3, story.plannedDurationSeconds * 0.15)) {
      issues.push(issue({
        id: 'duration-mismatch', severity: 'warning', category: 'story', title: '镜头总时长与故事规划不一致',
        detail: `故事规划 ${story.plannedDurationSeconds.toFixed(1)} 秒，当前 Shot 合计 ${shotDurationSeconds.toFixed(1)} 秒。`, to: '/story',
      }));
    }
  }
  const uncoveredBeats = beats.filter((beat) => !shots.some((shot) => shot.storyBeatId === beat.id));
  if (uncoveredBeats.length > 0) {
    issues.push(issue({ id: 'beats-uncovered', severity: 'warning', category: 'story', title: `${uncoveredBeats.length} 个 StoryBeat 没有对应镜头`, detail: `例如：${uncoveredBeats.slice(0, 3).map((beat) => beat.title).join('、')}`, to: '/shots' }));
  }

  const providerBlocked = batch.shots.filter((shot) => shot.stage === 'blocked' && /生成服务.+尚未配置/.test(shot.reason));
  if (shots.length > 0 && !provider?.configured) {
    issues.push(issue({ id: 'provider-unconfigured', severity: 'blocker', category: 'generation', title: `${providerId} 尚未配置`, detail: `${shots.length} 个镜头使用当前生成服务；完成配置前不会提交任务。`, to: '/settings' }));
  }

  const shotStatuses: ProductionShotStatus[] = batch.shots.map((item) => {
    const shot = shots.find((candidate) => candidate.id === item.shotId)!;
    const takes = p.db.get<{ n: number; selected_id: string | null }>(
      "SELECT COUNT(*) AS n, MAX(CASE WHEN status = 'selected' THEN id END) AS selected_id FROM takes WHERE shot_id = ? AND status IN ('candidate','selected')",
      [shot.id],
    ) ?? { n: 0, selected_id: null };
    const failedJobCount = p.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM render_jobs WHERE shot_id = ? AND status = 'FAILED'", [shot.id])?.n ?? 0;
    const onTimeline = timeline.clips.some((clip) => clip.shotId === shot.id && clip.takeId === takes.selected_id);
    const hasContinuity = Boolean(p.db.get<{ id: string }>("SELECT id FROM continuity_entries WHERE shot_id = ? AND scope = 'visual' AND kind = 'actual' LIMIT 1", [shot.id]));
    return {
      shotId: shot.id, order: shot.order, title: shot.title || shot.id, durationSeconds: shot.durationSeconds,
      stage: item.stage, reason: item.reason, takeCount: takes.n, selectedTakeId: takes.selected_id,
      failedJobCount, onTimeline, hasContinuity, to: `/shots/${shot.id}`,
    };
  });

  for (const item of batch.shots) {
    const config = STAGE_ISSUE[item.stage];
    if (!config || (item.stage === 'blocked' && providerBlocked.some((blocked) => blocked.shotId === item.shotId))) continue;
    issues.push(issue({
      id: `shot-${item.shotId}-${item.stage}`,
      severity: config.severity,
      category: item.stage === 'needs_assets' ? 'assets' : item.stage === 'needs_selection' ? 'review' : 'generation',
      title: `${item.title || item.shotId}：${config.title}`,
      detail: item.reason,
      to: `/shots/${item.shotId}`,
      shotId: item.shotId,
    }));
  }

  const selectedMissingTimeline = shotStatuses.filter((shot) => shot.selectedTakeId && !shot.onTimeline);
  if (selectedMissingTimeline.length > 0) {
    issues.push(issue({ id: 'timeline-missing-selected', severity: 'warning', category: 'timeline', title: `${selectedMissingTimeline.length} 个已选镜头尚未加入时间线`, detail: '可以在快速剪辑或专业时间线中补齐，已存在的剪辑不会被覆盖。', to: '/timeline' }));
  }
  const selectedMissingContinuity = shotStatuses.filter((shot, index) => shot.selectedTakeId && index < shotStatuses.length - 1 && !shot.hasContinuity);
  if (selectedMissingContinuity.length > 0) {
    issues.push(issue({ id: 'continuity-missing', severity: 'info', category: 'continuity', title: `${selectedMissingContinuity.length} 个已选镜头还没记录实际连续性`, detail: '记录尾帧中的人物、道具和空间状态，可以减少后续镜头描述错位。', to: selectedMissingContinuity[0]!.to, shotId: selectedMissingContinuity[0]!.shotId }));
  }
  const failedJobCount = p.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM render_jobs WHERE status = 'FAILED'")?.n ?? 0;
  if (failedJobCount > 0) {
    issues.push(issue({ id: 'render-failures', severity: 'warning', category: 'generation', title: `项目中有 ${failedJobCount} 条失败记录`, detail: '历史失败不会阻止继续制作；可在镜头或渲染队列中查看具体阶段和错误。', to: '/shots' }));
  }
  if (timeline.clips.length > 0 && exports.length === 0) {
    issues.push(issue({ id: 'not-exported', severity: 'info', category: 'timeline', title: '时间线尚未导出成片', detail: '镜头编排完成后，在时间线检查声音、裁切和转场再导出。', to: '/timeline' }));
  } else if (exports.length > 0 && new Date(timeline.updatedAt).getTime() > new Date(exports[0]!.createdAt).getTime()) {
    issues.push(issue({ id: 'export-stale', severity: 'warning', category: 'timeline', title: '时间线在上次导出后有修改', detail: '当前导出文件不包含最新的剪辑调整，需要重新导出。', to: '/timeline' }));
  }

  const severityRank: Record<ProductionIssueSeverity, number> = { blocker: 0, warning: 1, info: 2 };
  issues.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  shotStatuses.sort((a, b) => STAGE_PRIORITY[a.stage] - STAGE_PRIORITY[b.stage] || a.order - b.order);

  return {
    projectId: p.meta.id,
    providerId,
    generatedAt: new Date().toISOString(),
    summary: {
      plannedDurationSeconds: story.plannedDurationSeconds,
      shotDurationSeconds,
      timelineDurationSeconds: timelineDuration(p),
      shotCount: shots.length,
      selectedCount: shotStatuses.filter((shot) => shot.selectedTakeId).length,
      timelineClipCount: timeline.clips.length,
      exportCount: exports.length,
      activeRenderCount: p.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM render_jobs WHERE status IN (${ACTIVE.map(() => '?').join(',')})`, ACTIVE)?.n ?? 0,
      failedJobCount,
      remainingShotCount: shotStatuses.filter((shot) => shot.stage !== 'done').length,
    },
    nextActions: issues.slice(0, 3),
    issues,
    shots: shotStatuses,
  };
}
