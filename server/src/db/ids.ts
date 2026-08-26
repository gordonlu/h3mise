// Short, readable, per-project sequential ids: shot-001, take-003, …

import type { Db } from './sqlite.js';

export type IdKind =
  | 'story'
  | 'seq'
  | 'beat'
  | 'shot'
  | 'ent'
  | 'cstate'
  | 'media'
  | 'ref'
  | 'dpv'
  | 'prompt'
  | 'preflight'
  | 'job'
  | 'take'
  | 'cont'
  | 'clip'
  | 'export';

export function nextId(db: Db, kind: IdKind): string {
  const row = db.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', [`counter:${kind}`]);
  const next = (Number(row?.value ?? 0) + 1).toString();
  db.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    `counter:${kind}`,
    next,
  ]);
  return `${kind}-${next.padStart(3, '0')}`;
}
