// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export type EntityKind = 'character' | 'scene' | 'prop' | 'vehicle' | 'creature';

export interface Entity {
  id: string;
  kind: EntityKind;
  name: string;
  description: string;
  notes?: string;
  /** Open-ended trait map (costume defaults, physical traits, …). */
  traits: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/** CharacterState = "what this person looks like in the current story state". */
export interface CharacterState {
  id: string;
  characterId: string;
  name: string;
  costume: string;
  hair: string;
  injury: string;
  heldItems: string[];
  extra: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export type MediaKind = 'image' | 'video' | 'audio';

export interface MediaAsset {
  id: string;
  kind: MediaKind;
  fileName: string; // relative path under project assets/…
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  /** Poster frame (relative path) — auto-generated for video imports. */
  posterPath?: string | null;
  source: 'import' | 'frame_extract' | 'render_download' | 'other';
  label: string;
  tags: string[];
  createdAt: string;
}

export type ReferenceRole =
  | 'identity'
  | 'costume'
  | 'environment'
  | 'motion'
  | 'body_motion'
  | 'timing'
  | 'camera_motion'
  | 'lighting'
  | 'style'
  | 'audio'
  | 'first_frame'
  | 'last_frame';

export interface ReferenceBinding {
  id: string;
  assetId: string;
  type: MediaKind;
  roles: ReferenceRole[];
  /** Attributes of the reference the model must preserve. */
  preserve: string[];
  /** Attributes the model must ignore. */
  ignore: string[];
  label: string;
  /** Optional target shot; null = global/pool binding. */
  shotId: string | null;
  createdAt: string;
}

