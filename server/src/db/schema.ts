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
  render_job_id TEXT NOT NULL UNIQUE,
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
  {
    version: 2,
    name: 'media-poster',
    sql: `
ALTER TABLE media_assets ADD COLUMN poster_path TEXT;
`,
  },
  {
    version: 3,
    name: 'render-invariants',
    sql: `
ALTER TABLE render_jobs ADD COLUMN project_id TEXT;
CREATE UNIQUE INDEX uq_take_render_job ON takes(render_job_id);
`,
  },
  {
    version: 4,
    name: 'render-intent-hash',
    sql: `
ALTER TABLE render_jobs ADD COLUMN render_intent_hash TEXT;
`,
  },
  {
    version: 5,
    name: 'take-invariants',
    sql: `
-- One selected take per shot, enforced in the DB (P1). Existing duplicates
-- (if any) are downgraded to candidate keeping the newest selection.
-- NB: MAX(id) is lexicographic over ids like take-001; it misorders beyond
-- 999 takes. Acceptable for a one-time migration (multiple simultaneous
-- selected rows were themselves a bug); do not copy this pattern.
UPDATE takes SET status = 'candidate'
  WHERE status = 'selected'
    AND id NOT IN (SELECT MAX(id) FROM takes WHERE status = 'selected' GROUP BY shot_id);
CREATE UNIQUE INDEX uq_take_selected ON takes(shot_id) WHERE status = 'selected';
`,
  },
  {
    version: 6,
    name: 'merge-logline-into-synopsis',
    sql: `
-- Merge logline into synopsis (logline field removed), then drop the column.
UPDATE story SET synopsis = logline || '\n\n' || synopsis
  WHERE logline != '' AND synopsis != '';
UPDATE story SET synopsis = logline WHERE logline != '' AND synopsis = '';
ALTER TABLE story DROP COLUMN logline;
`,
  },
  {
    version: 7,
    name: 'story-duration-plan',
    sql: `
-- Story total-duration plan + per-beat duration for AI breakdown.
ALTER TABLE story ADD COLUMN planned_duration_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE story_beats ADD COLUMN duration_seconds INTEGER NOT NULL DEFAULT 5;
`,
  },
  {
    version: 8,
    name: 'entity-state-images',
    sql: `
-- Entities own a default image; CharacterState may override it. Deleting a
-- media asset safely falls back to no image / the entity image.
ALTER TABLE entities ADD COLUMN image_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL;
ALTER TABLE character_states ADD COLUMN image_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL;
`,
  },
  {
    version: 9,
    name: 'reference-binding-entity-source',
    sql: `
-- Track bindings maintained from a shot's selected entity images so changing
-- the character, scene or entity image cannot leave stale references behind.
ALTER TABLE reference_bindings ADD COLUMN source_entity_id TEXT REFERENCES entities(id) ON DELETE CASCADE;
CREATE INDEX idx_refs_source_entity ON reference_bindings(source_entity_id);
`,
  },
  {
    version: 10,
    name: 'timeline-exports',
    sql: `
-- Export jobs are process-local, but completed films must survive refreshes
-- and restarts as project artifacts.
CREATE TABLE timeline_exports (
  id TEXT PRIMARY KEY,
  rel_path TEXT NOT NULL UNIQUE,
  duration_seconds REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_timeline_exports_created ON timeline_exports(created_at);
`,
  },
  {
    version: 11,
    name: 'imported-take-provenance',
    sql: `
-- A Take may originate from an H3Mise render or an externally generated
-- video imported into a Shot. Existing rows remain render Takes.
ALTER TABLE takes ADD COLUMN source TEXT NOT NULL DEFAULT 'render';
ALTER TABLE takes ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{}';
`,
  },
  {
    version: 12,
    name: 'shot-render-dependencies',
    sql: `
-- Shot order is editorial order, not necessarily a render dependency. Keep
-- the generation relationship explicit so independent shots can run in
-- parallel while frame-bridged shots wait for the selected upstream Take.
ALTER TABLE shots ADD COLUMN render_dependency_mode TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE shots ADD COLUMN depends_on_shot_id TEXT REFERENCES shots(id) ON DELETE SET NULL;
CREATE INDEX idx_shots_render_dependency ON shots(depends_on_shot_id);
`,
  },
  {
    version: 13,
    name: 'preflight-provider-identity',
    sql: `
-- A batch may switch Provider profiles. Never reuse a green Preflight from a
-- different backend as proof that the current backend is ready.
ALTER TABLE preflight_reports ADD COLUMN provider_id TEXT;
CREATE INDEX idx_preflight_provider ON preflight_reports(shot_id, prompt_version_id, provider_id);
`,
  },
  {
    version: 14,
    name: 'auto-produce-runs',
    sql: `
-- Persist only orchestration checkpoints. Story, beats, shots, prompts,
-- render jobs, takes and timeline remain the canonical production data.
CREATE TABLE auto_produce_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'preparing',
  settings_json TEXT NOT NULL DEFAULT '{}',
  shots_json TEXT NOT NULL DEFAULT '[]',
  current_step TEXT NOT NULL DEFAULT '',
  export_rel_path TEXT,
  export_duration_seconds REAL,
  error TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_auto_produce_status ON auto_produce_runs(status);
`,
  },
  {
    version: 15,
    name: 'optional-storyboards',
    sql: `
-- Storyboard is an optional visual approval layer. Text plans are free;
-- generated images and jobs are explicit, versioned project artifacts.
CREATE TABLE storyboards (
  id TEXT PRIMARY KEY,
  panel_count INTEGER NOT NULL CHECK (panel_count IN (3, 6, 9)),
  status TEXT NOT NULL DEFAULT 'draft',
  source_duration_seconds REAL NOT NULL DEFAULT 0,
  sheet_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  prompt TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE storyboard_panels (
  id TEXT PRIMARY KEY,
  storyboard_id TEXT NOT NULL REFERENCES storyboards(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (storyboard_id, ord)
);
CREATE INDEX idx_storyboard_panels_storyboard ON storyboard_panels(storyboard_id, ord);

CREATE TABLE storyboard_panel_versions (
  id TEXT PRIMARY KEY,
  panel_id TEXT NOT NULL REFERENCES storyboard_panels(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  asset_id TEXT NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'sheet_split',
  created_at TEXT NOT NULL,
  UNIQUE (panel_id, version)
);

CREATE TABLE storyboard_jobs (
  id TEXT PRIMARY KEY,
  storyboard_id TEXT NOT NULL REFERENCES storyboards(id) ON DELETE CASCADE,
  panel_id TEXT REFERENCES storyboard_panels(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('sheet', 'panel')),
  provider_task_id TEXT,
  status TEXT NOT NULL DEFAULT 'SUBMITTING',
  request_json TEXT NOT NULL DEFAULT '{}',
  response_json TEXT,
  cost_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_storyboard_jobs_active ON storyboard_jobs(storyboard_id, status, created_at);
`,
  },
  {
    version: 16,
    name: 'storyboard-pages',
    sql: `
ALTER TABLE storyboards ADD COLUMN series_id TEXT NOT NULL DEFAULT '';
ALTER TABLE storyboards ADD COLUMN page_number INTEGER NOT NULL DEFAULT 1;
ALTER TABLE storyboards ADD COLUMN source_start_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE storyboards ADD COLUMN source_end_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE storyboards ADD COLUMN source_segment_count INTEGER NOT NULL DEFAULT 0;
UPDATE storyboards SET series_id = id WHERE series_id = '';
CREATE INDEX idx_storyboards_series_page ON storyboards(series_id, page_number);
`,
  },
  {
    version: 17,
    name: 'camera-planning',
    sql: `
-- Screen direction: a deterministic editorial constraint the compiler can use
-- and preflight can compare against the previous shot. intentional_reversal
-- dissolves the reversal warning (deliberate cut on the 180° rule).
ALTER TABLE shots ADD COLUMN screen_direction TEXT NOT NULL DEFAULT 'neutral';
ALTER TABLE shots ADD COLUMN intentional_reversal INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_shots_screen_dir ON shots(screen_direction);

-- Camera planner / start-end framing plans (one active plan per shot).
CREATE TABLE camera_plans (
  id TEXT PRIMARY KEY,
  shot_id TEXT NOT NULL UNIQUE REFERENCES shots(id) ON DELETE CASCADE,
  plan_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
  {
    version: 3,
    name: 'provider-profile',
    sql: `
CREATE TABLE provider_profiles (
  id TEXT PRIMARY KEY,
  profile_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
];
