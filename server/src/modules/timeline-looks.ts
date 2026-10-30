// Deterministic, bundled color looks for the timeline. Only whitelisted ids
// from @h3mise/shared can reach these FFmpeg chains; clients never send raw
// filter expressions.
import type { TimelineLookId } from '@h3mise/shared';

export const TIMELINE_LOOK_FILTERS: Record<Exclude<TimelineLookId, 'none'>, string[]> = {
  cinematic: [
    "eq=contrast=1.08:saturation=1.02:brightness=-0.01",
    "colorbalance=rs=-0.02:bs=0.03:rm=0.02:bm=-0.02:rh=0.04:bh=-0.03",
    "curves=all='0/0.02 0.5/0.5 1/0.98'",
  ],
  warm_film: [
    'eq=contrast=1.04:saturation=1.06:brightness=0.01',
    'colorbalance=rs=0.05:gs=0.01:bs=-0.04:rm=0.03:bm=-0.02:rh=0.03:bh=-0.02',
    "curves=all='0/0.04 0.5/0.52 1/0.98'",
  ],
  bleach_bypass: [
    'eq=contrast=1.22:saturation=0.55:brightness=0.015',
    "curves=all='0/0.02 0.5/0.55 1/0.98'",
    'unsharp=5:5:0.35:5:5:0',
  ],
};

export function timelineLookFilters(look: TimelineLookId): string[] {
  return look === 'none' ? [] : TIMELINE_LOOK_FILTERS[look];
}
