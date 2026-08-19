// Thin wrapper over node:sqlite (DatabaseSync). Keeps the rest of the app
// decoupled from the driver in case we ever swap to better-sqlite3.

import { DatabaseSync, type StatementSync } from 'node:sqlite';

export type { DatabaseSync };

export type SqlParams = Record<string, unknown> | unknown[];

type SqlValue = string | number | bigint | null | Uint8Array;

export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  prepare(sql: string): StatementSync {
    return this.raw.prepare(sql);
  }

  private norm(params: SqlParams): SqlValue[] | Record<string, SqlValue> {
    if (Array.isArray(params)) return params.map((v) => (v === undefined ? null : (v as SqlValue)));
    const out: Record<string, SqlValue> = {};
    for (const [k, v] of Object.entries(params)) out[k] = v === undefined ? null : (v as SqlValue);
    return out;
  }

  run(sql: string, params: SqlParams = {}): { lastInsertRowid: number | bigint; changes: number } {
    const stmt = this.raw.prepare(sql);
    const p = this.norm(params);
    const r = Array.isArray(p) ? stmt.run(...p) : stmt.run(p);
    return { lastInsertRowid: Number(r.lastInsertRowid), changes: Number(r.changes) };
  }

  get<T>(sql: string, params: SqlParams = {}): T | undefined {
    const stmt = this.raw.prepare(sql);
    const p = this.norm(params);
    return (Array.isArray(p) ? stmt.get(...p) : stmt.get(p)) as T | undefined;
  }

  all<T>(sql: string, params: SqlParams = {}): T[] {
    const stmt = this.raw.prepare(sql);
    const p = this.norm(params);
    return (Array.isArray(p) ? stmt.all(...p) : stmt.all(p)) as T[];
  }

  /** Run fn inside a transaction (immediate). */
  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    this.raw.close();
  }
}

// --- JSON helpers ----------------------------------------------------------

export function j<T>(value: T): string {
  return JSON.stringify(value ?? null);
}

export function jget<T>(raw: string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** JSON column → value or null (for nullable structured columns). */
export function jgetOrNull<T>(raw: string | null | undefined): T | null {
  if (raw === null || raw === undefined || raw === '') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
