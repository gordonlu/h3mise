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
  image_asset_id: string | null;
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
    imageAssetId: r.image_asset_id ?? null,
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

/** Null-safe read for legacy/dangling shot references (defense in depth —
 * deleteEntity clears them, but older databases may still hold stale ids). */
function tryGetEntity(p: ProjectContext, id: string): Entity | null {
  const r = p.db.get<EntityRow>('SELECT * FROM entities WHERE id = ?', [id]);
  return r ? entityFromRow(r) : null;
}

export function createEntity(p: ProjectContext, input: { kind: EntityKind; name: string; description?: string; notes?: string; traits?: Record<string, string>; imageAssetId?: string | null }): Entity {
  assertImageAsset(p, input.imageAssetId);
  const id = nextId(p.db, 'ent');
  const now = new Date().toISOString();
  p.db.run(
    'INSERT INTO entities (id, kind, name, description, notes, traits_json, image_asset_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, input.kind, input.name, input.description ?? '', input.notes ?? '', j(input.traits ?? {}), input.imageAssetId ?? null, now, now],
  );
  return getEntity(p, id);
}

export function updateEntity(p: ProjectContext, id: string, patch: Partial<Pick<Entity, 'name' | 'description' | 'notes' | 'traits' | 'kind' | 'imageAssetId'>>): Entity {
  assertImageAsset(p, patch.imageAssetId);
  const now = new Date().toISOString();
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    cols.push(k === 'traits' ? 'traits_json = ?' : k === 'imageAssetId' ? 'image_asset_id = ?' : `${k} = ?`);
    vals.push(k === 'traits' ? j(v) : v);
  }
  if (cols.length === 0) return getEntity(p, id);
  vals.push(now, id);
  p.db.run(`UPDATE entities SET ${cols.join(', ')}, updated_at = ? WHERE id = ?`, vals);
  return getEntity(p, id);
}

export function deleteEntity(p: ProjectContext, id: string): void {
  p.db.tx(() => {
    // P0 fix: shots.primary_character_id / scene_id carry no foreign key, so
    // deleting an entity used to leave dangling ids that crashed the whole
    // shotboard / guide (getEntity threw 'entity not found'). Clear them first;
    // character_states and managed bindings cascade via their own FKs.
    p.db.run('UPDATE shots SET primary_character_id = NULL WHERE primary_character_id = ?', [id]);
    p.db.run('UPDATE shots SET scene_id = NULL WHERE scene_id = ?', [id]);
    p.db.run('DELETE FROM entities WHERE id = ?', [id]);
  });
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
  image_asset_id: string | null;
  entity_image_asset_id: string | null;
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
    imageAssetId: r.image_asset_id ?? null,
    effectiveImageAssetId: r.image_asset_id ?? r.entity_image_asset_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listCharacterStates(p: ProjectContext, characterId?: string): CharacterState[] {
  const rows = characterId
    ? p.db.all<StateRow>('SELECT cs.*, e.image_asset_id AS entity_image_asset_id FROM character_states cs JOIN entities e ON e.id = cs.character_id WHERE cs.character_id = ? ORDER BY cs.name', [characterId])
    : p.db.all<StateRow>('SELECT cs.*, e.image_asset_id AS entity_image_asset_id FROM character_states cs JOIN entities e ON e.id = cs.character_id ORDER BY cs.name');
  return rows.map(stateFromRow);
}

export function createCharacterState(
  p: ProjectContext,
  input: { characterId: string; name: string; costume?: string; hair?: string; injury?: string; heldItems?: string[]; extra?: Record<string, string>; imageAssetId?: string | null },
): CharacterState {
  assertImageAsset(p, input.imageAssetId);
  const id = nextId(p.db, 'cstate');
  const now = new Date().toISOString();
  p.db.run(
    'INSERT INTO character_states (id, character_id, name, costume, hair, injury, held_items_json, extra_json, image_asset_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id,
      input.characterId,
      input.name,
      input.costume ?? '',
      input.hair ?? '',
      input.injury ?? '',
      j(input.heldItems ?? []),
      j(input.extra ?? {}),
      input.imageAssetId ?? null,
      now,
      now,
    ],
  );
  return listCharacterStates(p, input.characterId).find((s) => s.id === id)!;
}

export function updateCharacterState(p: ProjectContext, id: string, patch: Partial<Pick<CharacterState, 'name' | 'costume' | 'hair' | 'injury' | 'heldItems' | 'extra' | 'imageAssetId'>>): CharacterState {
  assertImageAsset(p, patch.imageAssetId);
  const now = new Date().toISOString();
  const cols: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    cols.push(k === 'heldItems' ? 'held_items_json = ?' : k === 'extra' ? 'extra_json = ?' : k === 'imageAssetId' ? 'image_asset_id = ?' : `${k} = ?`);
    vals.push(k === 'heldItems' || k === 'extra' ? j(v) : v);
  }
  vals.push(now, id);
  p.db.run(`UPDATE character_states SET ${cols.join(', ')}, updated_at = ? WHERE id = ?`, vals);
  const r = p.db.get<StateRow>('SELECT cs.*, e.image_asset_id AS entity_image_asset_id FROM character_states cs JOIN entities e ON e.id = cs.character_id WHERE cs.id = ?', [id])!;
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

function assertImageAsset(p: ProjectContext, id: string | null | undefined): void {
  if (!id) return;
  if (getMedia(p, id).kind !== 'image') throw new Error('entity and character state images must reference an image asset');
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

export function deleteMedia(p: ProjectContext, id: string): MediaAsset {
  const asset = getMedia(p, id);
  // Deletion guard: refuse when anything still references the asset, so a
  // stray click in Assets cannot silently break bindings or Frame Bridge.
  const usage = mediaUsage(p, id);
  const parts: string[] = [];
  if (usage.bindings > 0) parts.push(`${usage.bindings} 个参考绑定`);
  if (usage.entities > 0) parts.push(`${usage.entities} 个实体主图`);
  if (usage.states > 0) parts.push(`${usage.states} 个角色状态`);
  if (asset.source === 'frame_extract') {
    const cited =
      p.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM takes WHERE first_frame_path = ? OR last_frame_path = ?', [
        asset.fileName,
        asset.fileName,
      ])?.n ?? 0;
    if (cited > 0) parts.push(`${cited} 个 Take 帧（尾帧桥接依赖）`);
  }
  if (parts.length > 0) {
    throw new Error(`资产正在被${parts.join('、')}使用，请先解除引用再删除`);
  }
  p.db.run('DELETE FROM media_assets WHERE id = ?', [id]);
  return asset;
}

export function mediaUsage(p: ProjectContext, id: string): { bindings: number; entities: number; states: number } {
  return {
    bindings: p.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM reference_bindings WHERE asset_id = ?', [id])?.n ?? 0,
    entities: p.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM entities WHERE image_asset_id = ?', [id])?.n ?? 0,
    states: p.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM character_states WHERE image_asset_id = ?', [id])?.n ?? 0,
  };
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
  source_entity_id: string | null;
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
    sourceEntityId: r.source_entity_id ?? null,
    createdAt: r.created_at,
  };
}

export function listBindings(p: ProjectContext, shotId?: string | null): ReferenceBinding[] {
  const rows = shotId === undefined
    ? p.db.all<RefRow>('SELECT * FROM reference_bindings ORDER BY created_at, id')
    : p.db.all<RefRow>('SELECT * FROM reference_bindings WHERE shot_id IS ? ORDER BY created_at, id', [shotId]);
  return rows.map(refFromRow);
}

export function createBinding(
  p: ProjectContext,
  input: { assetId: string; roles: ReferenceRole[]; preserve?: string[]; ignore?: string[]; label?: string; shotId?: string | null; sourceEntityId?: string | null },
): ReferenceBinding {
  const asset = getMedia(p, input.assetId);
  const id = nextId(p.db, 'ref');
  const now = new Date().toISOString();
  p.db.run(
    'INSERT INTO reference_bindings (id, asset_id, type, roles_json, preserve_json, ignore_json, label, shot_id, source_entity_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, input.assetId, asset.kind, j(input.roles), j(input.preserve ?? []), j(input.ignore ?? []), input.label ?? asset.label, input.shotId ?? null, input.sourceEntityId ?? null, now],
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

/**
 * Ref2VA consumes the visual identity selected on the shot. Keep the primary
 * character and scene entity images in the shot's generic reference list so
 * prompt compilation, preflight and provider submission all see one source
 * of truth. Existing user bindings are preserved and assets are deduplicated.
 */
export function ensureShotEntityImageBindings(
  p: ProjectContext,
  shot: Shot,
  mode: Shot['h3Mode'] = shot.h3Mode,
): { bindings: ReferenceBinding[]; added: ReferenceBinding[] } {
  if (mode !== 'ref2va') return { bindings: listBindings(p, shot.id), added: [] };

  const added: ReferenceBinding[] = [];
  const selectedEntityIds = new Set([shot.primaryCharacterId, shot.sceneId].filter((id): id is string => Boolean(id)));
  for (const binding of listBindings(p, shot.id)) {
    if (binding.sourceEntityId && !selectedEntityIds.has(binding.sourceEntityId)) deleteBinding(p, binding.id);
  }
  let current = listBindings(p, shot.id);
  const genericAssetIds = new Set(
    current
      .filter((binding) => !binding.roles.includes('first_frame') && !binding.roles.includes('last_frame'))
      .map((binding) => binding.assetId),
  );
  const selected = [
    { id: shot.primaryCharacterId, role: 'identity' as const },
    { id: shot.sceneId, role: 'environment' as const },
  ];

  for (const item of selected) {
    if (!item.id) continue;
    const entity = tryGetEntity(p, item.id);
    if (!entity) continue;
    const managed = current.find((binding) => binding.sourceEntityId === entity.id);
    if (managed && managed.assetId !== entity.imageAssetId) {
      deleteBinding(p, managed.id);
      current = current.filter((binding) => binding.id !== managed.id);
      genericAssetIds.delete(managed.assetId);
    }
    if (!entity.imageAssetId || genericAssetIds.has(entity.imageAssetId)) {
      const existing = entity.imageAssetId
        ? current.find((binding) => binding.assetId === entity.imageAssetId && !binding.roles.includes('first_frame') && !binding.roles.includes('last_frame'))
        : null;
      if (existing && !existing.sourceEntityId) {
        p.db.run('UPDATE reference_bindings SET source_entity_id = ? WHERE id = ?', [entity.id, existing.id]);
        current = listBindings(p, shot.id);
      }
      continue;
    }
    const asset = getMedia(p, entity.imageAssetId);
    if (asset.kind !== 'image') continue;
    const binding = createBinding(p, {
      assetId: asset.id,
      roles: [item.role],
      label: asset.label || `${entity.name} · 主图`,
      shotId: shot.id,
      sourceEntityId: entity.id,
    });
    added.push(binding);
    genericAssetIds.add(asset.id);
  }

  return { bindings: listBindings(p, shot.id), added };
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
  const hasRefImage = bindings.some((binding) => binding.type === 'image');
  const hasRefAudio = bindings.some((binding) => binding.type === 'audio' && !binding.roles.includes('first_frame') && !binding.roles.includes('last_frame'));

  if (shot.primaryCharacterId) {
    const character = tryGetEntity(p, shot.primaryCharacterId);
    if (!character) {
      out.push({ level: 'optional', kind: 'character', label: 'Character', detail: 'referenced character no longer exists' });
    } else {
      out.push({ level: 'ok', kind: 'character', label: 'Character', detail: character.name });
      const hasState = states.some((s) => s.characterId === shot.primaryCharacterId);
      out.push(
        hasState
          ? { level: 'ok', kind: 'character_state', label: 'CharacterState', detail: 'exists' }
          : { level: 'required', kind: 'character_state', label: 'CharacterState missing', detail: 'create a CharacterState for continuity' },
      );
    }
  } else {
    out.push({ level: 'optional', kind: 'character', label: 'Character', detail: 'no primary character set' });
  }

  if (shot.sceneId) {
    const scene = tryGetEntity(p, shot.sceneId);
    out.push(
      scene
        ? { level: 'ok', kind: 'scene', label: 'Scene', detail: scene.name }
        : { level: 'optional', kind: 'scene', label: 'Scene', detail: 'referenced scene no longer exists' },
    );
  } else {
    out.push({ level: 'optional', kind: 'scene', label: 'Scene', detail: 'no scene set' });
  }

  const mode = shot.h3Mode;
  if (mode === 'i2va' || mode === 'fl2va') {
    out.push(
      hasFirst
        ? { level: 'ok', kind: 'first_frame', label: 'First Frame', detail: '首帧已绑定' }
        : { level: 'required', kind: 'first_frame', label: 'First Frame missing', detail: 'I2VA 必须指定首帧专用图；不会使用实体主图或 RefImage' },
    );
  }
  if (mode === 'l2va' || mode === 'fl2va') {
    out.push(
      hasLast
        ? { level: 'ok', kind: 'last_frame', label: 'Last Frame', detail: '尾帧已绑定' }
        : { level: 'required', kind: 'last_frame', label: 'Last Frame missing', detail: 'L2VA 必须指定尾帧专用图；不会使用实体主图或 RefImage' },
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
