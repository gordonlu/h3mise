// Project store: global registry + current project lifecycle + storage layout.

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ProjectConfig, ProjectFormat, ProjectMeta } from '@h3mise/shared';
import { Db, jget } from './db/sqlite.js';
import { migrate } from './db/migrate.js';
import { PROJECT_MIGRATIONS, REGISTRY_MIGRATIONS } from './db/schema.js';

export const PROJECT_SUFFIX = '.h3studio';

export interface ProjectPaths {
  root: string;
  assets: string;
  cache: string;
  timeline: string;
  exports: string;
  shotDir: (shotId: string) => string;
  shotFrames: (shotId: string) => string;
  shotPrompts: (shotId: string) => string;
  shotTakes: (shotId: string) => string;
  shotExports: (shotId: string) => string;
}

export class ProjectContext {
  readonly db: Db;
  readonly root: string;
  readonly meta: ProjectMeta;
  config: ProjectConfig;
  readonly paths: ProjectPaths;
  private leases = 0;
  private closeRequested = false;
  private closed = false;

  constructor(db: Db, meta: ProjectMeta, config: ProjectConfig) {
    this.db = db;
    this.meta = meta;
    this.config = config;
    this.root = meta.dirPath;
    const p = (rel: string) => resolve(this.root, rel);
    this.paths = {
      root: this.root,
      assets: p('assets'),
      cache: p('cache'),
      timeline: p('timeline'),
      exports: p('exports'),
      shotDir: (id) => p(join('shots', id)),
      shotFrames: (id) => p(join('shots', id, 'frames')),
      shotPrompts: (id) => p(join('shots', id, 'prompts')),
      shotTakes: (id) => p(join('shots', id, 'takes')),
      shotExports: (id) => p(join('shots', id, 'exports')),
    };
  }

  /** Resolve a stored relative path, refusing traversal outside the project. */
  resolveProjectPath(rel: string): string {
    const abs = resolve(this.root, rel);
    // Use path.relative (not string prefix): on Windows the root may not end
    // with '/' and a prefix test would reject legitimate project files.
    const relFromRoot = relative(this.root, abs);
    if (relFromRoot.startsWith('..') || isAbsolute(relFromRoot)) {
      throw new Error('path escapes project root');
    }
    return abs;
  }

  retain(): void {
    if (this.closed || this.closeRequested) throw new Error('project context is closing');
    this.leases++;
  }

  release(): void {
    if (this.leases > 0) this.leases--;
    if (this.leases === 0 && this.closeRequested) this.closeNow();
  }

  close(): void {
    if (this.closed) return;
    if (this.leases > 0) {
      this.closeRequested = true;
      return;
    }
    this.closeNow();
  }

  private closeNow(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}

export interface CreateProjectInput {
  title: string;
  format: ProjectFormat;
  defaultAspectRatio?: string;
  visualStyle?: string;
  defaultDurationSeconds?: number;
}

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'project';
}

export class ProjectStore {
  readonly registry: Db;
  readonly projectsDir: string;
  current: ProjectContext | null = null;

  constructor(registry: Db, projectsDir: string) {
    this.registry = registry;
    this.projectsDir = projectsDir;
  }

  async list(): Promise<ProjectMeta[]> {
    return this.registry.all<ProjectMeta>(
      'SELECT id, title, format, dir_path as dirPath, created_at as createdAt, updated_at as updatedAt, last_opened_at as lastOpenedAt FROM projects ORDER BY updated_at DESC',
    );
  }

  async get(id: string): Promise<ProjectMeta | undefined> {
    return this.registry.get<ProjectMeta>(
      'SELECT id, title, format, dir_path as dirPath, created_at as createdAt, updated_at as updatedAt, last_opened_at as lastOpenedAt FROM projects WHERE id = ?',
      [id],
    );
  }

  async create(input: CreateProjectInput): Promise<ProjectMeta> {
    const id = 'proj-' + randomBytes(4).toString('hex');
    const dir = join(this.projectsDir, `${slugify(input.title)}-${id.slice(5)}${PROJECT_SUFFIX}`);
    await mkdir(dir, { recursive: true });
    for (const sub of ['assets', 'cache', 'timeline', 'exports', 'shots']) {
      await mkdir(join(dir, sub), { recursive: true });
    }
    const now = new Date().toISOString();
    const config: ProjectConfig = {
      title: input.title,
      format: input.format,
      default_aspect_ratio: input.defaultAspectRatio ?? '16:9',
      visual_style: input.visualStyle ?? '',
      default_provider: 'runninghub',
      default_video_model: 'minimax_h3',
      default_duration_seconds: input.defaultDurationSeconds ?? 5,
    };
    const meta: ProjectMeta = {
      id,
      title: input.title,
      format: input.format,
      dirPath: dir,
      createdAt: now,
      updatedAt: now,
    };
    await writeFile(join(dir, 'project.json'), JSON.stringify(config, null, 2), 'utf8');
    const db = new Db(join(dir, 'project.db'));
    migrate(db, PROJECT_MIGRATIONS);
    db.exec(`INSERT INTO story (id, title, created_at, updated_at) VALUES ('story-001', '', '${now}', '${now}')`);
    db.exec(`INSERT INTO timeline (id, title, updated_at) VALUES ('timeline-001', 'Timeline', '${now}')`);
    db.close();
    this.registry.run(
      'INSERT INTO projects (id, title, format, dir_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, input.title, input.format, dir, now, now],
    );
    return meta;
  }

  async open(id: string): Promise<ProjectContext> {
    const meta = await this.get(id);
    if (!meta) throw new Error('project not found');
    const config = await this.readConfig(meta.dirPath);
    const db = new Db(join(meta.dirPath, 'project.db'));
    migrate(db, PROJECT_MIGRATIONS);
    this.registry.run('UPDATE projects SET last_opened_at = ? WHERE id = ?', [new Date().toISOString(), id]);
    const ctx = new ProjectContext(db, meta, config);
    this.current?.close();
    this.current = ctx;
    return ctx;
  }

  /**
   * Open a project DB WITHOUT touching `current` or last_opened_at. Used for
   * read-only statistics and for the render queue (jobs must never depend on
   * which project the UI happens to have open). Caller owns the context and
   * must close() it when done.
   */
  async openDetached(id: string): Promise<ProjectContext> {
    const meta = await this.get(id);
    if (!meta) throw new Error('project not found');
    const config = await this.readConfig(meta.dirPath);
    const db = new Db(join(meta.dirPath, 'project.db'));
    migrate(db, PROJECT_MIGRATIONS);
    return new ProjectContext(db, meta, config);
  }

  async readConfig(dirPath: string): Promise<ProjectConfig> {
    // P2: per-field merge over defaults. The old all-or-nothing fallback
    // (missing/falsy default_duration_seconds ⇒ discard the WHOLE user config)
    // silently reset titles and styles; a half-written file now keeps its
    // good fields instead.
    let raw: Partial<ProjectConfig> = {};
    try {
      raw = jget<Partial<ProjectConfig>>(await readFile(join(dirPath, 'project.json'), 'utf8'), {});
    } catch {
      /* missing/unreadable file — fall through to defaults */
    }
    const duration = Number(raw.default_duration_seconds);
    return {
      title: typeof raw.title === 'string' && raw.title ? raw.title : DEFAULT_CONFIG.title,
      format: raw.format ?? DEFAULT_CONFIG.format,
      default_aspect_ratio: typeof raw.default_aspect_ratio === 'string' && raw.default_aspect_ratio
        ? raw.default_aspect_ratio
        : DEFAULT_CONFIG.default_aspect_ratio,
      visual_style: typeof raw.visual_style === 'string' ? raw.visual_style : DEFAULT_CONFIG.visual_style,
      default_provider: typeof raw.default_provider === 'string' && raw.default_provider
        ? raw.default_provider
        : DEFAULT_CONFIG.default_provider,
      default_video_model: typeof raw.default_video_model === 'string' && raw.default_video_model
        ? raw.default_video_model
        : DEFAULT_CONFIG.default_video_model,
      default_duration_seconds: Number.isFinite(duration) && duration > 0 ? duration : DEFAULT_CONFIG.default_duration_seconds,
    };
  }

  async saveConfig(context?: ProjectContext): Promise<void> {
    const p = context ?? this.current;
    if (!p) throw new Error('no project open');
    await writeFile(join(p.root, 'project.json'), JSON.stringify(p.config, null, 2), 'utf8');
    const now = new Date().toISOString();
    this.registry.run('UPDATE projects SET title = ?, format = ?, updated_at = ? WHERE id = ?', [
      p.config.title,
      p.config.format,
      now,
      p.meta.id,
    ]);
  }

  async delete(id: string): Promise<void> {
    const meta = await this.get(id);
    if (!meta) return;
    if (this.current?.meta.id === id) {
      this.current.close();
      this.current = null;
    }
    this.registry.run('DELETE FROM projects WHERE id = ?', [id]);
    await import('node:fs/promises').then((fs) => fs.rm(meta.dirPath, { recursive: true, force: true }));
  }

  /** Projects present on disk but missing from the registry. */
  async scanProjectsDir(): Promise<ProjectMeta[]> {
    const found: ProjectMeta[] = [];
    let entries: string[];
    try {
      entries = await readdir(this.projectsDir, { withFileTypes: true }).then((e) =>
        e.filter((d) => d.isDirectory() && d.name.endsWith(PROJECT_SUFFIX)).map((d) => d.name),
      );
    } catch {
      return found;
    }
    for (const name of entries) {
      const dirPath = join(this.projectsDir, name);
      const config = await this.readConfig(dirPath);
      const existing = this.registry.get<{ id: string }>('SELECT id FROM projects WHERE dir_path = ?', [dirPath]);
      if (existing) continue;
      const id = 'proj-' + randomBytes(4).toString('hex');
      const now = new Date().toISOString();
      const meta: ProjectMeta = { id, title: config.title || name, format: config.format, dirPath, createdAt: now, updatedAt: now };
      this.registry.run('INSERT INTO projects (id, title, format, dir_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [
        id,
        meta.title,
        meta.format,
        dirPath,
        now,
        now,
      ]);
      found.push(meta);
    }
    return found;
  }
}

const DEFAULT_CONFIG: ProjectConfig = {
  title: 'Untitled',
  format: 'single_shot',
  default_aspect_ratio: '16:9',
  visual_style: '',
  default_provider: 'runninghub',
  default_video_model: 'minimax_h3',
  default_duration_seconds: 5,
};

export async function openRegistry(config: { home: string }): Promise<{ registry: Db; store: ProjectStore }> {
  const dir = resolve(config.home);
  await mkdir(dir, { recursive: true });
  await mkdir(join(dir, 'projects'), { recursive: true });
  const registry = new Db(join(dir, 'registry.db'));
  migrate(registry, REGISTRY_MIGRATIONS);
  const store = new ProjectStore(registry, join(dir, 'projects'));
  await store.scanProjectsDir();
  return { registry, store };
}
