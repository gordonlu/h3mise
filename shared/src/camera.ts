// Camera planning — "control intent, not every frame".
// ---------------------------------------------------------------------------
// Everything here is normalized to an AR-conforming STAGE: the source image
// fitted (contain) into a frame of the requested aspect ratio. All framing
// rects live in [0..1] stage coordinates where a rect is square-relative
// (w === h, because the stage is square-relative: stage width : stage height
// equals the requested aspect ratio). The same pure functions drive the UI
// preview, the FFmpeg motion-reference renderer, and the first/last-frame
// still renderer — one geometry, three consumers.
//
// Honest limits: this is 2D crop motion (Ken Burns + 2D roll). It never
// generates parallax, 3D rotation, or dolly depth. Out-of-safe-area attempts
// are clamped and reported by planBoundsWarnings() — never faked as 3D.

export type CameraAxis = 'horizontal' | 'vertical' | 'zoom' | 'pan' | 'tilt' | 'roll';
export type CameraEase = 'linear' | 'smooth';

export interface FramingRect {
  /** Top-left in stage-normalized [0..1]; w === h (stage is AR-relative). */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CameraMoveStep {
  id: string;
  axis: CameraAxis;
  /** Signed [-1..1]; negative = reverse motion. */
  amount: number;
  /** Window as [0..1] fraction of the shot duration. */
  start: number;
  end: number;
  ease: CameraEase;
}

export interface CameraMotionPlan {
  sourceAssetId: string | null;
  durationSeconds: number;
  aspectRatio: string;
  /** true = define start + end framing boxes; false = recorded move sequence. */
  frameMode: boolean;
  startFraming: FramingRect;
  endFraming: FramingRect | null;
  steps: CameraMoveStep[];
}

export interface CameraViewFrame {
  rect: FramingRect;
  /** 2D roll in degrees (positive = content rotates clockwise). */
  angleDeg: number;
}

export const CAMERA_MIN_VIEW = 0.15;
export const CAMERA_MAX_ROLL_DEG = 12;
export const CAMERA_X_AXES = new Set<CameraAxis>(['horizontal', 'pan']);
export const CAMERA_Y_AXES = new Set<CameraAxis>(['vertical', 'tilt']);
export const CAMERA_ZOOM_AXIS = 'zoom';

export const CAMERA_AXES: CameraAxis[] = ['horizontal', 'vertical', 'zoom', 'pan', 'tilt', 'roll'];
export const CAMERA_ADVANCED_AXES: CameraAxis[] = ['roll'];

export function emptyFraming(): FramingRect {
  return { x: 0, y: 0, w: 1, h: 1 };
}

export function emptyCameraPlan(): CameraMotionPlan {
  return {
    sourceAssetId: null,
    durationSeconds: 5,
    aspectRatio: '16:9',
    frameMode: true,
    startFraming: emptyFraming(),
    endFraming: emptyFraming(),
    steps: [],
  };
}

export function normalizeCameraPlan(raw: unknown): CameraMotionPlan {
  const base = emptyCameraPlan();
  if (typeof raw !== 'object' || raw === null) return base;
  const root = raw as Record<string, any>;
  const min = CAMERA_MIN_VIEW;
  const rect = (r: unknown): FramingRect => {
    const o = (typeof r === 'object' && r !== null ? r : {}) as Record<string, any>;
    const w = Number(o.w);
    const size = Number.isFinite(w) ? Math.min(1, Math.max(min, w)) : 1;
    let x = Number(o.x);
    let y = Number(o.y);
    if (!Number.isFinite(x)) x = (1 - size) / 2;
    if (!Number.isFinite(y)) y = (1 - size) / 2;
    return clampRect({ x, y, w: size, h: size });
  };
  const steps: CameraMoveStep[] = Array.isArray(root.steps)
    ? root.steps
        .filter((s: unknown) => typeof s === 'object' && s !== null)
        .map((s: any, i: number): CameraMoveStep => {
          const axis = CAMERA_AXES.includes(s.axis) ? (s.axis as CameraAxis) : 'pan';
          const amount = Number(s.amount);
          const start = Number(s.start);
          const end = Number(s.end);
          return {
            id: typeof s.id === 'string' && s.id ? s.id : `move-${i}-${Date.now()}`,
            axis,
            amount: Number.isFinite(amount) ? Math.min(1, Math.max(-1, amount)) : 0,
            start: Number.isFinite(start) ? Math.min(1, Math.max(0, start)) : 0,
            end: Number.isFinite(end) ? Math.min(1, Math.max(0, end)) : 0,
            ease: s.ease === 'linear' ? 'linear' : 'smooth',
          };
        })
        .sort((a: CameraMoveStep, b: CameraMoveStep) => a.start - b.start)
    : [];
  return {
    sourceAssetId: typeof root.sourceAssetId === 'string' ? root.sourceAssetId : base.sourceAssetId,
    durationSeconds:
      Number.isFinite(Number(root.durationSeconds)) && Number(root.durationSeconds) > 0
        ? Math.min(15, Number(root.durationSeconds))
        : base.durationSeconds,
    aspectRatio: typeof root.aspectRatio === 'string' && /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(root.aspectRatio)
      ? root.aspectRatio
      : base.aspectRatio,
    frameMode: root.frameMode === true,
    startFraming: rect(root.startFraming ?? undefined),
    endFraming: root.endFraming ? rect(root.endFraming) : (root.frameMode === true ? rect(undefined) : null),
    steps,
  };
}

/** Clamp a rect into the stage and enforce the minimum view size. */
export function clampRect(rect: FramingRect): FramingRect {
  const size = Math.min(1, Math.max(CAMERA_MIN_VIEW, rect.w));
  const x = Math.min(Math.max(0, rect.x), 1 - size);
  const y = Math.min(Math.max(0, rect.y), 1 - size);
  return { x, y, w: size, h: size };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRect(a: FramingRect, b: FramingRect, t: number): FramingRect {
  return clampRect({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) });
}

/** smoothstep in [0..1]; 'linear' stays linear. */
export function easedProgress(p: number, ease: CameraEase): number {
  const clamped = Math.min(1, Math.max(0, p));
  return ease === 'linear' ? clamped : clamped * clamped * (3 - 2 * clamped);
}

function windowProgress(t: number, step: CameraMoveStep): number {
  if (step.end <= step.start) return t >= step.end ? 1 : 0;
  return easedProgress((t - step.start) / (step.end - step.start), step.ease);
}

/** Apply a single move to a rect with NO stage clamping (raw path, used to
 * detect how far an out-of-safe-area attempt intended to go). */
export function applyMoveRaw(rect: FramingRect, angleDeg: number, step: CameraMoveStep, progress: number): { rect: FramingRect; angleDeg: number } {
  const p = Math.min(1, Math.max(0, progress));
  let { x, y, w } = rect;
  let angle = angleDeg;
  if (CAMERA_X_AXES.has(step.axis)) {
    x += step.amount * p * (1 - w);
  } else if (CAMERA_Y_AXES.has(step.axis)) {
    y += step.amount * p * (1 - w);
  } else if (step.axis === 'zoom') {
    // amount>0 pushes in toward the minimum view; amount<0 pulls out toward
    // the full stage. Magnitude is proportional to the remaining distance.
    const target = step.amount > 0 ? CAMERA_MIN_VIEW : 1;
    w += (target - w) * Math.abs(step.amount) * p;
  } else if (step.axis === 'roll') {
    angle += step.amount * p * CAMERA_MAX_ROLL_DEG;
  }
  const size = Math.min(1, Math.max(CAMERA_MIN_VIEW, w));
  return { rect: { x, y, w: size, h: size }, angleDeg: angle };
}

/** Apply a single move to a rect; returns the rect and the accumulated angle. */
export function applyMove(rect: FramingRect, angleDeg: number, step: CameraMoveStep, progress: number): { rect: FramingRect; angleDeg: number } {
  const raw = applyMoveRaw(rect, angleDeg, step, progress);
  return { rect: clampRect(raw.rect), angleDeg: raw.angleDeg };
}

/** The view geometry at normalized time t (fraction of duration, [0..1]). */
export function viewAt(plan: CameraMotionPlan, t: number): CameraViewFrame {
  const time = Math.min(1, Math.max(0, t));
  if (plan.frameMode && plan.endFraming) {
    return { rect: lerpRect(plan.startFraming, plan.endFraming, easedProgress(time, 'smooth')), angleDeg: 0 };
  }
  let rect = clampRect(plan.startFraming);
  let angleDeg = 0;
  for (const step of plan.steps) {
    if (time < step.start) break;
    const applied = applyMove(rect, angleDeg, step, windowProgress(time, step));
    rect = applied.rect;
    angleDeg = applied.angleDeg;
  }
  return { rect, angleDeg };
}

/** Same as viewAt but WITHOUT stage clamping — how far an out-of-safe-area
 * attempt wanted to go (used only for warning detection). */
export function rawViewAt(plan: CameraMotionPlan, t: number): CameraViewFrame {
  const time = Math.min(1, Math.max(0, t));
  if (plan.frameMode && plan.endFraming) {
    return { rect: lerpRect(plan.startFraming, plan.endFraming, easedProgress(time, 'smooth')), angleDeg: 0 };
  }
  let rect = clampRect(plan.startFraming);
  let angleDeg = 0;
  for (const step of plan.steps) {
    if (time < step.start) break;
    const applied = applyMoveRaw(rect, angleDeg, step, windowProgress(time, step));
    rect = applied.rect;
    angleDeg = applied.angleDeg;
  }
  return { rect, angleDeg };
}

function drifts(a: FramingRect, b: FramingRect): boolean {
  return Math.abs(a.x - b.x) > 1e-6 || Math.abs(a.y - b.y) > 1e-6 || Math.abs(a.w - b.w) > 1e-6;
}

/** Sample the timeline and flag attempts that had to be clamped
 * (out-of-safe-area) or reverse zooms that ran past the full stage. */
export function cameraPlanWarnings(plan: CameraMotionPlan): Array<{ axis: CameraAxis | null; message: string }> {
  if (plan.frameMode && plan.endFraming) {
    const warnings: Array<{ axis: CameraAxis | null; message: string }> = [];
    if (plan.startFraming.w < CAMERA_MIN_VIEW - 1e-6 || plan.endFraming.w < CAMERA_MIN_VIEW - 1e-6) {
      warnings.push({ axis: 'zoom', message: '取景框大小低于安全下限，已达到最小视窗' });
    }
    if (drifts(rawViewAt(plan, 0).rect, plan.startFraming) || drifts(rawViewAt(plan, 1).rect, plan.endFraming!)) {
      warnings.push({ axis: null, message: '取景框超出原图边缘，已自动收窄' });
    }
    return warnings;
  }
  const warnings: Array<{ axis: CameraAxis | null; message: string }> = [];
  for (const step of plan.steps) {
    const raw = rawViewAt(plan, step.end).rect;
    const clamped = viewAt(plan, step.end).rect;
    if (drifts(raw, clamped)) {
      warnings.push({ axis: step.axis, message: '运动范围超出原图安全区域，已自动收窄' });
    }
  }
  return warnings;
}

/** Deterministic one-line description for the prompt compiler and audits.
 * Words are the H3-native vocabulary: Push In / Pull Out / Pan / Tilt /
 * Roll, with signed direction resolved to "right / left" etc. */
export function describeCameraPlan(plan: CameraMotionPlan, durationSeconds?: number): string {
  const dur = durationSeconds ?? plan.durationSeconds;
  const fmt = (f: number) => (f * dur).toFixed(1);
  if (plan.frameMode && plan.endFraming && JSON.stringify(plan.startFraming) !== JSON.stringify(plan.endFraming)) {
    return `Framing interpolation from ${(plan.startFraming.w).toFixed(2)} view to ${plan.endFraming.w.toFixed(2)} view over ${fmt(1)}s`;
  }
  if (!plan.steps.length) return 'Static camera';
  return plan.steps
    .map((step) => {
      const word = moveWord(step);
      return `${word} (${fmt(step.start)}s–${fmt(step.end)}s, ${Math.abs(step.amount).toFixed(2)})`;
    })
    .join(' → ');
}

export function moveWord(step: CameraMoveStep): string {
  if (step.axis === 'zoom') return step.amount > 0 ? 'Push In' : 'Pull Out';
  if (step.axis === 'pan') return step.amount > 0 ? 'Pan Right' : 'Pan Left';
  if (step.axis === 'tilt') return step.amount > 0 ? 'Tilt Down' : 'Tilt Up';
  if (step.axis === 'horizontal') return step.amount > 0 ? 'Move Right' : 'Move Left';
  if (step.axis === 'vertical') return step.amount > 0 ? 'Move Down' : 'Move Up';
  if (step.axis === 'roll') return step.amount > 0 ? 'Roll CW' : 'Roll CCW';
  return 'Move';
}
