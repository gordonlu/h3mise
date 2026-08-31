export interface FilmCheckIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  target: { kind: 'shot'; shotId: string } | { kind: 'timeline' } | { kind: 'timeline-clip'; clipId: string };
}

export interface FilmCheckResult {
  errors: FilmCheckIssue[];
  warnings: FilmCheckIssue[];
  canExport: boolean;
  summary: { shots: number; selectedTakes: number; timelineClips: number; filmDurationSeconds: number };
}
