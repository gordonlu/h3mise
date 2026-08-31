import { access } from 'node:fs/promises';
import type { FilmCheckIssue, FilmCheckResult } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { listShots } from './shots.js';
import { getTake, listTakes } from './takes.js';
import { getTimeline } from './timeline.js';

async function fileExists(p: ProjectContext, relPath: string | null): Promise<boolean> {
  if (!relPath) return false;
  try { await access(p.resolveProjectPath(relPath)); return true; } catch { return false; }
}

/** Shared export gate used by both the professional timeline and one-click
 * production. This is derived from canonical project data and stores no
 * parallel "film ready" state. */
export async function runFilmCheck(p: ProjectContext): Promise<FilmCheckResult> {
  const issues: FilmCheckIssue[] = [];
  const add = (severity: 'error' | 'warning', code: string, message: string, target: FilmCheckIssue['target']) =>
    issues.push({ severity, code, message, target });
  const shots = listShots(p);
  const timeline = getTimeline(p);
  let selectedTakes = 0;

  for (const shot of shots) {
    const takes = listTakes(p, shot.id);
    const selected = takes.find((take) => take.status === 'selected');
    if (!selected) {
      add('error', takes.length ? 'shot.no-selected' : 'shot.no-takes', `「${shot.title}」${takes.length ? '还没有选定Take' : '还没有可用Take'}`, { kind: 'shot', shotId: shot.id });
      continue;
    }
    selectedTakes++;
    if (!(await fileExists(p, selected.localVideoPath))) {
      add('error', 'take.missing-file', `「${shot.title}」选定Take的视频文件缺失`, { kind: 'shot', shotId: shot.id });
    }
  }

  if (!timeline.clips.length) add('error', 'timeline.empty', '时间线为空，无法导出成片', { kind: 'timeline' });
  let duration = 0;
  const timelineShots = new Set<string>();
  for (const clip of timeline.clips) {
    timelineShots.add(clip.shotId);
    let take;
    try { take = getTake(p, clip.takeId); } catch {
      add('error', 'clip.take-missing', `片段${clip.id}引用的Take不存在`, { kind: 'timeline-clip', clipId: clip.id });
      continue;
    }
    if (take.status !== 'selected' || take.shotId !== clip.shotId) {
      add('error', 'clip.take-invalid', `片段${clip.id}不是该镜头当前选定的Take`, { kind: 'timeline-clip', clipId: clip.id });
      continue;
    }
    const end = clip.trimOut ?? take.duration;
    if (clip.trimIn < 0 || end > take.duration + 0.05 || end - clip.trimIn < 0.1) {
      add('error', 'clip.trim-invalid', `片段${clip.id}的裁切范围无效`, { kind: 'timeline-clip', clipId: clip.id });
      continue;
    }
    duration += end - clip.trimIn;
  }
  for (const shot of shots) {
    if (listTakes(p, shot.id).some((take) => take.status === 'selected') && !timelineShots.has(shot.id)) {
      add('error', 'shot.not-on-timeline', `「${shot.title}」已选片但未加入时间线`, { kind: 'shot', shotId: shot.id });
    }
  }
  const errors = issues.filter((issue) => issue.severity === 'error');
  return {
    errors,
    warnings: issues.filter((issue) => issue.severity === 'warning'),
    canExport: errors.length === 0 && timeline.clips.length > 0,
    summary: { shots: shots.length, selectedTakes, timelineClips: timeline.clips.length, filmDurationSeconds: Math.round(duration * 100) / 100 },
  };
}
