// Project SQLite schema — mirrors PRD §36. Media stays on the filesystem;
// SQLite keeps metadata only. Structured objects (DirectorPlan, states…)
// are stored as JSON text columns.

import type { Migration } from './migrate.js';

export const PROJECT_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'core',
    sql: `
CREATE TABLE story (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  logline TEXT NOT NULL DEFAULT '',
  synopsis TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sequences (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  ord INTEGER NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE story_beats (
  id TEXT PRIMARY KEY,
  sequence_id TEXT REFERENCES sequences(id) ON DELETE SET NULL,
  ord INTEGER NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  summary TEXT NOT NULL DEFAULT '',
  location TEXT,
  time_of_day TEXT,
  weather TEXT,
  characters_json TEXT NOT NULL DEFAULT '[]',
  state_change TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE shots (
  id TEXT PRIMARY KEY,
  sequence_id TEXT REFERENCES sequences(id) ON DELETE SET NULL,
  ord INTEGER NOT NULL,
  title TEXT NOT NULL,
  story_beat_id TEXT REFERENCES story_beats(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL DEFAULT '',
  shot_function TEXT NOT NULL DEFAULT 'other',
  duration_seconds REAL NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  aspect_ratio TEXT NOT NULL DEFAULT '16:9',
  h3_mode TEXT,
  primary_character_id TEXT,
  scene_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_shots_status ON shots(status);
CREATE INDEX idx_shots_ord ON shots(ord);

CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  traits_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_entities_kind ON entities(kind);

CREATE TABLE character_states (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  costume TEXT NOT NULL DEFAULT '',
  hair TEXT NOT NULL DEFAULT '',
  injury TEXT NOT NULL DEFAULT '',
  held_items_json TEXT NOT NULL DEFAULT '[]',
  extra_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_char_states_char ON character_states(character_id);

CREATE TABLE media_assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  duration_seconds REAL,
  source TEXT NOT NULL DEFAULT 'import',
  label TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_media_kind ON media_assets(kind);

CREATE TABLE reference_bindings (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  roles_json TEXT NOT NULL DEFAULT '[]',
  preserve_json TEXT NOT NULL DEFAULT '[]',
  ignore_json TEXT NOT NULL DEFAULT '[]',
  label TEXT NOT NULL DEFAULT '',
  shot_id TEXT REFERENCES shots(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_refs_asset ON reference_bindings(asset_id);
CREATE INDEX idx_refs_shot ON reference_bindings(shot_id);

CREATE TABLE director_plan_versions (
  id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  plan_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'default',
  created_at TEXT NOT NULL,
  UNIQUE (shot_id, version)
);
CREATE INDEX idx_dpv_shot ON director_plan_versions(shot_id);

CREATE TABLE prompt_versions (
  id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'manual',
  director_plan_version_id TEXT REFERENCES director_plan_versions(id) ON DELETE SET NULL,
  h3_mode TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_pv_shot ON prompt_versions(shot_id);

CREATE TABLE preflight_reports (
  id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  prompt_version_id TEXT,
  basic_json TEXT NOT NULL,
  semantic_json TEXT,
  risk TEXT NOT NULL,
  blocked INTEGER NOT NULL DEFAULT 0,
  ai_semantic_run INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE render_jobs (
  id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  prompt_version_id TEXT NOT NULL,
  director_plan_version_id TEXT,
  provider TEXT NOT NULL,
  provider_task_id TEXT,
  status TEXT NOT NULL DEFAULT 'SUBMITTING',
  submitted_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  request_snapshot_json TEXT,
  provider_response_snapshot_json TEXT,
  cost_json TEXT,
  error TEXT,
  take_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_rj_status ON render_jobs(status);
CREATE INDEX idx_rj_shot ON render_jobs(shot_id);

CREATE TABLE takes (
  id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  render_job_id TEXT NOT NULL,
  prompt_version_id TEXT NOT NULL,
  director_plan_version_id TEXT,
  local_video_path TEXT NOT NULL,
  poster_path TEXT,
  first_frame_path TEXT,
  last_frame_path TEXT,
  duration REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'candidate',
  rating INTEGER,
  failure_tags_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_takes_shot ON takes(shot_id);
CREATE INDEX idx_takes_status ON takes(status);

CREATE TABLE continuity_entries (
  id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_take_id TEXT,
  state_json TEXT,
  narrative_json TEXT,
  committed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_cont_shot ON continuity_entries(shot_id);

CREATE TABLE timeline (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT 'Timeline',
  updated_at TEXT NOT NULL
);

CREATE TABLE timeline_clips (
  id TEXT PRIMARY KEY,
  ord INTEGER NOT NULL,
  shot_id TEXT NOT NULL REFERENCES shots(id) ON DELETE CASCADE,
  take_id TEXT NOT NULL REFERENCES takes(id) ON DELETE CASCADE,
  trim_in REAL NOT NULL DEFAULT 0,
  trim_out REAL,
  transition TEXT NOT NULL DEFAULT 'cut',
  transition_duration REAL NOT NULL DEFAULT 0,
  audio_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_clips_ord ON timeline_clips(ord);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE provider_profiles (
  id TEXT PRIMARY KEY,
  profile_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
];

export const REGISTRY_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'registry',
    sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'single_shot',
  dir_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_opened_at TEXT
);
CREATE INDEX idx_projects_updated ON projects(updated_at);
`,
  },
  {
    version: 2,
    name: 'registry-kv',
    sql: `
CREATE TABLE kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
];
