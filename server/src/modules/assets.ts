// Asset module — PRD §11. Three layers, never mixed: Entity (who/what),
// CharacterState (current look), MediaAsset + ReferenceBinding (roles).
// Shot-driven requirements computed here too.

import type { CharacterState, Entity, EntityKind, MediaAsset, MediaKind, ReferenceBinding, ReferenceRole, Shot } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { j, jget } from '../db/sqlite.js';
import { nextId } from '../db/ids.js';

// --- Entities --------------------------------------------------------------

interface EntityRow {
  id: string;
  kind: string;
  name: string;
  description: string;
  notes: string;
  traits_json: string;
  created_at: string;
  updated_at: string;
}

function entityFromRow(r: EntityRow): Entity {
  return {
    id: r.id,
    kind: r.kind as EntityKind,
    name: r.name,
    description: r.description,
    notes: r.notes,
    traits: jget<Record<string, string>>(r.traits_json, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listEntities(p: ProjectContext, kind?: EntityKind): Entity[] {
  const rows = kind
    ? p.db.all<EntityRow>('SELECT * FROM entities WHERE kind = ? ORDER BY name', [kind])
    : p.db.all<EntityRow>('SELECT * FROM entities ORDER BY kind, name');
  return rows.map(entityFromRow);
}

export function getEntity(p: ProjectContext, id: string): Entity {
  const r = p.db.get<EntityRow>('SELECT * FROM entities WHERE id = ?', [id]);
  if (!r) throw new Error('entity not found');
  return entityFromRow(r);
}

export function createEntity(p: ProjectContext, input: { kind: EntityKind; name: string; description?: string; notes?: string; traits?: Record<string, string> }): Entity {
  const id = nextId(p.db, 'ent');
  const now = new Date().toISOString();
  p.db.run(
    'INSERT INTO entities (id, kind, name, description, notes, traits_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, input.kind, input.name, input.description ?? '', input.notes ?? '', j(input.traits ?? {}), now, now],
  );
  return getEntity(p, id);
}

export function updateEntity(p: ProjectContext, id: string, patch: Partial<Pick<Entity, 'name' | 'description' | 'notes' | 'traits' | 'kind'>>): Entity {
  const now = new Date().toISOString();
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    cols.push(k === 'traits' ? 'traits_json = ?' : `${k} = ?`);
    vals.push(k === 'traits' ? j(v) : v);
  }
  if (cols.length === 0) return getEntity(p, id);
  vals.push(now, id);
  p.db.run(`UPDATE entities SET ${cols.join(', ')}, updated_at = ? WHERE id = ?`, vals);
  return getEntity(p, id);
}

export function deleteEntity(p: ProjectContext, id: string): void {
  p.db.run('DELETE FROM entities WHERE id = ?', [id]);
}

// --- CharacterState --------------------------------------------------------

interface StateRow {
  id: string;
  character_id: string;
  name: string;
  costume: string;
  hair: string;
  injury: string;
  held_items_json: string;
  extra_json: string;
  created_at: string;
  updated_at: string;
}

function stateFromRow(r: StateRow): CharacterState {
  return {
    id: r.id,
    characterId: r.character_id,
    name: r.name,
    costume: r.costume,
    hair: r.hair,
    injury: r.injury,
    heldItems: jget<string[]>(r.held_items_json, []),
    extra: jget<Record<string, string>>(r.extra_json, {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listCharacterStates(p: ProjectContext, characterId?: string): CharacterState[] {
  const rows = characterId
    ? p.db.all<StateRow>('SELECT * FROM character_states WHERE character_id = ? ORDER BY name', [characterId])
    : p.db.all<StateRow>('SELECT * FROM character_states ORDER BY name');
  return rows.map(stateFromRow);
}

export function createCharacterState(
  p: ProjectContext,
  input: { characterId: string; name: string; costume?: string; hair?: string; injury?: string; heldItems?: string[]; extra?: Record<string, string> },
): CharacterState {
  const id = nextId(p.db, 'cstate');
  const now = new Date().toISOString();
  p.db.run(
    'INSERT INTO character_states (id, character_id, name, costume, hair, injury, held_items_json, extra_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      input.characterId,
      input.name,
      input.costume ?? '',
      input.hair ?? '',
      input.injury ?? '',
      j(input.heldItems ?? []),
      j(input.extra ?? {}),
      now,
      now,
    ],
  );
  return listCharacterStates(p, input.characterId).find((s) => s.id === id)!;
}

export function updateCharacterState(p: ProjectContext, id: string, patch: Partial<Pick<CharacterState, 'name' | 'costume' | 'hair' | 'injury' | 'heldItems' | 'extra'>>): CharacterState {
  const now = new Date().toISOString();
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    cols.push(k === 'heldItems' ? 'held_items_json = ?' : k === 'extra' ? 'extra_json = ?' : `${k} = ?`);
    vals.push(k === 'heldItems' || k === 'extra' ? j(v) : v);
  }
  vals.push(now, id);
  p.db.run(`UPDATE character_states SET ${cols.join(', ')}, updated_at = ? WHERE id = ?`, vals);
  const r = p.db.get<StateRow>('SELECT * FROM character_states WHERE id = ?', [id])!;
  return stateFromRow(r);
}

export function deleteCharacterState(p: ProjectContext, id: string): void {
  p.db.run('DELETE FROM character_states WHERE id = ?', [id]);
}

// --- MediaAsset ------------------------------------------------------------

interface MediaRow {
  id: string;
  kind: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  poster_path: string | null;
  source: string;
  label: string;
  tags_json: string;
  created_at: string;
}

export function mediaFromRow(r: MediaRow): MediaAsset {
  return {
    id: r.id,
    kind: r.kind as MediaKind,
    fileName: r.file_name,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes,
    width: r.width ?? undefined,
    height: r.height ?? undefined,
    durationSeconds: r.duration_seconds ?? undefined,
    posterPath: r.poster_path ?? null,
    source: r.source as MediaAsset['source'],
    label: r.label,
    tags: jget<string[]>(r.tags_json, []),
    createdAt: r.created_at,
  };
}

export function listMedia(p: ProjectContext, kind?: MediaKind): MediaAsset[] {
  const rows = kind
    ? p.db.all<MediaRow>('SELECT * FROM media_assets WHERE kind = ? ORDER BY created_at DESC', [kind])
    : p.db.all<MediaRow>('SELECT * FROM media_assets ORDER BY created_at DESC');
  return rows.map(mediaFromRow);
}

export function getMedia(p: ProjectContext, id: string): MediaAsset {
  const r = p.db.get<MediaRow>('SELECT * FROM media_assets WHERE id = ?', [id]);
  if (!r) throw new Error('media not found');
  return mediaFromRow(r);
}

export function insertMedia(
  p: ProjectContext,
  input: { id?: string; kind: MediaKind; fileName: string; mimeType: string; sizeBytes: number; width?: number; height?: number; durationSeconds?: number; posterPath?: string | null; source?: MediaAsset['source']; label?: string; tags?: string[] },
): MediaAsset {
  const id = input.id ?? nextId(p.db, 'media');
  const now = new Date().toISOString();
  p.db.run(
    'INSERT INTO media_assets (id, kind, file_name, mime_type, size_bytes, width, height, duration_seconds, poster_path, source, label, tags_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      input.kind,
      input.fileName,
      input.mimeType,
      input.sizeBytes,
      input.width ?? null,
      input.height ?? null,
      input.durationSeconds ?? null,
      input.posterPath ?? null,
      input.source ?? 'import',
      input.label ?? '',
      j(input.tags ?? []),
      now,
    ],
  );
  return getMedia(p, id);
}

export function setMediaPoster(p: ProjectContext, id: string, posterPath: string | null): MediaAsset {
  p.db.run('UPDATE media_assets SET poster_path = ? WHERE id = ?', [posterPath, id]);
  return getMedia(p, id);
}

export function updateMediaLabel(p: ProjectContext, id: string, patch: { label?: string; tags?: string[] }): MediaAsset {
  const cols: string[] = [];
  const vals: unknown[] = [];
  if (patch.label !== undefined) {
    cols.push('label = ?');
    vals.push(patch.label);
  }
  if (patch.tags !== undefined) {
    cols.push('tags_json = ?');
    vals.push(j(patch.tags));
  }
  if (cols.length) {
    vals.push(id);
    p.db.run(`UPDATE media_assets SET ${cols.join(', ')} WHERE id = ?`, vals);
  }
  return getMedia(p, id);
}

export function deleteMedia(p: ProjectContext, id: string): void {
  p.db.run('DELETE FROM media_assets WHERE id = ?', [id]);
}

// --- ReferenceBindings -----------------------------------------------------

interface RefRow {
  id: string;
  asset_id: string;
  type: string;
  roles_json: string;
  preserve_json: string;
  ignore_json: string;
  label: string;
  shot_id: string | null;
  created_at: string;
}

function refFromRow(r: RefRow): ReferenceBinding {
  return {
    id: r.id,
    assetId: r.asset_id,
    type: r.type as MediaKind,
    roles: jget<ReferenceRole[]>(r.roles_json, []),
    preserve: jget<string[]>(r.preserve_json, []),
    ignore: jget<string[]>(r.ignore_json, []),
    label: r.label,
    shotId: r.shot_id,
    createdAt: r.created_at,
  };
}

export function listBindings(p: ProjectContext, shotId?: string | null): ReferenceBinding[] {
  const rows = shotId === undefined
    ? p.db.all<RefRow>('SELECT * FROM reference_bindings ORDER BY created_at')
    : p.db.all<RefRow>('SELECT * FROM reference_bindings WHERE shot_id IS ? ORDER BY created_at', [shotId]);
  return rows.map(refFromRow);
}

export function createBinding(
  p: ProjectContext,
  input: { assetId: string; roles: ReferenceRole[]; preserve?: string[]; ignore?: string[]; label?: string; shotId?: string | null },
): ReferenceBinding {
  const asset = getMedia(p, input.assetId);
  const id = nextId(p.db, 'ref');
  const now = new Date().toISOString();
  p.db.run(
    'INSERT INTO reference_bindings (id, asset_id, type, roles_json, preserve_json, ignore_json, label, shot_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, input.assetId, asset.kind, j(input.roles), j(input.preserve ?? []), j(input.ignore ?? []), input.label ?? asset.label, input.shotId ?? null, now],
  );
  return listBindings(p, input.shotId ?? null).find((b) => b.id === id)!;
}

export function updateBinding(p: ProjectContext, id: string, patch: Partial<Pick<ReferenceBinding, 'roles' | 'preserve' | 'ignore' | 'label' | 'shotId'>>): ReferenceBinding {
  const colMap: Record<string, string> = {
    roles: 'roles_json',
    preserve: 'preserve_json',
    ignore: 'ignore_json',
    label: 'label',
    shotId: 'shot_id',
  };
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const col = colMap[k];
    if (!col) continue;
    cols.push(`${col} = ?`);
    vals.push(k === 'roles' || k === 'preserve' || k === 'ignore' ? j(v) : v);
  }
  if (cols.length) {
    vals.push(id);
    p.db.run(`UPDATE reference_bindings SET ${cols.join(', ')} WHERE id = ?`, vals);
  }
  const r = p.db.get<RefRow>('SELECT * FROM reference_bindings WHERE id = ?', [id])!;
  return refFromRow(r);
}

export function deleteBinding(p: ProjectContext, id: string): void {
  p.db.run('DELETE FROM reference_bindings WHERE id = ?', [id]);
}

// --- Shot-driven asset requirements (PRD §11) ------------------------------

export interface AssetRequirement {
  level: 'required' | 'optional' | 'ok';
  kind: 'character' | 'scene' | 'character_state' | 'first_frame' | 'last_frame' | 'ref_images' | 'audio';
  label: string;
  detail: string;
}

export function shotAssetRequirements(p: ProjectContext, shot: Shot): AssetRequirement[] {
  const out: AssetRequirement[] = [];
  const bindings = listBindings(p, shot.id);
  const roles = new Set(bindings.flatMap((b) => b.roles));
  const entities = listEntities(p);
  const states = listCharacterStates(p);
  const hasFirst = roles.has('first_frame');
  const hasLast = roles.has('last_frame');
  const hasRefImage = bindings.some((binding) => binding.type === 'image' && !binding.roles.includes('first_frame') && !binding.roles.includes('last_frame'));
  const hasRefAudio = bindings.some((binding) => binding.type === 'audio' && !binding.roles.includes('first_frame') && !binding.roles.includes('last_frame'));

  if (shot.primaryCharacterId) {
    out.push({ level: 'ok', kind: 'character', label: 'Character', detail: getEntity(p, shot.primaryCharacterId).name });
    const hasState = states.some((s) => s.characterId === shot.primaryCharacterId);
    out.push(
      hasState
        ? { level: 'ok', kind: 'character_state', label: 'CharacterState', detail: 'exists' }
        : { level: 'required', kind: 'character_state', label: 'CharacterState missing', detail: 'create a CharacterState for continuity' },
    );
  } else {
    out.push({ level: 'optional', kind: 'character', label: 'Character', detail: 'no primary character set' });
  }

  if (shot.sceneId) {
    out.push({ level: 'ok', kind: 'scene', label: 'Scene', detail: getEntity(p, shot.sceneId).name });
  } else {
    out.push({ level: 'optional', kind: 'scene', label: 'Scene', detail: 'no scene set' });
  }

  const mode = shot.h3Mode;
  if (mode === 'i2va' || mode === 'fl2va') {
    out.push(
      hasFirst
        ? { level: 'ok', kind: 'first_frame', label: 'First Frame', detail: 'bound' }
        : { level: 'required', kind: 'first_frame', label: 'First Frame missing', detail: 'I2VA/FL2VA needs a first frame' },
    );
  }
  if (mode === 'l2va' || mode === 'fl2va') {
    out.push(
      hasLast
        ? { level: 'ok', kind: 'last_frame', label: 'Last Frame', detail: 'bound' }
        : { level: 'required', kind: 'last_frame', label: 'Last Frame missing', detail: 'L2VA/FL2VA needs a last frame' },
    );
  }
  if (mode === 'ref2va') {
    out.push(
      hasRefImage
        ? { level: 'ok', kind: 'ref_images', label: 'RefImages', detail: '至少一张参考图已绑定' }
        : { level: 'required', kind: 'ref_images', label: 'RefImages missing', detail: 'Ref2VA 至少需要一张参考图' },
    );
    out.push(
      hasRefAudio
        ? { level: 'ok', kind: 'audio', label: 'RefAudios', detail: '参考音频已绑定' }
        : { level: 'optional', kind: 'audio', label: 'RefAudios', detail: '可选；必须与参考图一起使用' },
    );
  }
  return out;
}
