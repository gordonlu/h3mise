// Camera-plan module — CRUD + local deterministic rendering.
// ---------------------------------------------------------------------------
// Consumable outputs (never just a prompt):
//   • motion reference video   — 2D crop/zoom/pan/tilt/roll over the source image
//   • first/last frame stills  — direct FL2VA inputs, optionally auto-bound
// The same shared viewAt() math drives preview, motion video, and stills.
// Roll is 2D content roll (rotate-after-crop, black corners) — no 3D faking.

import type { CameraMotionPlan, MediaAsset } from '@h3mise/shared';
import { cameraPlanWarnings, normalizeCameraPlan, viewAt } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { j, jget } from '../db/sqlite.js';
import { nextId } from '../db/ids.js';
import { createBinding, insertMedia } from './assets.js';
import type { Ffmpeg } from '../ffmpeg.js';
import { mkdir, stat, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

interface CameraPlanRow {
  id: string;
  shot_id: string;
  plan_json: string;
  created_at: string;
  updated_at: string;
}

export function getCameraPlan(p: ProjectContext, shotId: string): CameraMotionPlan | null {
  const row = p.db.get<CameraPlanRow>('SELECT * FROM camera_plans WHERE shot_id = ?', [shotId]);
  return row ? normalizeCameraPlan(jget<unknown>(row.plan_json, null)) : null;
}

export function saveCameraPlan(p: ProjectContext, shotId: string, plan: unknown): CameraMotionPlan {
  const normalized = normalizeCameraPlan(plan);
  const existing = p.db.get<{ id: string }>('SELECT id FROM camera_plans WHERE shot_id = ?', [shotId]);
  const now = new Date().toISOString();
  if (existing) {
    p.db.run('UPDATE camera_plans SET plan_json = ?, updated_at = ? WHERE shot_id = ?', [j(normalized), now, shotId]);
  } else {
    p.db.run('INSERT INTO camera_plans (id, shot_id, plan_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [
      nextId(p.db, 'camera-plan'),
      shotId,
      j(normalized),
      now,
      now,
    ]);
  }
  return normalized;
}

export function cameraPlanWarningsFor(p: ProjectContext, shotId: string): Array<{ axis: string | null; message: string }> {
  const plan = getCameraPlan(p, shotId);
  return plan ? cameraPlanWarnings(plan) : [];
}

// --- render helpers ---------------------------------------------------------

interface StageSpec {
  width: number;
  height: number;
  fps: number;
  frames: number;
}

function stageFor(aspectRatio: string, durationSeconds: number): StageSpec {
  const fps = 24;
  // Small, fast reference clips: long side ≤ 640.
  const [rw, rh] = aspectRatio.split(':').map((v) => Number(v) || 1);
  const w = Math.max(1, rw ?? 1);
  const h = Math.max(1, rh ?? 1);
  let width = 640;
  let height = Math.max(2, Math.round((640 * h) / w));
  if (height > 640) {
    height = 640;
    width = Math.max(2, Math.round((640 * w) / h));
  }
  height = Math.max(2, height & ~1);
  width = Math.max(2, width & ~1);
  const frames = Math.max(2, Math.round(durationSeconds * fps));
  return { width, height, fps, frames };
}

interface ExpressionTable {
  z: string;
  x: string;
  y: string;
  angle: string | null;
}

function exprTable(values: number[], pad: (v: number) => string): string {
  if (!values.length) return '0';
  let out = '';
  values.forEach((v, i) => {
    out += `if(eq(on,${i}),${pad(v)},`;
  });
  out += pad(values[values.length - 1]!);
  return out + ')'.repeat(values.length);
}

function exprTableT(values: number[], fps: number, pad: (v: number) => string): string {
  if (!values.length) return '0';
  let out = '';
  values.forEach((v, i) => {
    out += `if(lte(t,${(i / fps).toFixed(3)}),${pad(v)},`;
  });
  out += pad(values[values.length - 1]!);
  return out + ')'.repeat(values.length);
}

/** Per-frame z/x/y/angle tables for zoompan + rotate. Deterministic, sampled
 * from the same shared viewAt() the preview uses. */
function zoomPanExpressions(
  plan: CameraMotionPlan,
  stage: StageSpec,
  canvas: { sw: number; sh: number; ox: number; oy: number },
): ExpressionTable {
  const zs: number[] = [];
  const xs: number[] = [];
  const ys: number[] = [];
  const angles: number[] = [];
  for (let i = 0; i < stage.frames; i++) {
    const view = viewAt(plan, i / (stage.frames - 1));
    const cropW = view.rect.w * canvas.sw;
    const z = Math.min(100, Math.max(1.002, stage.width / Math.max(1, cropW)));
    const x = Math.min(Math.max(0, canvas.ox + view.rect.x * canvas.sw), stage.width - stage.width / z);
    const y = Math.min(Math.max(0, canvas.oy + view.rect.y * canvas.sh), stage.height - stage.height / z);
    zs.push(z);
    xs.push(x);
    ys.push(y);
    angles.push(view.angleDeg);
  }
  const pad = (v: number) => v.toFixed(4);
  const hasRoll = angles.some((a) => Math.abs(a) > 0.001);
  return {
    z: exprTable(zs, pad),
    x: exprTable(xs, pad),
    y: exprTable(ys, pad),
    angle: hasRoll ? exprTableT(angles.map((a) => (a * Math.PI) / 180), stage.fps, pad) : null,
  };
}

function canvasForwardInfo(srcW: number, srcH: number, stage: StageSpec): { sw: number; sh: number; ox: number; oy: number } {
  const s = Math.min(stage.width / srcW, stage.height / srcH);
  return {
    sw: Math.round(srcW * s),
    sh: Math.round(srcH * s),
    ox: Math.round((stage.width - srcW * s) / 2),
    oy: Math.round((stage.height - srcH * s) / 2),
  };
}

/** Fit the source into a black AR-conforming canvas (first stage of every
 * render, both motion video and stills). */
function canvasPrefix(ffmpeg: Ffmpeg, sourceAbs: string, outAbs: string, stage: StageSpec): Promise<void> {
  return ffmpeg.runRaw([
    '-y', '-i', sourceAbs,
    '-vf', `scale=${stage.width}:${stage.height}:force_original_aspect_ratio=decrease,pad=${stage.width}:${stage.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`,
    '-frames:v', '1', '-update', '1',
    outAbs,
  ], sourceAbs);
}

async function canvasAbs(p: ProjectContext, ffmpeg: Ffmpeg, sourceAbs: string, stage: StageSpec): Promise<string> {
  const cacheDir = join(p.paths.cache, 'camera-plan', String(Date.now()));
  await mkdir(cacheDir, { recursive: true });
  const canvas = join(cacheDir, 'canvas.png');
  await canvasPrefix(ffmpeg, sourceAbs, canvas, stage);
  return canvas;
}

/** Render the camera motion as a short, locally computed reference clip. */
export async function renderCameraMotion(
  p: ProjectContext,
  ffmpeg: Ffmpeg,
  plan: CameraMotionPlan,
  sourceAsset: MediaAsset,
): Promise<MediaAsset> {
  if (sourceAsset.kind !== 'image') throw new Error('相机运动参考基于单张源图，请先选择一张图片素材');
  const sourceAbs = p.resolveProjectPath(sourceAsset.fileName);
  const info = await ffmpeg.probe(sourceAbs);
  if (!info.width || !info.height) throw new Error('无法读取源图尺寸');
  const stage = stageFor(plan.aspectRatio, plan.durationSeconds);
  const canvas = canvasForwardInfo(info.width, info.height, stage);
  const table = zoomPanExpressions(plan, stage, canvas);
  const canvasPath = await canvasAbs(p, ffmpeg, sourceAbs, stage);
  const id = nextId(p.db, 'media');
  const outName = `camera-motion-${Date.now()}.mp4`;
  const outAbs = join(p.paths.assets, outName);
  await mkdir(dirname(outAbs), { recursive: true });
  const part = `${outAbs}.part`;
  const rotateExpr = table.angle
    ? `,rotate=${table.angle.replace(/[:(),]/g, (c) => `\\${c}`)}:c=black@1`
    : '';
  await ffmpeg.runRaw(
    [
      '-y',
      '-loop', '1', '-framerate', String(stage.fps), '-t', '100',
      '-i', canvasPath,
      '-filter_complex',
      `zoompan=z='${table.z}':x='${table.x}':y='${table.y}':d=1:s=${stage.width}x${stage.height}:fps=${stage.fps}${rotateExpr},format=yuv420p`,
      '-frames:v', String(stage.frames),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '21',
      '-movflags', '+faststart',
      '-f', 'mp4',
      part,
    ],
    canvasPath,
  );
  const { size } = await stat(part);
  await rename(part, outAbs);
  return insertMedia(p, {
    id,
    kind: 'video',
    fileName: `assets/${outName}`,
    mimeType: 'video/mp4',
    sizeBytes: size,
    width: stage.width,
    height: stage.height,
    durationSeconds: plan.durationSeconds,
    source: 'other',
    label: 'Camera motion reference',
  });
}

/** Render first-frame and last-frame stills from the plan (FL2VA inputs).
 * When bind is true, first-frame still replaces the shot's existing first
 * frame binding and last-frame still is bound as this shot's last frame. */
export async function renderCameraFrames(
  p: ProjectContext,
  ffmpeg: Ffmpeg,
  plan: CameraMotionPlan,
  sourceAsset: MediaAsset,
  shotId: string,
  options?: { bind?: boolean },
): Promise<{ firstAssetId: string; lastAssetId: string; firstBindingId: string | null; lastBindingId: string | null }> {
  if (sourceAsset.kind !== 'image') throw new Error('取景帧基于单张源图，请先选择一张图片素材');
  const sourceAbs = p.resolveProjectPath(sourceAsset.fileName);
  const info = await ffmpeg.probe(sourceAbs);
  if (!info.width || !info.height) throw new Error('无法读取源图尺寸');
  const stage = stageFor(plan.aspectRatio, plan.durationSeconds);
  const canvas = canvasForwardInfo(info.width, info.height, stage);
  const frame = async (t: number, label: string): Promise<MediaAsset> => {
    const view = viewAt(plan, t);
    const cropW = Math.max(2, Math.round(view.rect.w * canvas.sw));
    const cropH = Math.max(2, Math.round(view.rect.w * canvas.sh));
    const cx = Math.min(Math.max(0, Math.round(canvas.ox + view.rect.x * canvas.sw)), stage.width - cropW);
    const cy = Math.min(Math.max(0, Math.round(canvas.oy + view.rect.y * canvas.sh)), stage.height - cropH);
    const id = nextId(p.db, 'media');
    const outName = `camera-frame-${Date.now()}-${label}.jpg`;
    const outAbs = join(p.paths.assets, outName);
    await mkdir(dirname(outAbs), { recursive: true });
    const rotate = Math.abs(view.angleDeg) > 0.001
      ? `,rotate=${((view.angleDeg * Math.PI) / 180).toFixed(5)}:c=black@1`
      : '';
    await ffmpeg.runRaw(
      [
        '-y', '-i', sourceAbs,
        '-vf',
        `scale=${stage.width}:${stage.height}:force_original_aspect_ratio=decrease,pad=${stage.width}:${stage.height}:(ow-iw)/2:(oh-ih)/2:color=black,crop=${cropW}:${cropH}:${cx}:${cy},scale=${stage.width}:${stage.height}${rotate}`,
        '-frames:v', '1', '-q:v', '2',
        outAbs,
      ],
      sourceAbs,
    );
    const fileStat = await stat(outAbs);
    return insertMedia(p, {
      id,
      kind: 'image',
      fileName: `assets/${outName}`,
      mimeType: 'image/jpeg',
      sizeBytes: fileStat.size,
      width: stage.width,
      height: stage.height,
      source: 'other',
      label,
    });
  };
  const first = await frame(0, 'Camera first frame');
  const last = await frame(1, 'Camera last frame');
  let firstBindingId: string | null = null;
  let lastBindingId: string | null = null;
  if (options?.bind) {
    // Only replace bindings this planner created ("Camera …" labels). Never
    // clobber a user's Frame Bridge or manually chosen first/last frame —
    // silently overwriting those would break the previous_take chain.
    const shotBindings = p.db.all<{ id: string; label: string; roles_json: string }>(
      'SELECT id, label, roles_json FROM reference_bindings WHERE shot_id IS ?',
      [shotId],
    );
    const isCameraMade = (binding: { id: string; label: string }) => binding.label.startsWith('Camera ');
    for (const binding of shotBindings) {
      const roles = jget<string[]>(binding.roles_json, []);
      if ((roles.includes('first_frame') || roles.includes('last_frame')) && !isCameraMade(binding)) continue;
      if (roles.includes('first_frame') && isCameraMade(binding)) p.db.run('DELETE FROM reference_bindings WHERE id = ?', [binding.id]);
      if (roles.includes('last_frame') && isCameraMade(binding)) p.db.run('DELETE FROM reference_bindings WHERE id = ?', [binding.id]);
    }
    const remainsFirst = shotBindings.some((b) => !isCameraMade(b) && jget<string[]>(b.roles_json, []).includes('first_frame'));
    const remainsLast = shotBindings.some((b) => !isCameraMade(b) && jget<string[]>(b.roles_json, []).includes('last_frame'));
    // Bind only the side that stays free; the other keeps the user's chosen frame.
    if (!remainsFirst) {
      firstBindingId = createBinding(p, { assetId: first.id, roles: ['first_frame'], label: 'Camera first frame (planned)', shotId }).id;
    }
    if (!remainsLast) {
      lastBindingId = createBinding(p, { assetId: last.id, roles: ['last_frame'], label: 'Camera last frame (planned)', shotId }).id;
    }
  }
  return { firstAssetId: first.id, lastAssetId: last.id, firstBindingId, lastBindingId };
}

export { viewAt };
