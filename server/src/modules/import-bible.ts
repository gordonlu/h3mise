// h3mise-bible@1 importer — one-shot project creation from an external
// "story bible" JSON (story structure / character cards / worldview /
// visual direction / reference material fields).
//
// Format spec: .doc/bible-import-format.md. Contract highlights:
//  - always creates a NEW project (re-import ⇒ new project, no upsert);
//  - never hard-fails on per-item problems — collect warnings instead;
//  - media is COPIED into the project assets dir (local-first), v1 accepts
//    local absolute paths only.

import type { BeatCategory, EntityKind, ReferenceRole } from '@h3mise/shared';
import type { Ffmpeg } from '../ffmpeg.js';
import type { ProjectContext, ProjectStore } from '../project-store.js';
import { createCharacterState, createEntity, updateEntity, updateMediaLabel } from './assets.js';
import { importPath } from './media.js';
import { createBeat, createSequence, updateStory } from './story.js';

export const BIBLE_FORMAT = 'h3mise-bible@1';
const WORLDVIEW_MARKER = '## 世界观';

const ENTITY_KINDS = new Set<EntityKind>(['character', 'scene', 'prop', 'vehicle', 'creature']);
const REF_ROLES = new Set<ReferenceRole>([
  'identity', 'costume', 'environment', 'motion', 'body_motion', 'timing',
  'camera_motion', 'lighting', 'style', 'audio', 'first_frame', 'last_frame',
]);
const BEAT_CATEGORIES = new Set<BeatCategory>(['setup', 'inciting_incident', 'rising_action', 'climax', 'falling_action', 'resolution', 'transition', 'other']);

export class BibleFormatError extends Error {}

export interface BibleImportResult {
  projectId: string;
  title: string;
  stats: { entities: number; states: number; sequences: number; beats: number; media: number };
  warnings: string[];
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read an object field as an object (null otherwise). */
function objOf(src: Obj | undefined, key: string): Obj | undefined {
  const v = src?.[key];
  return isObj(v) ? v : undefined;
}

/** Read a value as an array of objects. */
function arrOfObj(v: unknown): Obj[] {
  return Array.isArray(v) ? v.filter(isObj) : [];
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

/** Coerce primitive values into a string→string record (objects/arrays dropped). */
function stringRecord(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isObj(v)) return out;
  for (const [k, val] of Object.entries(v)) {
    if (val === null || val === undefined) continue;
    if (typeof val === 'object') continue;
    out[k] = String(val);
  }
  return out;
}

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : [];
}

async function importLocalAsset(
  p: ProjectContext,
  ffmpeg: Ffmpeg,
  path: string,
  label: string,
  tags: string[],
  warnings: string[],
): Promise<string | null> {
  try {
    const asset = await importPath(p, ffmpeg, { path, label });
    if (tags.length) await updateMediaLabel(p, asset.id, { tags });
    return asset.id;
  } catch (e) {
    warnings.push(`素材导入失败（${label}）: ${path} — ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

interface CreatedEntities {
  byKey: Map<string, string>; // kind/name → id
  byName: Map<string, string>; // name → id (first wins; beat resolution)
  count: number;
}

async function createBibleEntities(
  p: ProjectContext,
  ffmpeg: Ffmpeg,
  entries: Obj[],
  defaultKind: EntityKind,
  warnings: string[],
  stats: BibleImportResult['stats'],
): Promise<CreatedEntities> {
  const out: CreatedEntities = { byKey: new Map(), byName: new Map(), count: 0 };
  for (const [index, entry] of entries.entries()) {
    const where = `entities[${index}]`;
    const kindRaw = str(entry.kind) ?? defaultKind;
    if (!ENTITY_KINDS.has(kindRaw as EntityKind)) {
      warnings.push(`${where}: 未知实体类型 "${kindRaw}"，已跳过`);
      continue;
    }
    const kind = kindRaw as EntityKind;
    const name = str(entry.name);
    if (!name) {
      warnings.push(`${where}: 缺少 name，已跳过`);
      continue;
    }
    const key = `${kind}/${name}`;
    if (out.byKey.has(key)) {
      warnings.push(`${where}: 实体重复（${kind}/${name}），后者已跳过`);
      continue;
    }
    const entity = createEntity(p, {
      kind,
      name,
      description: str(entry.description) ?? '',
      notes: str(entry.notes) ?? '',
      traits: stringRecord(entry.traits),
    });
    out.byKey.set(key, entity.id);
    if (!out.byName.has(name)) out.byName.set(name, entity.id);
    out.count++;
    stats.entities++;

    // Main image → binds to the entity once successfully imported.
    const imagePath = str(entry.image);
    if (imagePath) {
      const assetId = await importLocalAsset(p, ffmpeg, imagePath, `${name} · 主图`, [name], warnings);
      if (assetId) {
        stats.media++;
        try {
          updateEntity(p, entity.id, { imageAssetId: assetId });
        } catch (e) {
          warnings.push(`${where}: 主图绑定失败 — ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    // Extra reference material: registered + tagged, NOT bound to any shot.
    for (const [refIndex, ref] of arrOfObj(entry.references).entries()) {
      const path = str(ref.path);
      if (!path) {
        warnings.push(`${where}.references[${refIndex}]: 缺少 path，已跳过`);
        continue;
      }
      const roleRaw = str(ref.role);
      const role = roleRaw && REF_ROLES.has(roleRaw as ReferenceRole) ? (roleRaw as ReferenceRole) : undefined;
      if (roleRaw && !role) warnings.push(`${where}.references[${refIndex}]: 未知角色 "${roleRaw}"，按无角色处理`);
      const label = str(ref.label) ?? `${name} · ${role ?? '参考素材'}`;
      const tags = role ? [name, `role:${role}`] : [name];
      if (await importLocalAsset(p, ffmpeg, path, label, tags, warnings)) stats.media++;
    }

    // Character states (only meaningful for characters).
    const states = arrOfObj(entry.states);
    if (states.length && kind !== 'character') {
      warnings.push(`${where}: 类型 ${kind} 不支持 states，已忽略`);
    }
    for (const [stateIndex, state] of states.entries()) {
      if (kind !== 'character') break;
      const stateName = str(state.name) ?? `状态 ${stateIndex + 1}`;
      let stateImageId: string | null = null;
      const stateImagePath = str(state.image);
      if (stateImagePath) {
        stateImageId = await importLocalAsset(p, ffmpeg, stateImagePath, `${name} · ${stateName}`, [name], warnings);
        if (stateImageId) stats.media++;
      }
      try {
        createCharacterState(p, {
          characterId: entity.id,
          name: stateName,
          costume: str(state.costume) ?? '',
          hair: str(state.hair) ?? '',
          injury: str(state.injury) ?? '',
          heldItems: stringArray(state.heldItems),
          extra: stringRecord(state.extra),
          imageAssetId: stateImageId,
        });
        stats.states++;
      } catch (e) {
        warnings.push(`${where}.states[${stateIndex}]: 创建失败 — ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  return out;
}

/**
 * Import a bible JSON into a brand-new project. Throws BibleFormatError for
 * structural problems; everything else degrades into warnings.
 */
export async function importBible(store: ProjectStore, ffmpeg: Ffmpeg, raw: unknown): Promise<BibleImportResult> {
  if (!isObj(raw)) throw new BibleFormatError('导入内容必须是 JSON 对象');
  if (raw.format !== BIBLE_FORMAT) throw new BibleFormatError(`format 必须为 "${BIBLE_FORMAT}"`);
  const story = objOf(raw, 'story');
  const title = str(story?.title);
  if (!title) throw new BibleFormatError('story.title 必填（同时用作项目名）');

  const warnings: string[] = [];
  const stats: BibleImportResult['stats'] = { entities: 0, states: 0, sequences: 0, beats: 0, media: 0 };

  // 1) Fresh project (title from the bible). 'story' format fits a bible:
  // it carries the full narrative plus beats.
  const meta = await store.create({ title, format: 'story' });
  const p = await store.open(meta.id);

  try {
    // 2) Visual direction → project defaults BEFORE anything that reads them.
    const visual = objOf(raw, 'visualDirection');
    const aspectRatio = str(visual?.aspectRatio);
    const durationRaw = Number(visual?.defaultDurationSeconds);
    if (visual?.style !== undefined) p.config.visual_style = typeof visual.style === 'string' ? visual.style.trim() : '';
    if (aspectRatio) p.config.default_aspect_ratio = aspectRatio;
    if (Number.isFinite(durationRaw) && durationRaw > 0) p.config.default_duration_seconds = Math.round(durationRaw);

    // 3) Entities (characters/scenes/props…) + optional worldview locations.
    const created = await createBibleEntities(p, ffmpeg, arrOfObj(raw.entities), 'prop', warnings, stats);

    const sceneEntries = arrOfObj(objOf(raw, 'worldview')?.locations).map((loc) => ({ ...loc, kind: 'scene' }));
    if (sceneEntries.length) {
      const createdScenes = await createBibleEntities(p, ffmpeg, sceneEntries, 'scene', warnings, stats);
      for (const [k, v] of createdScenes.byKey) created.byKey.set(k, v);
      for (const [k, v] of createdScenes.byName) if (!created.byName.has(k)) created.byName.set(k, v);
    }

    // 4) Story (+ worldview appendix merged into body).
    const worldviewText = str(objOf(raw, 'worldview')?.text);
    const bodyParts: string[] = [];
    const bodyText = typeof story?.body === 'string' ? story.body : '';
    if (bodyText.trim()) bodyParts.push(bodyText);
    if (worldviewText) bodyParts.push(`${WORLDVIEW_MARKER}\n\n${worldviewText}`);
    const durationRawStory = Number(story?.plannedDurationSeconds);
    updateStory(p, {
      title,
      synopsis: typeof story?.synopsis === 'string' ? story.synopsis : '',
      body: bodyParts.join('\n\n'),
      ...(Number.isFinite(durationRawStory) && durationRawStory > 0 ? { plannedDurationSeconds: Math.round(durationRawStory) } : {}),
    });

    // 5) Sequences, then beats with name-based resolution.
    const sequenceIds = new Map<string, string>();
    for (const seq of arrOfObj(story?.sequences)) {
      const seqTitle = str(seq.title);
      if (!seqTitle) {
        warnings.push('story.sequences: 存在缺少 title 的幕，已跳过');
        continue;
      }
      if (sequenceIds.has(seqTitle)) {
        warnings.push(`story.sequences: 幕 "${seqTitle}" 重名，后者已跳过`);
        continue;
      }
      const created1 = createSequence(p, { title: seqTitle, summary: typeof seq.summary === 'string' ? seq.summary : '' });
      sequenceIds.set(seqTitle, created1.id);
      stats.sequences++;
    }

    for (const [beatIndex, beat] of arrOfObj(story?.beats).entries()) {
      const where = `story.beats[${beatIndex}]`;
      const categoryRaw = str(beat.category);
      const category = categoryRaw && BEAT_CATEGORIES.has(categoryRaw as BeatCategory) ? (categoryRaw as BeatCategory) : 'other';
      if (categoryRaw && category === 'other' && categoryRaw !== 'other') {
        warnings.push(`${where}: 未知分类 "${categoryRaw}"，回落为 other`);
      }
      const sequenceTitle = str(beat.sequenceTitle);
      const sequenceId = sequenceTitle ? sequenceIds.get(sequenceTitle) : undefined;
      if (sequenceTitle && !sequenceId) warnings.push(`${where}: 引用了不存在的幕 "${sequenceTitle}"`);
      const characterNames = stringArray(beat.characters);
      const characterIds: string[] = [];
      for (const name of characterNames) {
        const id = created.byName.get(name);
        if (id) characterIds.push(id);
        else warnings.push(`${where}: 角色 "${name}" 在实体中不存在`);
      }
      const durationBeat = Number(beat.durationSeconds);
      createBeat(p, {
        title: str(beat.title) ?? `Beat ${beatIndex + 1}`,
        category,
        summary: typeof beat.summary === 'string' ? beat.summary : '',
        location: str(beat.location),
        timeOfDay: str(beat.timeOfDay),
        weather: str(beat.weather),
        characters: characterIds,
        stateChange: typeof beat.stateChange === 'string' ? beat.stateChange : '',
        notes: typeof beat.notes === 'string' ? beat.notes : '',
        durationSeconds: Number.isFinite(durationBeat) && durationBeat > 0 ? durationBeat : p.config.default_duration_seconds,
        sequenceId,
      });
      stats.beats++;
    }

    // 6) Persist visual-direction defaults.
    await store.saveConfig();
  } catch (e) {
    // Never leave a half-open project dangling on unexpected failures.
    warnings.push(`导入过程异常中断: ${e instanceof Error ? e.message : e}`);
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { bibleProjectId: meta.id, bibleWarnings: warnings });
  }

  return { projectId: meta.id, title, stats, warnings };
}
