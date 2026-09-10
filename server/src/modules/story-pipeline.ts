import type { BeatApplyMode, BeatApplyResult, H3Mode, StoryBeat, StoryBeatDraft } from '@h3mise/shared';
import { emptyDirectorPlan } from '@h3mise/shared';
import type { ProjectContext } from '../project-store.js';
import { createBeat, deleteBeat, listBeats, updateBeat } from './story.js';
import { createShot, listShots } from './shots.js';
import { createPlanVersion } from './director.js';
import { listEntities } from './assets.js';

function normalizedDraft(input: StoryBeatDraft, index: number): StoryBeatDraft {
  const duration = Number(input.durationSeconds ?? 12);
  return {
    ...input,
    title: String(input.title ?? '').trim() || `Beat ${index + 1}`,
    summary: String(input.summary ?? '').trim(),
    durationSeconds: Math.min(15, Math.max(2, Number.isFinite(duration) ? duration : 12)),
    characters: Array.isArray(input.characters) ? input.characters.filter((item): item is string => typeof item === 'string') : [],
  };
}

function applyBeatProposalInternal(p: ProjectContext, rawDrafts: StoryBeatDraft[], mode: BeatApplyMode): Omit<BeatApplyResult, 'shotsCreated'> {
  if (!Array.isArray(rawDrafts) || rawDrafts.length === 0) throw new Error('beat proposal is empty');
  const drafts = rawDrafts.map(normalizedDraft);
  const existing = listBeats(p);
  let created = 0;
  let updated = 0;
  let deleted = 0;
  let retainedLinked = 0;
  const syncedShotIds = new Set<string>();

  if (mode === 'append') {
    for (const draft of drafts) createBeat(p, draft);
    created = drafts.length;
    return { beats: listBeats(p), created, updated, deleted, retainedLinked, shotsSynced: 0 };
  }

  const orderedIds: string[] = [];
  for (let index = 0; index < drafts.length; index++) {
    const draft = drafts[index]!;
    const current = existing[index];
    if (!current) {
      const beat = createBeat(p, draft);
      orderedIds.push(beat.id);
      created++;
      continue;
    }
    const linked = p.db.all<{ id: string; title: string; purpose: string; duration_seconds: number }>(
      'SELECT id, title, purpose, duration_seconds FROM shots WHERE story_beat_id = ?',
      [current.id],
    );
    updateBeat(p, current.id, { ...draft, order: index });
    const nextTitle = String(draft.title ?? current.title);
    const nextSummary = String(draft.summary ?? current.summary);
    const nextDuration = Number(draft.durationSeconds ?? current.durationSeconds);
    for (const shot of linked) {
      const hasAuthoredWork = Boolean(
        p.db.get<{ id: string }>('SELECT id FROM prompt_versions WHERE shot_id = ? LIMIT 1', [shot.id]) ||
        p.db.get<{ id: string }>('SELECT id FROM takes WHERE shot_id = ? LIMIT 1', [shot.id]) ||
        p.db.get<{ id: string }>('SELECT id FROM render_jobs WHERE shot_id = ? LIMIT 1', [shot.id]) ||
        p.db.get<{ id: string }>("SELECT id FROM director_plan_versions WHERE shot_id = ? AND source <> 'default' LIMIT 1", [shot.id]),
      );
      if (hasAuthoredWork) continue;
      const sets: string[] = [];
      const values: unknown[] = [];
      if (shot.title === current.title) { sets.push('title = ?'); values.push(nextTitle); }
      if (shot.purpose === current.summary) { sets.push('purpose = ?'); values.push(nextSummary); }
      if (shot.duration_seconds === current.durationSeconds) { sets.push('duration_seconds = ?'); values.push(nextDuration); }
      if (sets.length) {
        values.push(new Date().toISOString(), shot.id);
        p.db.run(`UPDATE shots SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, values);
        syncedShotIds.add(shot.id);
      }
    }
    orderedIds.push(current.id);
    updated++;
  }

  for (const surplus of existing.slice(drafts.length)) {
    const linked = p.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM shots WHERE story_beat_id = ?', [surplus.id])?.n ?? 0;
    if (linked > 0) {
      orderedIds.push(surplus.id);
      retainedLinked++;
    } else {
      deleteBeat(p, surplus.id);
      deleted++;
    }
  }
  orderedIds.forEach((id, index) => p.db.run('UPDATE story_beats SET ord = ? WHERE id = ?', [index, id]));
  return { beats: listBeats(p), created, updated, deleted, retainedLinked, shotsSynced: syncedShotIds.size };
}

function shotFunctionForBeat(beat: StoryBeat) {
  if (beat.category === 'setup') return 'establishing' as const;
  if (beat.category === 'climax') return 'action' as const;
  if (beat.category === 'resolution') return 'reaction' as const;
  if (beat.category === 'transition') return 'transition' as const;
  return 'other' as const;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function narrativeCharacters(beat: StoryBeat, entities: ReturnType<typeof listEntities>): string[] {
  const byId = new Map(entities.map((entity) => [entity.id, entity.name]));
  const names = new Set(beat.characters.map((item) => byId.get(item) ?? item).filter(Boolean));
  for (const entity of entities) {
    if ((entity.kind === 'character' || entity.kind === 'creature') && beat.summary.includes(entity.name)) names.add(entity.name);
  }
  return [...names];
}

function motionOwnerForBeat(beat: StoryBeat, characters: string[]): string {
  const actionWords = '起身|走|跑|转身|回头|抬头|低头|拿|放|推|拉|打开|关掉|关闭|看|注视|说|问|回答|吐槽|点头|洗|停下';
  let winner = characters[0] ?? '';
  let best = -1;
  for (const name of characters) {
    const matches = beat.summary.match(new RegExp(`${escapeRegExp(name)}[^。！？]{0,18}(?:${actionWords})`, 'gu'))?.length ?? 0;
    const score = matches * 2 + (beat.summary.trim().startsWith(name) ? 1 : 0);
    if (score > best) { best = score; winner = name; }
  }
  return winner;
}

export function createShotForBeat(
  p: ProjectContext,
  beat: StoryBeat,
  input: { purpose?: string; h3Mode?: H3Mode; renderDependencyMode?: 'independent' | 'auto' } = {},
) {
  const purpose = input.purpose?.trim() || beat.summary || beat.title;
  const shot = createShot(p, {
    title: beat.title,
    sequenceId: beat.sequenceId ?? null,
    storyBeatId: beat.id,
    purpose,
    shotFunction: shotFunctionForBeat(beat),
    durationSeconds: beat.durationSeconds,
    aspectRatio: p.config.default_aspect_ratio,
    h3Mode: input.h3Mode ?? 't2va',
    renderDependencyMode: input.renderDependencyMode ?? 'independent',
  });
  const entities = listEntities(p);
  const characters = narrativeCharacters(beat, entities);
  const quotes = beat.summary.match(/“[^”]+”/gu) ?? [];
  const plan = emptyDirectorPlan();
  plan.intent.shotFunction = shot.shotFunction;
  plan.intent.visualThesis = purpose;
  plan.intent.dramaticGoal = beat.stateChange || purpose;
  plan.intent.endState = beat.stateChange || `完成「${beat.title}」的可见动作结果`;
  plan.subject.primarySubject = characters.join('、');
  plan.subject.primaryMotionOwner = motionOwnerForBeat(beat, characters);
  plan.subject.action = purpose;
  plan.camera.dominantBehavior = characters.length >= 3
    ? '先短暂交代空间，再用一次连续平移或轻微跟随把构图焦点交给当前动作或说话者'
    : '稳定构图，清楚呈现主体动作和直接反应';
  plan.camera.stopCondition = plan.intent.endState;
  plan.performance.objective = beat.stateChange || purpose;
  plan.performance.primaryAction = purpose;
  plan.performance.performanceTurn = beat.stateChange ?? '';
  plan.environment.location = beat.location ?? '';
  plan.environment.weather = beat.weather ?? '';
  plan.continuity.plannedEndState = beat.stateChange ?? '';
  plan.generation.requestedMode = shot.h3Mode ?? 't2va';
  plan.generation.durationSeconds = shot.durationSeconds;
  plan.generation.aspectRatio = shot.aspectRatio;
  plan.generation.audioIntent = quotes.length ? `对白按剧情中的说话人与顺序逐字呈现：${quotes.join(' → ')}` : '';
  createPlanVersion(p, { shotId: shot.id, plan, source: 'default' });
  return shot;
}

function materializeMissingBeatShotsInternal(p: ProjectContext): ReturnType<typeof createShotForBeat>[] {
  const covered = new Set(listShots(p).map((shot) => shot.storyBeatId).filter((id): id is string => Boolean(id)));
  const created = [];
  for (const beat of listBeats(p)) {
    if (covered.has(beat.id)) continue;
    created.push(createShotForBeat(p, beat));
    covered.add(beat.id);
  }
  return created;
}

export function materializeMissingBeatShots(p: ProjectContext): ReturnType<typeof createShotForBeat>[] {
  return p.db.tx(() => materializeMissingBeatShotsInternal(p));
}

export function applyBeatProposal(
  p: ProjectContext,
  drafts: StoryBeatDraft[],
  options: { mode?: BeatApplyMode; createMissingShots?: boolean } = {},
): BeatApplyResult {
  return p.db.tx(() => {
    const result = applyBeatProposalInternal(p, drafts, options.mode ?? 'replace');
    const shots = options.createMissingShots ? materializeMissingBeatShotsInternal(p) : [];
    return { ...result, beats: listBeats(p), shotsCreated: shots.length };
  });
}
