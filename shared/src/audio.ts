// Project-level audio lines and shot-bound lyric/dialogue segments.
export type AudioLineKind = 'master' | 'vocal';

export interface AudioLine {
  id: string;
  assetId: string;
  kind: AudioLineKind;
  label: string;
  /** Sync offset in seconds; segment times are relative to the asset. */
  offsetSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface AudioSegment {
  id: string;
  lineId: string;
  order: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
  speaker: string;
  createdAt: string;
  updatedAt: string;
}
