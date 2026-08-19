// Migration runner. Sequential, idempotent-by-version SQL scripts.
// schema_version stores the HIGHEST applied version; migrations with
// version <= that are considered applied (they are strictly sequential).

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export function migrate(db: import('./sqlite.js').Db, migrations: Migration[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  const appliedMax = Number(db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', ['schema_version'])?.value ?? 0);
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  db.tx(() => {
    for (const m of sorted) {
      if (m.version <= appliedMax) continue;
      db.exec(m.sql);
      db.run(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [String(m.version)],
      );
    }
  });
}
