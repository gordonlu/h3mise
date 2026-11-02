// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export type TimelineLookId = 'none' | 'cinematic' | 'warm_film' | 'bleach_bypass';

export const TIMELINE_LOOK_IDS: TimelineLookId[] = ['none', 'cinematic', 'warm_film', 'bleach_bypass'];

export function isTimelineLook(value: unknown): value is TimelineLookId {
  return typeof value === 'string' && TIMELINE_LOOK_IDS.includes(value as TimelineLookId);
}

export interface TimelineClip {
  id: string;
  order: number;
  shotId: string;
  takeId: string;
  /** Trim within the take's video, seconds. */
  trimIn: number;
  trimOut: number | null;
  transition: 'cut' | 'fade' | 'dissolve' | 'none';
  transitionDuration: number;
  /** Post-production color look; independent from the generation prompt. */
  look: TimelineLookId;
  /** Per-clip export audio. Loudness normalization is enabled by default so
   * generated Takes from different jobs do not jump in perceived volume. */
  audio: { volume: number; mute: boolean; normalize: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface TimelineDoc {
  id: string;
  title: string;
  clips: TimelineClip[];
  /** Optional project master audio line used for the final mix. */
  masterAudioLineId: string | null;
  updatedAt: string;
}

/** Hard cuts carry no overlap. `none` is a legacy alias kept for stored data. */
export function isHardTransition(transition: TimelineClip['transition']): boolean {
  return transition === 'cut' || transition === 'none';
}

/** Duration of a clip after trimming, before transition overlaps. */
export function timelineClipDuration(clip: TimelineClip, takeDurationSeconds: number): number {
  const end = clip.trimOut ?? takeDurationSeconds;
  return Math.max(0, end - clip.trimIn);
}

/** Clamp one transition to something both neighbouring clips can absorb. */
export function effectiveTransitionDuration(
  transition: TimelineClip['transition'],
  requestedDurationSeconds: number,
  previousDurationSeconds: number,
  currentDurationSeconds: number,
): number {
  if (isHardTransition(transition)) return 0;
  const requested = Number.isFinite(requestedDurationSeconds) ? Math.max(0, requestedDurationSeconds) : 0;
  return Math.max(0, Math.min(requested, previousDurationSeconds / 2, currentDurationSeconds / 2));
}

export interface EffectiveTimelineTransition {
  clipId: string;
  type: TimelineClip['transition'];
  requestedDuration: number;
  duration: number;
}

/** One effective transition per incoming clip (the first clip has none). */
export function effectiveTransitions(
  clips: readonly TimelineClip[],
  takeDurationSeconds: (clip: TimelineClip) => number,
): EffectiveTimelineTransition[] {
  const out: EffectiveTimelineTransition[] = [];
  for (let index = 1; index < clips.length; index += 1) {
    const previous = clips[index - 1]!;
    const current = clips[index]!;
    out.push({
      clipId: current.id,
      type: current.transition,
      requestedDuration: current.transitionDuration,
      duration: effectiveTransitionDuration(
        current.transition,
        current.transitionDuration,
        timelineClipDuration(previous, takeDurationSeconds(previous)),
        timelineClipDuration(current, takeDurationSeconds(current)),
      ),
    });
  }
  return out;
}

/** Final film duration: trimmed clips minus the overlap actually consumed. */
export function timelineDurationSeconds(
  clips: readonly TimelineClip[],
  takeDurationSeconds: (clip: TimelineClip) => number,
): number {
  const total = clips.reduce((sum, clip) => sum + timelineClipDuration(clip, takeDurationSeconds(clip)), 0);
  const overlap = effectiveTransitions(clips, takeDurationSeconds).reduce((sum, transition) => sum + transition.duration, 0);
  return Math.max(0, total - overlap);
}
