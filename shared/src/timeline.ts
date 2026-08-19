// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

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
  audio: { volume: number; mute: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface TimelineDoc {
  id: string;
  title: string;
  clips: TimelineClip[];
  updatedAt: string;
}
