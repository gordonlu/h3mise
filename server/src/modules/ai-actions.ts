// AI assist actions — PRD §39-40. Every action returns a SUGGESTION the user
// applies; nothing is written to program state and nothing renders.
// When AI is not configured these return a clear "not configured" error so
// the UI can fall back to Copy Context Package (external AI flow).

import type { ProjectContext } from '../project-store.js';
import type { AIService } from './ai.js';
import * as directorMod from './director.js';
import * as promptMod from './prompt.js';
import * as shotsMod from './shots.js';
import * as storyMod from './story.js';
import * as assetsMod from './assets.js';
import * as continuityMod from './continuity.js';
import * as takesMod from './takes.js';
import { emptyDirectorPlan, type DirectorPlan, type StoryBeat } from '@h3mise/shared';

type ActionName =
  | 'plan_shot'
  | 'improve_camera'
  | 'improve_performance'
  | 'reality_check'
  | 'continuity_check'
  | 'compile_prompt'
  | 'diagnose_take'
  | 'repair_prompt'
  | 'story_to_beats'
  | 'beats_to_shots'
  | 'auto_director';

const PLAN_SCHEMA_HINT = `DirectorPlan JSON schema:
{
  "intent": {"shotFunction": string, "visualThesis": string, "dramaticGoal": string, "peak": string, "endState": string},
  "subject": {"primarySubject": string, "action": string, "primaryMotionOwner": string},
  "blocking": {"startPosition": string, "endPosition": string, "facing": string, "movementAxis": string, "travelPath": string, "spatialRelationships": string},
  "camera": {"shotSizeStart": string, "shotSizePeak": string, "shotSizeEnd": string, "geometry": string, "lensIntent": string, "dominantBehavior": string, "trigger": string, "speedRelation": string, "stopCondition": string},
  "performance": {"objective": string, "obstacle": string, "tactic": string, "performanceTurn": string, "movementQuality": {"weight": string, "time": string, "space": string, "flow": string}, "anticipation": string, "primaryAction": string, "followThrough": string, "recovery": string, "gaze": string, "endPose": string},
  "environment": {"location": string, "weather": string, "medium": string, "wind": string, "lighting": string, "foreground": string, "midground": string, "background": string},
  "reality": {"mode": "strict_realism"|"plausible_stylized"|"deliberate_fantasy", "constraints": string[]},
  "continuity": {"plannedStartState": string, "plannedEndState": string},
  "generation": {"requestedMode": string, "durationSeconds": number, "aspectRatio": string, "audioIntent": string}
}`;

export async function runAction(
  ai: AIService,
  ctx: ProjectContext,
  action: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (!ai.model) throw new Error('AI not configured — use external AI templates instead');
  const skills = await ai.loadSkills();
  const skillText = skills.map((s) => `# ${s.title}\n${s.content}`).join('\n\n---\n\n');
  const shotId = body.shotId ? String(body.shotId) : null;
  const shot = shotId ? shotsMod.getShot(ctx, shotId) : null;
  const plan = shotId ? directorMod.latestPlan(ctx, shotId)?.plan ?? emptyDirectorPlan() : null;

  switch (action as ActionName) {
    case 'plan_shot': {
      if (!shotId) throw new Error('shotId required');
      const dp = await ai.model.structured<DirectorPlan>({
        system: `You are the H3 Micro Cinematic Director.\n${skillText}\n${PLAN_SCHEMA_HINT}\nReturn ONLY the JSON plan. Do not invent story facts.`,
        messages: [{ role: 'user', content: planShotPrompt(ctx, shotId, body) }],
        temperature: 0.6,
      });
      return { kind: 'director_plan', plan: dp };
    }
    case 'improve_camera': {
      if (!shotId) throw new Error('shotId required');
      const dp = await ai.model.structured<DirectorPlan>({
        system: `You are the H3 Shot Pattern Library. Improve ONLY the camera block of the given plan. Keep every other block unchanged. Return the full plan JSON.\n${PLAN_SCHEMA_HINT}`,
        messages: [{ role: 'user', content: `Plan:\n${JSON.stringify(plan)}\nRequest: ${String(body.request ?? 'Improve camera design.')}` }],
        temperature: 0.5,
      });
      return { kind: 'director_plan', plan: dp };
    }
    case 'improve_performance': {
      if (!shotId) throw new Error('shotId required');
      const dp = await ai.model.structured<DirectorPlan>({
        system: `You are the H3 Performance Director. Improve ONLY the performance block (objective/obstacle/tactic/turn, movement quality, anticipation, follow-through, recovery, gaze, end pose). Keep every other block unchanged. Return the full plan JSON.\n${PLAN_SCHEMA_HINT}`,
        messages: [{ role: 'user', content: `Plan:\n${JSON.stringify(plan)}\nRequest: ${String(body.request ?? 'Improve the performance.')}` }],
        temperature: 0.5,
      });
      return { kind: 'director_plan', plan: dp };
    }
    case 'reality_check': {
      if (!shotId) throw new Error('shotId required');
      const text = await ai.model.complete({
        system: `You are a physics/reality reviewer. Check the shot against: geometry/structure, gravity/support/contact, inertia/momentum, cause→effect, medium rules, biology/anatomy, vehicle mechanics, light/shadow, temporal continuity, known-fact contradictions. Break one law intentionally, not every law accidentally. Output a short list "ISSUE: ... | SEVERITY: minor/major | FIX: ..." per problem, then a verdict line.`,
        messages: [{ role: 'user', content: `Plan:\n${JSON.stringify(plan)}\n\nReality mode: ${plan?.reality.mode ?? 'strict_realism'}` }],
        temperature: 0.3,
      });
      return { kind: 'review', text };
    }
    case 'continuity_check': {
      if (!shotId) throw new Error('shotId required');
      const latest = continuityMod.latestContinuity(ctx, 'visual', 'actual');
      const text = await ai.model.complete({
        system: `You are a script-continuity reviewer. Compare the shot's planned start state against the committed actual continuity of the previous shot. Flag mismatches in character visual state, costume, hair, injury, held items, location, time/weather, screen direction, facing. Output "MISMATCH: ... | FIX: ..." lines and a verdict.`,
        messages: [
          { role: 'user', content: `Committed actual continuity:\n${JSON.stringify(latest?.state)}\n\nNew shot plan start state:\n${plan?.continuity.plannedStartState}\n\nShot:\n${JSON.stringify(shot)}` },
        ],
        temperature: 0.3,
      });
      return { kind: 'review', text };
    }
    case 'compile_prompt': {
      if (!shotId) throw new Error('shotId required');
      const deterministic = promptMod.listPrompts(ctx, shotId).at(-1);
      const text = await ai.model.complete({
        system: `You are the H3 prompt writer. Rewrite the deterministic draft into a natural, compact H3 prompt. Keep EVERY fact. Do not add events. Preserve reference labels. Keep the same sections. Output only the prompt text.`,
        messages: [
          { role: 'user', content: `Deterministic draft:\n${deterministic?.text ?? '(none)'}\n\nMode: ${deterministic?.h3Mode ?? shot?.h3Mode}` },
        ],
        temperature: 0.4,
      });
      return { kind: 'prompt', text };
    }
    case 'diagnose_take': {
      const takeId = body.takeId ? String(body.takeId) : null;
      if (!takeId) throw new Error('takeId required');
      const take = takesMod.getTake(ctx, takeId);
      const prompt = promptMod.getPrompt(ctx, take.promptVersionId);
      const text = await ai.model.complete({
        system: `You diagnose failed H3 takes. Input: DirectorPlan, Prompt, Reference labels, Failure tags, Take notes. Output likely causes (ranked) and concrete fixes to try (plan edits, reference role changes, prompt changes). Never suggest paying for another render.`,
        messages: [
          {
            role: 'user',
            content: `DirectorPlan:\n${JSON.stringify(plan)}\n\nPrompt:\n${prompt.text}\n\nFailure tags: ${take.failureTags.join(', ')}\nNotes: ${take.notes}`,
          },
        ],
        temperature: 0.4,
      });
      return { kind: 'diagnosis', text };
    }
    case 'repair_prompt': {
      const promptId = body.promptId ? String(body.promptId) : null;
      if (!promptId) throw new Error('promptId required');
      const pv = promptMod.getPrompt(ctx, promptId);
      const text = await ai.model.complete({
        system: `You repair H3 prompts. Fix only the stated problems; keep all other content identical. Output the repaired prompt only.`,
        messages: [{ role: 'user', content: `Prompt:\n${pv.text}\n\nProblems: ${String(body.problems ?? '')}` }],
        temperature: 0.3,
      });
      return { kind: 'prompt', text };
    }
    case 'story_to_beats': {
      const story = storyMod.getStory(ctx);
      const beats = await ai.model.structured<Array<Omit<StoryBeat, 'id' | 'sequenceId' | 'order' | 'createdAt' | 'updatedAt'>>>({
        system: `You break a story into StoryBeats. Each beat: title, category (setup|inciting_incident|rising_action|climax|falling_action|resolution|transition|other), summary, location, timeOfDay, weather, characters (entity names), stateChange. 4-12 beats. Return ONLY a JSON array.`,
        messages: [{ role: 'user', content: `Story:\n${story.title}\n${story.synopsis}\n\n${story.body.slice(0, 6000)}` }],
        temperature: 0.5,
      });
      return { kind: 'beats', beats };
    }
    case 'beats_to_shots': {
      const beats = body.beats as Array<{ title?: string; summary?: string; id?: string }> | undefined;
      const items = await ai.model.structured<Array<{ title: string; purpose: string; shotFunction: string; durationSeconds: number; h3Mode: string }>>({
        system: `You convert StoryBeats into H3 shot plans. Default: one shot = one continuous event. Each shot: title, purpose, shotFunction (establishing|wide|medium|closeup|insert|reaction|action|transition|montage|pov|aerial|dialogue|other), durationSeconds (5-15, default 5), h3Mode (t2va|i2va|fl2va|l2va|ref2va). Return ONLY a JSON array.`,
        messages: [{ role: 'user', content: `Beats:\n${JSON.stringify(beats ?? [])}\n\nConvert each beat into one shot.` }],
        temperature: 0.4,
      });
      return { kind: 'shots', items };
    }
    case 'auto_director': {
      // Story → Beats → Shots → Plans, stops before render (PRD §40).
      const story = storyMod.getStory(ctx);
      const beats = await ai.model.structured<Array<Omit<StoryBeat, 'id' | 'sequenceId' | 'order' | 'createdAt' | 'updatedAt'>>>({
        system: `You break a story into StoryBeats (see story_to_beats rules). Return ONLY a JSON array.`,
        messages: [{ role: 'user', content: `Story:\n${story.title}\n${story.synopsis}\n\n${story.body.slice(0, 6000)}` }],
        temperature: 0.5,
      });
      const created: { beatId: string; shotId: string }[] = [];
      for (const b of beats) {
        const beat = storyMod.createBeat(ctx, { title: b.title, category: b.category, summary: b.summary, location: b.location, timeOfDay: b.timeOfDay, weather: b.weather, stateChange: b.stateChange });
        const shot = shotsMod.createShot(ctx, { title: beat.title, storyBeatId: beat.id, purpose: beat.summary, durationSeconds: 5 });
        const dp = await ai.model.structured<DirectorPlan>({
          system: `You are the H3 Micro Cinematic Director.\n${skillText}\n${PLAN_SCHEMA_HINT}\nReturn ONLY the JSON plan.`,
          messages: [{ role: 'user', content: planShotPrompt(ctx, shot.id, {}) }],
          temperature: 0.6,
        });
        directorMod.createPlanVersion(ctx, { shotId: shot.id, plan: dp, source: 'builtin_ai' });
        created.push({ beatId: beat.id, shotId: shot.id });
      }
      return { kind: 'auto_director_result', created, note: 'stopped before render — review plans, compile prompts, run preflight, then render manually' };
    }
    default:
      throw new Error('unknown action: ' + action);
  }
}

function planShotPrompt(ctx: ProjectContext, shotId: string, body: Record<string, unknown>): string {
  const shot = shotsMod.getShot(ctx, shotId);
  const plan = directorMod.latestPlan(ctx, shotId)?.plan ?? null;
  const prompts = promptMod.listPrompts(ctx, shotId);
  const refs = assetsMod.listBindings(ctx, shotId);
  const latest = continuityMod.latestContinuity(ctx, 'visual', 'actual');
  const entities = assetsMod.listEntities(ctx);
  const states = assetsMod.listCharacterStates(ctx);
  const story = storyMod.getStory(ctx);
  const beat = shot.storyBeatId ? storyMod.getBeat(ctx, shot.storyBeatId) : null;
  return `Shot: ${JSON.stringify(shot)}
StoryBeat: ${JSON.stringify(beat)}
Story: ${story.title} — ${story.logline}
DirectorPlan (current, may be empty): ${JSON.stringify(plan)}
Prompt history: ${prompts.map((pv) => pv.text).join('\n---\n').slice(0, 4000)}
References: ${JSON.stringify(refs)}
Committed actual continuity: ${JSON.stringify(latest?.state)}
Entities: ${JSON.stringify(entities)}
Character states: ${JSON.stringify(states)}
Request: ${String(body.request ?? 'Produce the DirectorPlan for this shot.')}`;
}
