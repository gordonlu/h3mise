// AI assist actions — PRD §39-40. Every action returns a SUGGESTION the user
// applies; nothing is written to program state and nothing renders.
// When AI is not configured these return a clear "not configured" error so
// the UI can fall back to Copy Context Package (external AI flow).

import type { ProjectContext } from '../project-store.js';
import type { AIService, DirectorContentPart, DirectorModel, VisionStatus } from './ai.js';
import { readFile } from 'node:fs/promises';
import * as directorMod from './director.js';
import * as promptMod from './prompt.js';
import * as shotsMod from './shots.js';
import * as storyMod from './story.js';
import * as assetsMod from './assets.js';
import * as continuityMod from './continuity.js';
import * as takesMod from './takes.js';
import { emptyDirectorPlan, type DirectorPlan, type StoryBeat, type VisualContinuityState } from '@h3mise/shared';

type ActionName =
  | 'plan_shot'
  | 'improve_camera'
  | 'improve_performance'
  | 'reality_check'
  | 'continuity_check'
  | 'compile_prompt'
  | 'diagnose_take'
  | 'analyze_take_continuity'
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
  "generation": {"audioIntent": string}
}`;

const DIRECTOR_SYSTEM_PROMPT = `你是 H3Mise 内置电影导演助手，负责把故事事实转化为可执行的单镜头导演方案。

工作标准：
1. 一个镜头只表达一个连续事件，不在单次生成中安排切镜、跳时或场景切换。
2. 优先保证叙事意图清晰、主体动作可见、摄影机行为可执行、结束画面明确。
3. 严格遵守故事、角色、参考素材与已提交连续性；不得补写上下文中不存在的事实。
4. 摄影机、表演、环境和现实约束必须互相兼容，并适合当前时长、画幅与生成模式。
5. 信息不足时采用保守方案或留空，不使用空泛形容词，不解释创作过程。
6. 动作描述必须确定性完整：身体部位、方向、先后顺序、空间参照缺一不可。把“打开车门并上车”这类压缩动作展开为无歧义的连续动作链（如：走到驾驶座一侧→左手拉开左侧车门→先迈右腿入座→收左腿→左手关门），杜绝左右侧、主体归属、顺序的一切误判。
7. 只有在请求确实附带且你能读取参考图时，才能从图中提取左右位置、前中后景、人物朝向和物体关系；看不到图像时必须沿用已有文字，缺失则留空，严禁猜测。

输出要求：只返回符合 DirectorPlan schema 的完整 JSON 对象，不要 Markdown、代码围栏或额外说明。所有字段内容一律使用中文（仅保留必要的英文技术标识如枚举值），简洁、具体、可拍摄。`;

type BeatsResult = Array<Omit<StoryBeat, 'id' | 'sequenceId' | 'order' | 'createdAt' | 'updatedAt'>>;

const MAX_VISION_IMAGES = 9;
const MAX_VISION_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VISION_TOTAL_BYTES = 24 * 1024 * 1024;

/** Build one OpenAI-compatible multimodal user message. Images follow the
 * same binding order used by prompt reference numbering, so each attachment
 * can be identified as <Picture N>. Unreadable/oversized images are skipped;
 * if none survive, callers retain the old plain-string request shape. */
export async function shotMultimodalContent(
  ctx: ProjectContext,
  shotId: string,
  text: string,
): Promise<string | DirectorContentPart[]> {
  const bindings = assetsMod.listBindings(ctx, shotId);
  const candidates = bindings.filter((binding) => binding.type === 'image').slice(0, MAX_VISION_IMAGES);
  const parts: DirectorContentPart[] = [{ type: 'text', text }];
  let pictureNumber = 0;
  let totalBytes = 0;
  for (const binding of candidates) {
    pictureNumber++;
    try {
      const asset = assetsMod.getMedia(ctx, binding.assetId);
      if (!asset.mimeType.startsWith('image/') || asset.sizeBytes > MAX_VISION_IMAGE_BYTES) continue;
      if (totalBytes + asset.sizeBytes > MAX_VISION_TOTAL_BYTES) continue;
      const bytes = await readFile(ctx.resolveProjectPath(asset.fileName));
      if (bytes.byteLength > MAX_VISION_IMAGE_BYTES || totalBytes + bytes.byteLength > MAX_VISION_TOTAL_BYTES) continue;
      totalBytes += bytes.byteLength;
      parts.push({
        type: 'text',
        text: `<Picture ${pictureNumber}>：${binding.label || asset.label || asset.id}；roles=${binding.roles.join(',') || 'reference'}；preserve=${binding.preserve.join(',') || 'unspecified'}；ignore=${binding.ignore.join(',') || 'none'}`,
      });
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${asset.mimeType};base64,${bytes.toString('base64')}`, detail: 'high' },
      });
    } catch (error) {
      console.warn(`[ai] skipped unreadable vision asset ${binding.assetId}: ${error instanceof Error ? error.message : error}`);
    }
  }
  return parts.some((part) => part.type === 'image_url') ? parts : text;
}

async function takeLastFrameContent(
  ctx: ProjectContext,
  take: ReturnType<typeof takesMod.getTake>,
  text: string,
): Promise<string | DirectorContentPart[]> {
  if (!take.lastFramePath) return `${text}\n\n该 Take 没有可读取的尾帧，只能依据文字上下文填写；无法确认的字段必须留空。`;
  try {
    const bytes = await readFile(ctx.resolveProjectPath(take.lastFramePath));
    if (bytes.byteLength > MAX_VISION_IMAGE_BYTES) {
      return `${text}\n\n尾帧超过识图大小限制，只能依据文字上下文填写；无法确认的字段必须留空。`;
    }
    return [
      { type: 'text', text: `${text}\n\n下方图片是 ${take.id} 的真实最后一帧。优先依据图片填写可见事实；单帧无法确认的内容不要猜测。` },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}`, detail: 'high' } },
    ];
  } catch (error) {
    console.warn(`[ai] failed to read take last frame ${take.id}: ${error instanceof Error ? error.message : error}`);
    return `${text}\n\n尾帧读取失败，只能依据文字上下文填写；无法确认的字段必须留空。`;
  }
}

function visualContinuitySuggestion(raw: unknown, entities: ReturnType<typeof assetsMod.listEntities>, states: ReturnType<typeof assetsMod.listCharacterStates>): VisualContinuityState {
  const value = raw && typeof raw === 'object' && 'state' in raw
    ? (raw as { state?: unknown }).state
    : raw;
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const entityIds = new Set(entities.map((entity) => entity.id));
  const stateOwner = new Map(states.map((state) => [state.id, state.characterId]));
  const stringMap = (input: unknown): Record<string, string> => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    return Object.fromEntries(Object.entries(input as Record<string, unknown>)
      .filter(([id, text]) => entityIds.has(id) && typeof text === 'string' && text.trim())
      .map(([id, text]) => [id, String(text).trim()]));
  };
  const characterStates = stringMap(source.characterStates);
  for (const [entityId, stateId] of Object.entries(characterStates)) {
    if (stateOwner.get(stateId) !== entityId) delete characterStates[entityId];
  }
  const heldItems: Record<string, string[]> = {};
  if (source.heldItems && typeof source.heldItems === 'object' && !Array.isArray(source.heldItems)) {
    for (const [entityId, items] of Object.entries(source.heldItems as Record<string, unknown>)) {
      if (!entityIds.has(entityId) || !Array.isArray(items)) continue;
      const clean = items.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
      if (clean.length) heldItems[entityId] = clean;
    }
  }
  const text = (key: string) => typeof source[key] === 'string' ? String(source[key]).trim() : '';
  return {
    characterStates,
    costume: stringMap(source.costume),
    hair: stringMap(source.hair),
    injury: stringMap(source.injury),
    heldItems,
    location: text('location'),
    timeOfDay: text('timeOfDay'),
    weather: text('weather'),
    wind: text('wind'),
    screenDirection: text('screenDirection'),
    facing: text('facing'),
    vehicleState: stringMap(source.vehicleState),
    notes: text('notes'),
  };
}

function requireAiDirectorPlan(raw: unknown, base: DirectorPlan): DirectorPlan {
  const normalized = directorMod.normalizeDirectorPlan(raw, base);
  if (!normalized.ok || !normalized.plan) {
    throw new Error(`AI 返回的导演计划格式无效：${normalized.error ?? '无法识别'}`);
  }
  const required = [
    ['镜头目标', normalized.plan.intent.visualThesis],
    ['主体动作', normalized.plan.subject.action],
    ['摄影机', normalized.plan.camera.dominantBehavior],
    ['结束画面', normalized.plan.intent.endState],
  ].filter(([, value]) => !value).map(([label]) => label);
  if (required.length) {
    throw new Error(`AI 返回内容不完整，缺少：${required.join('、')}。未保存，请重试或手动填写。`);
  }
  return normalized.plan;
}

async function normalizeOrRepairAiDirectorPlan(
  model: DirectorModel,
  raw: unknown,
  base: DirectorPlan,
): Promise<DirectorPlan> {
  try {
    return requireAiDirectorPlan(raw, base);
  } catch {
    const repaired = await model.structured<unknown>({
      system: `你是 DirectorPlan 数据格式修复器。只修复字段结构、命名和数据类型，不重新创作，不增加原候选内容和当前草稿中不存在的故事事实。缺失字段优先沿用当前草稿。只返回符合 schema 的完整 JSON 对象。\n${PLAN_SCHEMA_HINT}`,
      messages: [{
        role: 'user',
        content: `当前草稿：\n${JSON.stringify(base)}\n\n待修复的 AI 返回：\n${JSON.stringify(raw)}`,
      }],
      temperature: 0,
    });
    try {
      return requireAiDirectorPlan(repaired, base);
    } catch (second) {
      const reason = second instanceof Error ? second.message : String(second);
      throw new Error(`AI 返回格式自动修复后仍不可用：${reason}`);
    }
  }
}

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
  const suppliedPlan = body.plan ? directorMod.normalizeDirectorPlan(body.plan).plan : null;
  const plan = shotId ? suppliedPlan ?? directorMod.latestPlan(ctx, shotId)?.plan ?? emptyDirectorPlan() : null;
  let vision: VisionStatus | null = null;
  const trackVision = (status: VisionStatus) => { vision = status; };
  const withVision = <T extends Record<string, unknown>>(result: T): T & { vision: VisionStatus | null } => ({ ...result, vision });

  switch (action as ActionName) {
    case 'plan_shot': {
      if (!shotId) throw new Error('shotId required');
      const raw = await ai.model.structured<unknown>({
        system: `${DIRECTOR_SYSTEM_PROMPT}\n\n专业方法参考：\n${skillText}\n\n${PLAN_SCHEMA_HINT}`,
        messages: [{ role: 'user', content: await shotMultimodalContent(ctx, shotId, planShotPrompt(ctx, shotId, body)) }],
        temperature: 0.6,
        onVisionStatus: trackVision,
      });
      const dp = await normalizeOrRepairAiDirectorPlan(ai.model, raw, plan ?? emptyDirectorPlan());
      return withVision({ kind: 'director_plan', plan: dp });
    }
    case 'improve_camera': {
      if (!shotId) throw new Error('shotId required');
      const raw = await ai.model.structured<unknown>({
        system: `你是 H3 镜头设计模式库。只改进给定方案的 camera 块，其他块保持不变，返回完整方案 JSON。所有字段内容一律使用中文。\n${PLAN_SCHEMA_HINT}`,
        messages: [{ role: 'user', content: await shotMultimodalContent(ctx, shotId, `Plan:\n${JSON.stringify(plan)}\nRequest: ${String(body.request ?? 'Improve camera design.')}\n\n只有实际看见附图时才能修正空间方位；看不到图时不得猜测。`) }],
        temperature: 0.5,
        onVisionStatus: trackVision,
      });
      const dp = await normalizeOrRepairAiDirectorPlan(ai.model, raw, plan ?? emptyDirectorPlan());
      return withVision({ kind: 'director_plan', plan: dp });
    }
    case 'improve_performance': {
      if (!shotId) throw new Error('shotId required');
      const raw = await ai.model.structured<unknown>({
        system: `你是 H3 表演导演。只改进给定方案的 performance 块（objective/obstacle/tactic/turn、movement quality、anticipation、primaryAction、followThrough、recovery、gaze、endPose），其他块保持不变，返回完整方案 JSON。所有字段内容一律使用中文。动作描述必须确定性完整：身体部位＋方向＋先后顺序＋空间参照，展开压缩动作为连续动作链，杜绝左右侧/主体/顺序歧义。\n${PLAN_SCHEMA_HINT}`,
        messages: [{ role: 'user', content: await shotMultimodalContent(ctx, shotId, `Plan:\n${JSON.stringify(plan)}\nRequest: ${String(body.request ?? 'Improve the performance.')}\n\n只有实际看见附图时才能描述身体与物体的空间关系；看不到图时不得猜测。`) }],
        temperature: 0.5,
        onVisionStatus: trackVision,
      });
      const dp = await normalizeOrRepairAiDirectorPlan(ai.model, raw, plan ?? emptyDirectorPlan());
      return withVision({ kind: 'director_plan', plan: dp });
    }
    case 'reality_check': {
      if (!shotId) throw new Error('shotId required');
      const text = await ai.model.complete({
        system: `你是物理与现实审查员。对照检查该镜头：几何结构、重力支撑接触、惯性动量、因果、介质规律、生物解剖、载具机械、光影、时间连续性、已知事实矛盾。只故意违反一条定律而非到处破绽。每个问题输出一行“问题：… | 严重度：轻微/严重 | 修复：…”，最后输出一行结论。只用中文。`,
        messages: [{ role: 'user', content: await shotMultimodalContent(ctx, shotId, `Plan:\n${JSON.stringify(plan)}\n\nReality mode: ${plan?.reality.mode ?? 'strict_realism'}\n\n附图可读时可检查可见几何；不可读时只审查文字事实。`) }],
        temperature: 0.3,
        onVisionStatus: trackVision,
      });
      return withVision({ kind: 'review', text });
    }
    case 'continuity_check': {
      if (!shotId) throw new Error('shotId required');
      const latest = continuityMod.predecessorContinuity(ctx, shotId, 'visual', 'actual');
      const text = await ai.model.complete({
        system: `你是专业的影视连续性审查员。将当前镜头的计划起始状态与上一镜头已经确认的实际连续性进行比较，检查角色外观、服装、发型、伤势、持有物、地点、时间与天气、银幕方向和朝向。不得虚构缺失信息。逐项使用“不一致：… | 修复：…”输出，最后输出“结论：通过”或“结论：需要修正”。如果当前镜头没有上一镜头，直接输出“无上一镜头，本项不适用。\n结论：通过”。只使用中文。`,
        messages: [
          { role: 'user', content: `Committed actual continuity:\n${JSON.stringify(latest?.state)}\n\nNew shot plan start state:\n${plan?.continuity.plannedStartState}\n\nShot:\n${JSON.stringify(shot)}` },
        ],
        temperature: 0.3,
      });
      return { kind: 'review', text };
    }
    case 'compile_prompt': {
      if (!shotId) throw new Error('shotId required');
      const current = promptMod.listPrompts(ctx, shotId).at(-1);
      if (!current) throw new Error('请先从镜头设计生成或手动输入一版提示词');
      const text = await ai.model.complete({
        system: `你是专业的 MiniMax H3 视频提示词编辑，严格遵循 H3 官方提示词规范。
结构规则（必须保留段落与顺序、参考标签 <Picture n>/<Audio n>/<Subject n> 及其全文一致性）：
- 基础模式：对齐行（首帧/尾帧引用声明）→ integrated_multimodal_description → overall_soundscape → non_diegetic_music；
- Ref2VA：subject_definitions → summary → retention_analysis → detailed_description → overall_soundscape → non_diegetic_music。
Ref2VA 专项规则：
1. subject_definitions 必须给每个被追踪内容显式定义标签：<Subject 1> 是主体（引用其身份图 <Picture n> 为外观来源），其余参考内容各占一行定义，不留未解析的标签。
2. summary 必须以固定英文任务类型前缀开头（如 [image reference]、[image reference + keyframe completion]、[image reference + audio reference]）。
3. retention_analysis 每行必须使用固定英文关系标记——视觉：fully_preserved / partially_preserved / attribute_transfer / weak_reference；音频：fully_copy / partially_copy / reference / weak_reference，后接简短说明。
4. 首帧/尾帧指定的参考图在 detailed_description 中用自然语句锚定时间轴（如“视频从 <Picture 1> 的构图开始”）。
5. detailed_description 中每个主体首次出现时必须使用其 <Subject n> 标签（如“<Subject 1> 缓慢抬头”），不得只写名称或只引用 <Picture n>。
6. 环境连续性（帧桥接必写）：若参考图是上一镜头的结尾画面，必须明确锁定机位与方位——具体写出画面中各元素在哪一侧（如“长桌从左向右延伸、胶片在画面右侧”），并声明“禁止镜像、禁止换侧”；只说“与 <Picture n> 一致”不够，要把方位细节描述出来。
7. 帧模式（I2VA/L2VA/FL2VA）首帧/尾帧内容锚定：请求附带且你确实能读取帧图时，先描述图内可见的主体、构图、场景层次（前景/中景/背景）与关键物体，再展开动作；主体外观、服装、颜色、关键物体与空间关系全程与帧图保持一致。若没有收到或无法读取图片，只保留当前提示词已有事实，严禁新增左右方位或空间关系。
8. 动作因果与对象被动性：明确谁是运动的发出者。涉及主体作用于物体的动作（拿取/推动/碰撞）时：(a) 把主体的运动过程按时间段写满整个时长（如“视频前两秒 <Subject 1> 迈步靠近；随后双手接触并拾起”），不给模型留空白时间片；(b) 被动物体用【正向描述】锁定——“<Subject n> 是桌面上的静物，保持位置不变”，禁止用否定句（“不会滑动不滚动”——否定句遵循度低）；(c) 写明“画面中唯一的位移来自 <Subject 1> 的身体”。
动作确定性规则：每个动作必须写全“身体部位＋方向＋先后顺序＋空间参照”，把压缩动作展开为不可歧义的连续动作链。例如不写“打开车门并上车”，而写“他走到驾驶座一侧，左手拉开左侧车门，先迈右腿坐进座位，收左腿后用左手关上车门”。杜绝左右侧、主体归属、动作顺序的一切误判空间。
其他：只优化清晰度与紧凑度，保留全部事实、参考标签和镜头意图，不增加事件。正文保持中文（<Subject n>/<Picture n> 等标签和任务类型前缀等结构性标记除外）。只输出提示词正文，不要解释。`,
        messages: [{
          role: 'user',
          content: await shotMultimodalContent(ctx, shotId, `当前提示词：\n${current.text}\n\n生成模式：${current.h3Mode}\n\n视觉输入规则：只有实际看见下方附图时才能修正画面位置；若接口降级为纯文字或图片不可见，保留原有空间描述，缺失信息不要补写。`),
        }],
        temperature: 0.4,
        onVisionStatus: trackVision,
      });
      return withVision({ kind: 'prompt', text });
    }
    case 'diagnose_take': {
      const takeId = body.takeId ? String(body.takeId) : null;
      if (!takeId) throw new Error('takeId required');
      const take = takesMod.getTake(ctx, takeId);
      const prompt = promptMod.getPrompt(ctx, take.promptVersionId);
      const text = await ai.model.complete({
        system: `你诊断失败的 H3 生成。输入：导演方案、提示词、参考素材标签、失败标签、Take 备注。按可能性排序输出原因和具体可尝试的修复（改方案、换参考角色、改提示词）。绝不建议再花钱重渲染。只用中文。`,
        messages: [
          {
            role: 'user',
            content: await shotMultimodalContent(ctx, take.shotId, `DirectorPlan:\n${JSON.stringify(plan)}\n\nPrompt:\n${prompt.text}\n\nFailure tags: ${take.failureTags.join(', ')}\nNotes: ${take.notes}\n\n只有实际看见附图时才能诊断视觉位置关系；不可见时不要猜测。`),
          },
        ],
        temperature: 0.4,
        onVisionStatus: trackVision,
      });
      return withVision({ kind: 'diagnosis', text });
    }
    case 'analyze_take_continuity': {
      const takeId = body.takeId ? String(body.takeId) : null;
      if (!takeId) throw new Error('takeId required');
      const take = takesMod.getTake(ctx, takeId);
      const takeShot = shotsMod.getShot(ctx, take.shotId);
      const takePlan = directorMod.latestPlan(ctx, take.shotId)?.plan ?? null;
      const entities = assetsMod.listEntities(ctx);
      const states = assetsMod.listCharacterStates(ctx);
      const empty = continuityMod.emptyVisualState();
      const raw = await ai.model.structured<unknown>({
        system: `你是影视场记员。读取生成视频的真实最后一帧，提取下一镜头必须延续的 Actual Visual Continuity。
只返回一个完整 JSON 对象，字段严格为：characterStates、costume、hair、injury、heldItems、location、timeOfDay、weather、wind、screenDirection、facing、vehicleState、notes。
characterStates/costume/hair/injury/heldItems/vehicleState 的 key 必须使用给定实体 id，不能使用人物名字。characterStates 的 value 只能从给定 CharacterState id 中选择，不能新造 id。
只记录最后一帧实际可见或文字上下文明确给出的、会影响下一镜衔接的状态。单帧无法判断运动方向、风力、伤势或手持物时留空；不要把剧情推测写成事实。
对 creature（动物、机器人或非人类角色）：优先关联给定 CharacterState。固定身份特征（犬种、固有毛色、脸部花纹、常驻项圈、机器人固有外壳）不得重复填写到 costume/hair；只有相对默认状态发生了变化（如新增服饰、湿毛、泥污、破损）才填写 costume/hair。没有变化就保持空对象。
如果图片不可见或请求降级为纯文字，只能采用镜头计划明确声明的结束状态和给定资产状态；其余字段留空，并在 notes 说明“AI 未读取尾帧，建议人工确认”。`,
        messages: [{
          role: 'user',
          content: await takeLastFrameContent(ctx, take, `Take: ${JSON.stringify({ id: take.id, shotId: take.shotId })}
Shot: ${JSON.stringify(takeShot)}
DirectorPlan end state: ${JSON.stringify({ intent: takePlan?.intent.endState, blocking: takePlan?.blocking.endPosition, endPose: takePlan?.performance.endPose, continuity: takePlan?.continuity.plannedEndState })}
Entities: ${JSON.stringify(entities)}
Allowed CharacterStates: ${JSON.stringify(states)}
Empty output shape: ${JSON.stringify(empty)}`),
        }],
        temperature: 0.1,
        onVisionStatus: trackVision,
      });
      return withVision({ kind: 'continuity_suggestion', state: visualContinuitySuggestion(raw, entities, states) });
    }
    case 'repair_prompt': {
      const promptId = body.promptId ? String(body.promptId) : null;
      if (!promptId) throw new Error('promptId required');
      const pv = promptMod.getPrompt(ctx, promptId);
      const text = await ai.model.complete({
        system: `你是 H3 提示词修复器。只修复指出的问题，其余内容保持不变；输出语言与原提示词一致（原文无英文必要时用中文）。只输出修复后的提示词正文。`,
        messages: [{ role: 'user', content: await shotMultimodalContent(ctx, pv.shotId, `Prompt:\n${pv.text}\n\nProblems: ${String(body.problems ?? '')}\n\n空间位置只能依据实际可见附图修复；图片不可见时不得猜测。`) }],
        temperature: 0.3,
        onVisionStatus: trackVision,
      });
      return withVision({ kind: 'prompt', text });
    }
    case 'story_to_beats': {
      const story = storyMod.getStory(ctx);
      const firstSystem = `你把故事拆成 StoryBeats。每个 beat：title、category（setup|inciting_incident|rising_action|climax|falling_action|resolution|transition|other）、summary、location、timeOfDay、weather、characters（实体名）、stateChange、durationSeconds（1-15）。所有 beat 的 durationSeconds 之和尽量等于计划总时长。

时长分配必须从动作分析倒推：把每个 beat 的动作拆成子步骤（如“走近→接触→拾起→抱起→转身”），按真实物理节奏给每一步留秒数（行走约每米1秒、拾取约1.5-2秒、转身约1秒），加总后向上取整作为该 beat 的 durationSeconds。优先落在 8-12 秒（理想 10 秒左右）：5 秒以下的 beat 会过碎、剪辑困难；15 秒成本高。若动作链在 15 秒内装不下，必须把该 beat 拆成多个 beat，绝不压缩动作。一个 beat 容纳“一个完整动作+其直接反应”。title、summary 等文字字段一律用中文。

FORMAT (STRICT): Reply with ONLY a JSON array. REQUIRED fields on every element: "title" (string), "summary" (string). Optional: category, location, timeOfDay, weather, characters, stateChange, durationSeconds. No prose. No markdown. No code fences. No tables. Begin with '[' and end with ']'. Example:
[{"title":"节拍标题","summary":"一句话概括","category":"setup","location":"","timeOfDay":"","weather":"","characters":[],"stateChange":"","durationSeconds":5}]`;
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
        system: `你把 StoryBeats 转成 H3 镜头序列。默认一个镜头=一个连续事件。每个镜头：title、purpose（中文）、shotFunction（establishing|wide|medium|closeup|insert|reaction|action|transition|montage|pov|aerial|dialogue|other）、durationSeconds（1-15，以 beat 的 durationSeconds 为基准）、h3Mode（t2va|i2va|fl2va|l2va|ref2va）。title 和 purpose 一律用中文。只返回 JSON 数组。`,
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
        const rawPlan = await ai.model.structured<unknown>({
          system: `${DIRECTOR_SYSTEM_PROMPT}\n\n专业方法参考：\n${skillText}\n\n${PLAN_SCHEMA_HINT}`,
          messages: [{ role: 'user', content: planShotPrompt(ctx, shot.id, {}) }],
          temperature: 0.6,
        });
        const dp = await normalizeOrRepairAiDirectorPlan(ai.model, rawPlan, emptyDirectorPlan());
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
  const plan = body.plan && typeof body.plan === 'object'
    ? body.plan
    : directorMod.latestPlan(ctx, shotId)?.plan ?? null;
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
References: ${JSON.stringify(refs)}
Committed actual continuity: ${JSON.stringify(latest?.state)}
Entities: ${JSON.stringify(entities)}
Character states: ${JSON.stringify(states)}
Request: ${String(body.request ?? 'Produce the DirectorPlan for this shot.')}`;
}
