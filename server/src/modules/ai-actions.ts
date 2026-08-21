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

type BeatsResult = Array<Omit<StoryBeat, 'id' | 'sequenceId' | 'order' | 'createdAt' | 'updatedAt'>>;

/** Models under json_object mode sometimes wrap an array in {"beats": [...]}. */
function normalizeBeats(raw: unknown): BeatsResult {
  if (Array.isArray(raw)) return raw as BeatsResult;
  if (raw && typeof raw === 'object' && Array.isArray((raw as { beats?: unknown }).beats)) {
    return (raw as { beats: BeatsResult }).beats;
  }
  return [];
}

/** Parse "0-5s" / "5-10s" / "10s" style time ranges into a duration in seconds. */
function parseRangeSeconds(t: unknown): number | null {
  if (typeof t !== 'string') return null;
  const m = t.match(/(\d+)\s*-\s*(\d+)/);
  if (m) {
    const d = Number(m[2]) - Number(m[1]);
    if (d >= 1 && d <= 60) return d;
  }
  return null;
}

/**
 * The model sometimes answers with a different shape than StoryBeat JSON —
 * a shot table (shot/time/scene/camera/audio) or a shot-prompt list
 * ({scene: n, duration, prompt}). Convert whatever text it gave us.
 */
const BEAT_TEXT_KEYS = ['prompt', 'scene', 'content', 'description', 'summary', 'body', 'text', '画面', '内容', '描述', '文案', '场景', '分镜', '镜头描述', 'picture'] as const;

function beatTextOf(x: Record<string, unknown>): string | null {
  for (const k of BEAT_TEXT_KEYS) {
    const v = x[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

function beatDurationOf(x: Record<string, unknown>): number {
  if (typeof x.duration === 'number' && x.duration >= 1 && x.duration <= 60) return x.duration;
  const ranged = parseRangeSeconds(typeof x.duration === 'string' ? x.duration : x.time);
  if (ranged) return ranged;
  return 5;
}

/** Lightweight time-of-day / weather inference from beat text. */
function inferTimeOfDay(text: string): string | undefined {
  if (/清晨|早晨|日出|黎明/.test(text)) return '清晨';
  if (/正午|中午|午后|下午|白天|白昼/.test(text)) return '白天';
  if (/黄昏|傍晚|日落/.test(text)) return '黄昏';
  if (/深夜|午夜|夜晚|夜里|凌晨|晚上/.test(text)) return '夜晚';
  return undefined;
}

function inferWeather(text: string): string | undefined {
  if (/雨/.test(text)) return '雨';
  if (/雪/.test(text)) return '雪';
  if (/雾/.test(text)) return '雾';
  if (/风/.test(text)) return '风';
  if (/晴|阳光|月光/.test(text)) return '晴';
  return undefined;
}

function convertShotTable(raw: unknown): BeatsResult | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const first = raw[0] as Record<string, unknown>;
  if (typeof first.title === 'string') return null; // already StoryBeat shape
  if (!beatTextOf(first)) return null; // no text to convert from
  return raw.map((r) => {
    const x = r as Record<string, unknown>;
    const scene = beatTextOf(x) ?? '';
    const camera = String(x.camera ?? x['景别'] ?? x['运镜'] ?? x['景别/运镜'] ?? '').trim();
    const audio = String(x.audio ?? x['声音'] ?? x['音频'] ?? x['声音/字幕'] ?? '').trim();
    const extra = [camera && `镜头：${camera}`, audio && `声音：${audio}`].filter(Boolean).join('；');
    const summary = extra ? `${scene}
${extra}` : scene;
    return {
      title: scene.split(/[，。；\n]/)[0]?.slice(0, 24) ?? 'Beat',
      category: 'other',
      summary,
      location: undefined,
      timeOfDay: inferTimeOfDay(scene),
      weather: inferWeather(scene),
      characters: [],
      stateChange: '',
      notes: '',
      durationSeconds: beatDurationOf(x),
    } as BeatsResult[number];
  });
}

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
      const latest = continuityMod.predecessorContinuity(ctx, shotId, 'visual', 'actual');
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
      const firstSystem = `You break a story into StoryBeats. Each beat: title, category (setup|inciting_incident|rising_action|climax|falling_action|resolution|transition|other), summary, location, timeOfDay, weather, characters (entity names), stateChange, durationSeconds (1-15). Allocate beats so their durationSeconds sum matches the planned total duration as closely as possible; use fewer, longer beats for slow scenes and more short beats for montages/transitions.

FORMAT (STRICT): Reply with ONLY a JSON array. REQUIRED fields on every element: "title" (string), "summary" (string). Optional: category, location, timeOfDay, weather, characters, stateChange, durationSeconds. No prose. No markdown. No code fences. No tables. Begin with '[' and end with ']'. Example:
[{"title":"Beat title","summary":"one line","category":"setup","location":"","timeOfDay":"","weather":"","characters":[],"stateChange":"","durationSeconds":5}]`;
      const userMsg = `Planned total duration: ${story.plannedDurationSeconds || 'unspecified'} seconds.\nStory:\n${story.title}\n${story.synopsis}\n\n${story.body.slice(0, 6000)}`;

      let raw: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        const system = attempt === 0
          ? firstSystem
          : `${firstSystem}\n\n上一轮你返回的不是 StoryBeat JSON 数组：${JSON.stringify(raw).slice(0, 800)}\n现在请严格按 FORMAT 重新输出：每个元素必须是对象，且 title 和 summary 必须是字符串。只输出 JSON 数组。`;
        raw = await ai.model.structured<unknown>({
          system,
          messages: [{ role: 'user', content: userMsg }],
        });
        const beats = normalizeBeats(raw);
        if (beats.length > 0 && beats.every((b) => typeof b.title === 'string' && typeof b.summary === 'string')) {
          return { kind: 'beats', beats };
        }
        const converted = convertShotTable(raw);
        if (converted) {
          return { kind: 'beats', beats: converted, note: '模型返回了分镜表/镜头列表，已自动转换为 StoryBeat' };
        }
      }
      throw new Error(
        `AI 拆解两轮均未返回有效 StoryBeat JSON（返回：${JSON.stringify(raw).slice(0, 150)}），已中止，请重试或改为手动添加节拍。`,
      );
    }
    case 'beats_to_shots': {
      const beats = body.beats as Array<{ title?: string; summary?: string; id?: string }> | undefined;
      const items = await ai.model.structured<Array<{ title: string; purpose: string; shotFunction: string; durationSeconds: number; h3Mode: string }>>({
        system: `You convert StoryBeats into H3 shot plans. Default: one shot = one continuous event. Each shot: title, purpose, shotFunction (establishing|wide|medium|closeup|insert|reaction|action|transition|montage|pov|aerial|dialogue|other), durationSeconds (1-15; base it on the beat's durationSeconds unless the story needs more or less), h3Mode (t2va|i2va|fl2va|l2va|ref2va). Return ONLY a JSON array.`,
        messages: [{ role: 'user', content: `Beats:\n${JSON.stringify(beats ?? [])}\n\nConvert each beat into one shot.` }],
        temperature: 0.4,
      });
      return { kind: 'shots', items };
    }
    case 'auto_director': {
      // Story → Beats → Shots → Plans, stops before render (PRD §40).
      const story = storyMod.getStory(ctx);
      const beats = normalizeBeats(await ai.model.structured<unknown>({
        system: `You break a story into StoryBeats (see story_to_beats rules). Return ONLY a JSON array.`,
        messages: [{ role: 'user', content: `Planned total duration: ${story.plannedDurationSeconds || 'unspecified'} seconds.\nStory:\n${story.title}\n${story.synopsis}\n\n${story.body.slice(0, 6000)}` }],
        temperature: 0.5,
      }));
      if (beats.length === 0 || beats.some((b) => typeof b.title !== 'string')) {
        throw new Error('AI 拆解返回的节拍结构不符合要求（缺少 title 等字段），已中止，请重试。');
      }
      const created: { beatId: string; shotId: string }[] = [];
      for (const b of beats) {
        const beat = storyMod.createBeat(ctx, { title: b.title, category: b.category, summary: b.summary, location: b.location, timeOfDay: b.timeOfDay, weather: b.weather, stateChange: b.stateChange });
        const shot = shotsMod.createShot(ctx, { title: beat.title, storyBeatId: beat.id, purpose: beat.summary, durationSeconds: beat.durationSeconds || ctx.config.default_duration_seconds });
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
  const latest = continuityMod.predecessorContinuity(ctx, shotId, 'visual', 'actual');
  const entities = assetsMod.listEntities(ctx);
  const states = assetsMod.listCharacterStates(ctx);
  const story = storyMod.getStory(ctx);
  const beat = shot.storyBeatId ? storyMod.getBeat(ctx, shot.storyBeatId) : null;
  return `Shot: ${JSON.stringify(shot)}
StoryBeat: ${JSON.stringify(beat)}
Story: ${story.title} — ${story.synopsis.slice(0, 300)}
DirectorPlan (current, may be empty): ${JSON.stringify(plan)}
Prompt history: ${prompts.map((pv) => pv.text).join('\n---\n').slice(0, 4000)}
References: ${JSON.stringify(refs)}
Committed actual continuity: ${JSON.stringify(latest?.state)}
Entities: ${JSON.stringify(entities)}
Character states: ${JSON.stringify(states)}
Request: ${String(body.request ?? 'Produce the DirectorPlan for this shot.')}`;
}
