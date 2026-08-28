// Take module — PRD §29-30. A Take is the actual generation result; selection
// is explicit and does NOT auto-commit continuity. Frame Bridge artifacts
// (poster / first / last frames) are generated locally on creation.

import { extname, join } from 'node:path';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { FAILURE_TAGS, type FailureTag, type Take, type TakeProvenance, type TakeSource } from '@h3mise/shared';
import { j, jget } from '../db/sqlite.js';
import { nextId } from '../db/ids.js';
import type { ProjectContext } from '../project-store.js';
import type { Ffmpeg } from '../ffmpeg.js';
import type { EventBus } from '../events.js';
import { advanceShotStatus, advanceTo, getShot } from './shots.js';
import { insertMedia, mediaUsage } from './assets.js';
import { createPrompt } from './prompt.js';

interface TakeRow {
  id: string;
  shot_id: string;
  render_job_id: string;
  prompt_version_id: string;
  director_plan_version_id: string | null;
  source: string;
  provenance_json: string;
  local_video_path: string;
  poster_path: string | null;
  first_frame_path: string | null;
  last_frame_path: string | null;
  duration: number;
  status: string;
  rating: number | null;
  failure_tags_json: string;
  notes: string;
  created_at: string;
}

export function takeFromRow(r: TakeRow): Take {
  return {
    id: r.id,
    shotId: r.shot_id,
    renderJobId: r.render_job_id,
    promptVersionId: r.prompt_version_id,
    directorPlanVersionId: r.director_plan_version_id,
    source: r.source as TakeSource,
    provenance: jget<TakeProvenance>(r.provenance_json, {}),
    localVideoPath: r.local_video_path,
    posterPath: r.poster_path,
    firstFramePath: r.first_frame_path,
    lastFramePath: r.last_frame_path,
    duration: r.duration,
    status: r.status as Take['status'],
    rating: r.rating,
    failureTags: jget<FailureTag[]>(r.failure_tags_json, []),
    notes: r.notes,
    createdAt: r.created_at,
  };
}

export function listTakes(p: ProjectContext, shotId: string): Take[] {
  return p.db.all<TakeRow>('SELECT * FROM takes WHERE shot_id = ? ORDER BY created_at', [shotId]).map(takeFromRow);
}

export function getTake(p: ProjectContext, id: string): Take {
  const r = p.db.get<TakeRow>('SELECT * FROM takes WHERE id = ?', [id]);
  if (!r) throw new Error('take not found');
  return takeFromRow(r);
}

export async function createTake(
  p: ProjectContext,
  input: {
    id?: string;
    shotId: string;
    renderJobId: string;
    promptVersionId: string;
    directorPlanVersionId: string | null;
    source?: TakeSource;
    provenance?: TakeProvenance;
    localVideoPath: string;
    duration: number;
    notes?: string;
  },
  ffmpeg?: Ffmpeg,
): Promise<Take> {
  // Idempotent (P0-3): one render job must never produce two takes, even if
  // the process crashes after the INSERT but before the job is marked done.
  // Enforced twice: here and by UNIQUE(render_job_id) on takes.
  const existing = p.db.get<TakeRow>('SELECT * FROM takes WHERE render_job_id = ?', [input.renderJobId]);
  if (existing) return takeFromRow(existing);
  const id = input.id ?? nextId(p.db, 'take');
  const now = new Date().toISOString();
  const framesDir = p.paths.shotFrames(input.shotId);
  await mkdir(framesDir, { recursive: true });
  const abs = p.resolveProjectPath(input.localVideoPath);
  let posterPath: string | null = null;
  let firstPath: string | null = null;
  let lastPath: string | null = null;
  if (ffmpeg) {
    try {
      const posterAbs = join(framesDir, `${id}-poster.jpg`);
      const firstAbs = join(framesDir, `${id}-first.jpg`);
      const lastAbs = join(framesDir, `${id}-last.jpg`);
      await Promise.all([
        ffmpeg.poster(abs, posterAbs, 0),
        ffmpeg.firstLastFrames(abs, firstAbs, lastAbs, input.duration),
      ]);
      posterPath = posterAbs.slice(p.root.length + 1);
      firstPath = firstAbs.slice(p.root.length + 1);
      lastPath = lastAbs.slice(p.root.length + 1);
      // Register extracted frames as MediaAssets (frame extraction source) so
      // they can serve as references for the next shot (Frame Bridge).
      for (const [rel, kind, label] of [
        [firstPath, 'image', `Take ${id} first frame`],
        [lastPath, 'image', `Take ${id} last frame`],
      ] as const) {
        if (!rel) continue;
        const absPath = p.resolveProjectPath(rel);
        const { size } = await import('node:fs/promises').then((fs) => fs.stat(absPath));
        insertMedia(p, {
          kind,
          fileName: rel,
          mimeType: 'image/jpeg',
          sizeBytes: size,
          source: 'frame_extract',
          label,
          tags: [input.shotId, id],
        });
      }
    } catch (e) {
      console.warn('[takes] frame extraction failed:', e);
    }
  }
  p.db.run(
    `INSERT INTO takes (id, shot_id, render_job_id, prompt_version_id, director_plan_version_id, source, provenance_json, local_video_path, poster_path, first_frame_path, last_frame_path, duration, status, rating, failure_tags_json, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', NULL, '[]', ?, ?)`,
    [
      id, input.shotId, input.renderJobId, input.promptVersionId, input.directorPlanVersionId,
      input.source ?? 'render', j(input.provenance ?? {}), input.localVideoPath, posterPath,
      firstPath, lastPath, input.duration, input.notes ?? '', now,
    ],
  );
  return getTake(p, id);
}

const IMPORT_VIDEO_TYPES: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
};

function importedVideoExtension(fileName: string, mimeType: string): string {
  const byMime = IMPORT_VIDEO_TYPES[mimeType.toLowerCase()];
  if (byMime) return byMime;
  const ext = extname(fileName).toLowerCase();
  if (['.mp4', '.webm', '.mov'].includes(ext)) return ext;
  throw new Error('unsupported imported video type; use MP4, WebM, or MOV');
}

/** Add an externally generated video to a Shot as a candidate Take. The
 * supporting LOCAL_READY job is an audit record only: it never enters the
 * provider queue and has zero cost. */
export async function importTake(
  p: ProjectContext,
  input: {
    shotId: string;
    fileName: string;
    mimeType: string;
    data: Buffer;
    provenance?: TakeProvenance;
  },
  ffmpeg: Ffmpeg,
): Promise<Take> {
  const shot = getShot(p, input.shotId);
  const ext = importedVideoExtension(input.fileName, input.mimeType);
  const takeId = nextId(p.db, 'take');
  const relPath = join('shots', shot.id, 'takes', `${takeId}-imported${ext}`);
  const absPath = p.resolveProjectPath(relPath);
  await mkdir(p.paths.shotTakes(shot.id), { recursive: true });
  await writeFile(absPath, input.data, { flag: 'wx' });

  let duration = 0;
  try {
    const info = await ffmpeg.probe(absPath);
    duration = Number(info.durationSeconds ?? 0);
    if (!(duration > 0) || !(Number(info.width) > 0) || !(Number(info.height) > 0)) {
      throw new Error('imported file does not contain a readable video stream');
    }
  } catch (error) {
    await unlink(absPath).catch(() => undefined);
    throw error;
  }

  const provenance: TakeProvenance = {
    originalFileName: input.fileName,
    provider: input.provenance?.provider?.trim() || 'external',
    model: input.provenance?.model?.trim() || undefined,
    prompt: input.provenance?.prompt?.trim() || undefined,
  };
  const prompt = createPrompt(p, {
    shotId: shot.id,
    source: 'import',
    h3Mode: shot.h3Mode ?? 't2va',
    text: provenance.prompt ?? '',
  });
  const jobId = nextId(p.db, 'job');
  const now = new Date().toISOString();
  p.db.run(
    `INSERT INTO render_jobs (
       id, project_id, shot_id, prompt_version_id, director_plan_version_id,
       provider, status, submitted_at, started_at, finished_at,
       request_snapshot_json, provider_response_snapshot_json, cost_json,
       error, created_at, updated_at
     ) VALUES (?, ?, ?, ?, NULL, ?, 'LOCAL_READY', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      jobId, p.meta.id, shot.id, prompt.id, provenance.provider ?? 'external', now, now, now,
      j({ source: 'import', originalFileName: input.fileName }),
      j({ imported: true, originalFileName: input.fileName }),
      j({ credits: 0, unit: 'local import' }), now, now,
    ],
  );

  try {
    const take = await createTake(p, {
      id: takeId,
      shotId: shot.id,
      renderJobId: jobId,
      promptVersionId: prompt.id,
      directorPlanVersionId: null,
      source: 'import',
      provenance,
      localVideoPath: relPath,
      duration,
      notes: `外部导入：${input.fileName}`,
    }, ffmpeg);
    p.db.run('UPDATE render_jobs SET take_id = ? WHERE id = ?', [take.id, jobId]);
    advanceTo(p, shot.id, 'HAS_TAKES');
    return take;
  } catch (error) {
    await unlink(absPath).catch(() => undefined);
    p.db.run('DELETE FROM render_jobs WHERE id = ?', [jobId]);
    p.db.run('DELETE FROM prompt_versions WHERE id = ?', [prompt.id]);
    throw error;
  }
}

export function updateTake(
  p: ProjectContext,
  id: string,
  patch: Partial<Pick<Take, 'rating' | 'failureTags' | 'notes'>>,
): Take {
  if (patch.rating !== undefined && patch.rating !== null && (!Number.isInteger(patch.rating) || patch.rating < 1 || patch.rating > 5)) {
    throw new Error('take rating must be an integer from 1 to 5');
  }
  if (patch.failureTags !== undefined && patch.failureTags.some((tag) => !FAILURE_TAGS.includes(tag))) {
    throw new Error('invalid failure tag');
  }
  const cols: string[] = [];
  const vals: unknown[] = [];
  if (patch.rating !== undefined) {
    cols.push('rating = ?');
    vals.push(patch.rating);
  }
  if (patch.failureTags !== undefined) {
    cols.push('failure_tags_json = ?');
    vals.push(j(patch.failureTags));
  }
  if (patch.notes !== undefined) {
    cols.push('notes = ?');
    vals.push(patch.notes);
  }
  if (cols.length) {
    vals.push(id);
    p.db.run(`UPDATE takes SET ${cols.join(', ')} WHERE id = ?`, vals);
  }
  return getTake(p, id);
}

export function selectTake(p: ProjectContext, takeId: string, bus?: EventBus): Take {
  const take = getTake(p, takeId);
  p.db.tx(() => {
    // Keep the three-state model: the previous selected take goes back to
    // candidate (only explicit Reject marks rejected, P1).
    p.db.run("UPDATE takes SET status = 'candidate' WHERE shot_id = ? AND status = 'selected'", [take.shotId]);
    p.db.run('UPDATE takes SET status = ?, rating = COALESCE(rating, ?) WHERE id = ?', ['selected', 5, takeId]);
  });
  const shot = getShot(p, take.shotId);
  if (shot.status === 'HAS_TAKES' || shot.status === 'SELECTED') {
    advanceShotStatus(p, take.shotId, 'SELECTED');
  } else if (shot.status === 'CONTINUITY_COMMITTED' || shot.status === 'LOCKED') {
    // P2: the committed ACTUAL continuity cites the OLD take — after a
    // reselect it is stale. Walk the shot back to SELECTED (the ledger keeps
    // its immutable history) so the UI asks for a re-commit instead of
    // claiming continuity that no longer matches the selection.
    advanceTo(p, take.shotId, 'SELECTED');
  }
  bus?.emit({ type: 'take.selected', takeId, shotId: take.shotId });
  return getTake(p, takeId);
}

export function rejectTake(p: ProjectContext, takeId: string): Take {
  const take = getTake(p, takeId);
  p.db.run("UPDATE takes SET status = 'rejected' WHERE id = ?", [takeId]);
  const selected = p.db.get<{ id: string }>("SELECT id FROM takes WHERE shot_id = ? AND status = 'selected' LIMIT 1", [take.shotId]);
  if (!selected) {
    const shot = getShot(p, take.shotId);
    if (shot.status === 'SELECTED') advanceShotStatus(p, take.shotId, 'HAS_TAKES');
  }
  return getTake(p, takeId);
}

/** Delete a rejected Take and its project-owned files. Extracted frames that
 * are still bound as references remain available; all other generated files
 * and frame MediaAsset rows are removed. The render job itself is retained as
 * an audit/cost record, with its stale take_id cleared. */
export async function deleteRejectedTake(p: ProjectContext, takeId: string): Promise<Take> {
  const take = getTake(p, takeId);
  if (take.status !== 'rejected') throw new Error('only rejected takes can be deleted');

  const paths = new Set<string>([take.localVideoPath]);
  if (take.posterPath) paths.add(take.posterPath);
  const removableMediaIds: string[] = [];
  for (const framePath of [take.firstFramePath, take.lastFramePath]) {
    if (!framePath) continue;
    const media = p.db.get<{ id: string }>('SELECT id FROM media_assets WHERE file_name = ?', [framePath]);
    const usage = media ? mediaUsage(p, media.id) : { bindings: 0, entities: 0, states: 0 };
    if (usage.bindings + usage.entities + usage.states === 0) {
      paths.add(framePath);
      if (media) removableMediaIds.push(media.id);
    }
  }

  p.db.tx(() => {
    const timelineClips = p.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM timeline_clips WHERE take_id = ?', [takeId])?.n ?? 0;
    for (const mediaId of removableMediaIds) p.db.run('DELETE FROM media_assets WHERE id = ?', [mediaId]);
    p.db.run('UPDATE render_jobs SET take_id = NULL WHERE id = ?', [take.renderJobId]);
    p.db.run('DELETE FROM takes WHERE id = ?', [takeId]);
    if (timelineClips > 0) p.db.run('UPDATE timeline SET updated_at = ? WHERE id = ?', [new Date().toISOString(), 'timeline-001']);
  });

  await Promise.all([...paths].map(async (path) => {
    try {
      await unlink(p.resolveProjectPath(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[takes] failed to remove ${path}:`, error);
    }
  }));
  return take;
}
