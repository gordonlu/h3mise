// H3Mise shared domain model.
// Single source of truth for every business entity. Pure types — no runtime deps.

export type ProjectFormat = 'single_shot' | 'sequence' | 'story';
export type VideoProviderId = 'runninghub' | 'comfyui' | 'mock';

export interface ProjectConfig {
  title: string;
  format: ProjectFormat;
  default_aspect_ratio: string;
  visual_style?: string;
  default_provider: VideoProviderId;
  default_video_model: string;
  default_duration_seconds: number;
}

/** Registry row for a project on disk (global registry DB). */
export interface ProjectMeta {
  id: string;
  title: string;
  format: ProjectFormat;
  dirPath: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
  shotCount?: number;
  selectedTakeCount?: number;
  guide?: import('./guide.js').ProjectGuideSummary;
}

// ---------------------------------------------------------------------------
// Story
// ---------------------------------------------------------------------------

export type BeatCategory =
  | 'setup'
  | 'inciting_incident'
  | 'rising_action'
  | 'climax'
  | 'falling_action'
  | 'resolution'
  | 'transition'
  | 'other';

export interface StoryBeat {
  id: string;
  sequenceId: string | null;
  order: number;
  title: string;
  category: BeatCategory;
  summary: string;
  location?: string;
  timeOfDay?: string;
  weather?: string;
  characters: string[]; // entity ids
  stateChange?: string;
  notes?: string;
  durationSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface Sequence {
  id: string;
  title: string;
  order: number;
  summary?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoryDoc {
  id: string;
  title: string;
  synopsis: string;
  body: string; // free-form script / source text
  plannedDurationSeconds: number;
  createdAt: string;
  updatedAt: string;
}
