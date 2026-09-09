// Deterministic Prompt Compiler — PRD §19. Externalized templates, fixed
// section order, no fact invention: every line comes from DirectorPlan fields
// or reference labels, and empty fields are skipped.
//
// Output structure matches what a running MiniMax H3 workflow expects
// (verified 2026-08-19 from MiniMax-H3 h3-prompt-writing):
//   base modes:  [alignment line] integrated_multimodal_description →
//                overall_soundscape → non_diegetic_music
//   Ref2VA:      subject_definitions → summary → retention_analysis →
//                detailed_description → overall_soundscape → non_diegetic_music
// References are numbered per media type (<Picture 1>, <Video 1>, <Audio 1>)
// and their labels stay consistent across sections.

import type { DirectorPlan, H3Mode, ReferenceBinding, Shot, StoryBeat } from '@h3mise/shared';

export interface CompileContext {
  shot: Shot;
  plan: DirectorPlan;
  references: ReferenceBinding[];
  /** Generation mode this prompt is compiled for (set by compileDeterministic). */
  mode?: H3Mode;
  directorStyle?: string;
  /** Deterministic camera-plan summary (motion wording + bounds note). */
  cameraPlan?: string;
  /** Canonical narrative facts. The StoryBeat defines what happens in this
   * shot; the episode premise explains why it matters without advancing later
   * events early. */
  story?: { title: string; synopsis: string; body?: string };
  storyBeat?: Pick<StoryBeat, 'title' | 'summary' | 'stateChange'> | null;
}

interface NumberedRef {
  binding: ReferenceBinding;
  tag: string; // <Picture 1>
}

function numberReferences(references: ReferenceBinding[]): {
  pictures: NumberedRef[];
  videos: NumberedRef[];
  audios: NumberedRef[];
} {
  const out = { pictures: [] as NumberedRef[], videos: [] as NumberedRef[], audios: [] as NumberedRef[] };
  const counters = { image: 0, video: 0, audio: 0 };
  const kindName = { image: 'Picture', video: 'Video', audio: 'Audio' } as const;
  for (const r of references) {
    const c = ++counters[r.type]!;
    const tag = `<${kindName[r.type]} ${c}>`;
    if (r.type === 'image') out.pictures.push({ binding: r, tag });
    else if (r.type === 'video') out.videos.push({ binding: r, tag });
    else out.audios.push({ binding: r, tag });
  }
  return out;
}

export function compileDeterministic(ctx: CompileContext, mode: H3Mode): string {
  const { plan } = ctx;
  // References are mode inputs, not a shared fallback pool. Ref2VA consumes
  // generic image/audio bindings — INCLUDING a first_frame-designated one,
  // which stays among the numbered pictures and is declared as the start
  // frame inside the prompt (H3 assigns tasks per reference in text).
  const references = ctx.references.filter((reference) => {
    const isFrame = reference.roles.includes('first_frame') || reference.roles.includes('last_frame');
    if (mode === 'ref2va') return reference.type === 'image' || reference.type === 'audio';
    if (mode === 'i2va') return reference.roles.includes('first_frame');
    if (mode === 'l2va') return reference.roles.includes('last_frame');
    if (mode === 'fl2va') return isFrame;
    return false;
  });
  const modeCtx = { ...ctx, mode, references };
  const num = numberReferences(references);
  const refLabel = (b: ReferenceBinding) => (b.label ? `(${b.label})` : '');
  const firstFrame = num.pictures.find((p) => p.binding.roles.includes('first_frame'));
  const lastFrame = num.pictures.find((p) => p.binding.roles.includes('last_frame'));

  if (mode === 'ref2va') {
    const sections = [
      subjectDefinitions(modeCtx, num),
      summary(modeCtx, num),
      retentionAnalysis(modeCtx, num),
      detailedDescription(modeCtx, num),
      overallSoundscape(modeCtx),
      nonDiegeticMusic(modeCtx),
    ];
    return sections.filter(Boolean).join('\n\n');
  }

  const blocks: string[] = [];
  // Alignment line for frame-based modes (I2VA/FL2VA/L2VA).
  if ((mode === 'i2va' || mode === 'fl2va') && firstFrame) {
    blocks.push(
      `For the target video, at 0.00 seconds into the target video, ${firstFrame.tag} ${refLabel(firstFrame.binding)} is fully referenced.`,
    );
  }
  if (mode === 'l2va' && lastFrame) {
    blocks.push(
      `For the target video, the last frame should fully reference ${lastFrame.tag} ${refLabel(lastFrame.binding)}.`,
    );
  }
  if (mode === 'fl2va' && lastFrame) {
    blocks.push(
      `For the target video, at the end of the video, ${lastFrame.tag} ${refLabel(lastFrame.binding)} is fully referenced.`,
    );
  }
  // Base-mode keyframe anchoring (base-en.txt §3): the model COMPREHENDS the
  // frame image, so establish what is visible inside it — subjects, position,
  // scene layers — before describing action; identity/colors/objects/spatial
  // relations must stay consistent with the frame throughout.
  const anchorFrame = mode === 'l2va' ? lastFrame : firstFrame;
  if (anchorFrame && (mode === 'i2va' || mode === 'fl2va' || mode === 'l2va')) {
    const { plan: fp } = modeCtx;
    const bits = [
      fp.subject.primarySubject.trim() && `主体：${fp.subject.primarySubject.trim()}`,
      fp.blocking.startPosition.trim() && `位置：${fp.blocking.startPosition.trim()}`,
      fp.environment.foreground.trim() && `前景：${fp.environment.foreground.trim()}`,
      fp.environment.midground.trim() && `中景：${fp.environment.midground.trim()}`,
      fp.environment.background.trim() && `背景：${fp.environment.background.trim()}`,
    ].filter(Boolean);
    if (bits.length) {
      const roleText =
        mode === 'l2va'
          ? `尾帧内容锚定（视频结束时画面应呈现 <Picture ${num.pictures.findIndex((p) => p.binding.roles.includes('last_frame')) + 1}> 中可见的内容）`
          : `首帧内容锚定（<Picture 1> 中可见）`;
      blocks.push(
        `${roleText}：${bits.join('；')}。后续动作与镜头运动均从该画面出发；主体外观、服装、颜色、关键物体与空间关系全程与该帧保持一致。`,
      );
    }
  }
  const imd = integratedMultimodalDescription(modeCtx, num);
  if (imd) blocks.push(imd);
  const sound = overallSoundscape(modeCtx);
  if (sound) blocks.push(sound);
  const music = nonDiegeticMusic(modeCtx);
  if (music) blocks.push(music);
  return blocks.filter(Boolean).join('\n\n');
}

// --- base mode blocks ------------------------------------------------------

function integratedMultimodalDescription(ctx: CompileContext, num: ReturnType<typeof numberReferences>): string {
  const { plan, references } = ctx;
  const refLines = [...num.pictures, ...num.videos, ...num.audios].map(({ binding, tag }) => {
    const roles = binding.roles.length ? ` roles: ${binding.roles.join(', ')}` : '';
    const keep = binding.preserve.length ? `; preserve: ${binding.preserve.join(', ')}` : '';
    const ignore = binding.ignore.length ? `; ignore: ${binding.ignore.join(', ')}` : '';
    return `${tag}${binding.label ? ` (${binding.label})` : ''}:${roles}${keep}${ignore}`;
  });
  const parts = [
    ...(refLines.length ? ['References:\n' + refLines.join('\n')] : []),
    line('Director style', ctx.directorStyle ?? ''),
    ...narrativeContextLines(ctx),
    // Shot title/purpose are canonical project facts. Keep them in every base
    // prompt even when a beginner project has not created a DirectorPlan yet.
    // Previously the fallback stored the story beat in visualThesis, but this
    // section never emitted intent fields, producing only "strict realism".
    line('Shot', ctx.shot.title),
    line('Narrative intent', ctx.shot.purpose),
    line('Visual thesis', plan.intent.visualThesis),
    line('Dramatic goal', plan.intent.dramaticGoal),
    line('Peak', plan.intent.peak),
    line('End state', plan.intent.endState),
    line('Subject', plan.subject.primarySubject),
    line('Motion owner', plan.subject.primaryMotionOwner),
    line('Action', plan.subject.action),
    line('Start position', plan.blocking.startPosition),
    line('End position', plan.blocking.endPosition),
    line('Facing', plan.blocking.facing),
    line('Movement axis', plan.blocking.movementAxis),
    line('Travel path', plan.blocking.travelPath),
    line('Spatial relationships', plan.blocking.spatialRelationships),
    ...cameraDescriptionLines(ctx),
    screenDirectionLine(ctx),
    temporalBeatsLine(ctx),
    performanceObjectiveLine(ctx),
    line('Obstacle', plan.performance.obstacle),
    line('Tactic', plan.performance.tactic),
    line('Performance turn', plan.performance.performanceTurn),
    line('Movement quality', [plan.performance.movementQuality.weight, plan.performance.movementQuality.time, plan.performance.movementQuality.space, plan.performance.movementQuality.flow].filter(Boolean).join(', ')),
    line('Anticipation', plan.performance.anticipation),
    line('Primary action', plan.performance.primaryAction),
    line('Follow-through', plan.performance.followThrough),
    line('Recovery', plan.performance.recovery),
    line('Gaze', plan.performance.gaze),
    line('End pose', plan.performance.endPose),
    line('Location', plan.environment.location),
    line('Weather', plan.environment.weather),
    line('Medium', plan.environment.medium),
    line('Wind', plan.environment.wind),
    line('Lighting', plan.environment.lighting),
    line('Foreground', plan.environment.foreground),
    line('Midground', plan.environment.midground),
    line('Background', plan.environment.background),
    line('Reality', plan.reality.mode.replace(/_/g, ' ') + (plan.reality.constraints.length ? ` (${plan.reality.constraints.join('; ')})` : '')),
    line('Start state', plan.continuity.plannedStartState),
    line('End state', plan.continuity.plannedEndState),
  ].filter(Boolean);
  if (parts.length === 0) return '';
  return `integrated_multimodal_description:\n${parts.join('\n')}`;
}

function overallSoundscape(ctx: CompileContext): string {
  const sound = ctx.plan.generation.audioIntent.trim();
  if (!sound) return '';
  return `overall_soundscape: ${sound}`;
}

function nonDiegeticMusic(ctx: CompileContext): string {
  const music = ctx.plan.generation.audioIntent.trim();
  if (!music || !/music|音乐|score|配乐/i.test(music)) return '';
  return `non_diegetic_music: ${music}`;
}

// --- Ref2VA sections -------------------------------------------------------

function subjectDefinitions(ctx: CompileContext, num: ReturnType<typeof numberReferences>): string {
  // H3 Ref2VA spec: every piece of tracked content gets an explicit label
  // definition. <Subject 1> carries the primary subject with its identity
  // pictures cited; remaining references are defined on their own lines so no
  // label stays unresolved later in the prompt. Body stays in Chinese.
  const lines: string[] = [];
  const primary = ctx.plan.subject.primarySubject.trim();
  const identities = num.pictures.filter((p) => p.binding.roles.includes('identity'));
  const { pictureSubject } = ctx.mode === 'ref2va' ? subjectMap(num) : { pictureSubject: new Map<string, number>() };
  if (identities.length) {
    for (const { binding, tag } of identities) {
      const n = pictureSubject.get(tag);
      if (!n) continue;
      lines.push(`<Subject ${n}> 是 ${referenceSubjectName(binding, identities.length === 1 ? primary : '')}，其外观以 ${tag} 为准。`);
    }
  } else if (primary) {
    lines.push(`<Subject 1> 是 ${primary}。`);
  }
  for (const { binding, tag } of num.pictures) {
    if (binding.roles.includes('identity')) continue;
    const n = pictureSubject.get(tag);
    if (!n) continue;
    const label = binding.label ? `（${binding.label}）` : '';
    const role =
      binding.roles.includes('first_frame')
        ? '，同时被指定为开场画面'
        : binding.roles.includes('last_frame')
          ? '，同时被指定为结尾画面'
          : '';
    lines.push(`<Subject ${n}> 是参考内容 ${tag}${label}${role}。`);
  }
  for (const { binding, tag } of num.audios) {
    lines.push(`${tag} 是参考音频${binding.label ? `（${binding.label}）` : ''}。`);
  }
  return lines.length ? `subject_definitions:\n${lines.join('\n')}` : '';
}

/** Fixed English task-type prefix required at the start of `summary`. */
function summaryTaskType(num: ReturnType<typeof numberReferences>): string {
  const tasks: string[] = [];
  if (num.pictures.length) tasks.push('image reference');
  if (num.pictures.some((p) => p.binding.roles.includes('first_frame') || p.binding.roles.includes('last_frame'))) {
    tasks.push('keyframe completion');
  }
  if (num.audios.length) tasks.push('audio reference');
  return `[${tasks.join(' + ')}]`;
}

function summary(ctx: CompileContext, num: ReturnType<typeof numberReferences>): string {
  const p = ctx.plan;
  const parts = [ctx.storyBeat?.title?.trim(), p.intent.visualThesis.trim(), p.intent.dramaticGoal.trim()]
    .filter((s): s is string => Boolean(s))
    .map((s) => s.replace(/[。.]+$/, ''));
  if (!parts.length) return '';
  return `summary: ${summaryTaskType(num)} ${parts.join('。')}。`;
}

function retentionAnalysis(ctx: CompileContext, num: ReturnType<typeof numberReferences>): string {
  // H3 Ref2VA spec: one line per reference with a FIXED English relationship
  // marker (fully_preserved / partially_preserved / attribute_transfer /
  // weak_reference for visuals; fully_copy / partially_copy / reference /
  // weak_reference for audio) plus a short Chinese explanation.
  const marker = (binding: ReferenceBinding): { mark: string; why: string } => {
    if (binding.roles.includes('first_frame')) return { mark: 'fully_preserved', why: '视频从该图构图开始，作为字面意义上的首帧' };
    if (binding.roles.includes('last_frame')) return { mark: 'fully_preserved', why: '视频在该图构图上结束，作为字面意义上的尾帧' };
    if (binding.roles.includes('identity')) return { mark: 'fully_preserved', why: '主体身份与外观完全沿用该图' };
    if (binding.roles.includes('environment')) return { mark: 'fully_preserved', why: '场景空间、结构与主要视觉特征沿用该图' };
    if (binding.ignore.length) return { mark: 'partially_preserved', why: `保留参考但忽略：${binding.ignore.join('、')}` };
    if (binding.preserve.length) return { mark: 'fully_preserved', why: '明确保留用户指定的参考特征' };
    return { mark: 'weak_reference', why: '仅提供风格、场景或氛围参考' };
  };
  const lines = [...num.pictures, ...num.videos, ...num.audios]
    .map(({ binding, tag }) => {
      const label = binding.label ? `（${binding.label}）` : '';
      const { mark, why } = binding.type === 'audio'
        ? { mark: 'reference', why: '仅参考其声音特质，不直接复制信号' }
        : marker(binding);
      const keep = binding.preserve.length ? `；需保留：${binding.preserve.join('、')}` : '';
      return `- ${tag}${label}: ${mark} - ${why}${keep}`;
    })
    .filter(Boolean);
  return lines.length ? `retention_analysis:\n${lines.join('\n')}` : '';
}

/** Subject numbering shared by subjectDefinitions and detailedDescription.
 * The first identity picture is Subject 1; every remaining picture gets a
 * stable distinct subject number in provider input order. */
function subjectMap(num: ReturnType<typeof numberReferences>): { pictureSubject: Map<string, number>; hasPrimary: boolean } {
  const pictureSubject = new Map<string, number>();
  const firstIdentity = num.pictures.find((picture) => picture.binding.roles.includes('identity'));
  if (firstIdentity) pictureSubject.set(firstIdentity.tag, 1);
  let next = 2;
  for (const { binding, tag } of num.pictures) {
    if (tag === firstIdentity?.tag) continue;
    pictureSubject.set(tag, next);
    next += 1;
  }
  return { pictureSubject, hasPrimary: true };
}

function detailedDescription(ctx: CompileContext, num: ReturnType<typeof numberReferences>): string {
  const refs = [...num.pictures, ...num.videos, ...num.audios].map(({ binding, tag }) => `${tag} ${binding.label || ''}`.trim()).filter(Boolean);
  const { plan } = ctx;
  const subjects = ctx.mode === 'ref2va' ? subjectMap(num) : null;
  // Ref2VA frame declarations: first/last-frame-designated pictures stay as
  // numbered references, and the prompt pins them as the literal opening /
  // final frames (reference mode uses no dedicated frame-slot nodes).
  const ref2vaFirst =
    ctx.mode === 'ref2va' ? num.pictures.find((p) => p.binding.roles.includes('first_frame')) : undefined;
  const ref2vaLast =
    ctx.mode === 'ref2va' ? num.pictures.find((p) => p.binding.roles.includes('last_frame')) : undefined;
  const startFrameLine = ref2vaFirst
    ? `First frame: the video begins with exactly the composition of ${ref2vaFirst.tag}${ref2vaFirst.binding.label ? ` (${ref2vaFirst.binding.label})` : ''} — treat it as the literal first frame, then animate from it.`
    : '';
  const endFrameLine = ref2vaLast
    ? `Last frame: the video ends with exactly the composition of ${ref2vaLast.tag}${ref2vaLast.binding.label ? ` (${ref2vaLast.binding.label})` : ''} — treat it as the literal final frame, and arrive at it exactly when the video ends.`
    : '';
  // Frame-bridge continuity: without a hard frame slot, the model still must
  // inherit camera side and object placement from the opening-frame image,
  // otherwise consecutive shots break screen direction (180° rule).
  const continuityLine = ref2vaFirst
    ? `Environment & camera continuity: 本镜头的机位、取景方向、环境布局与物体左右方位必须与 ${ref2vaFirst.tag}${ref2vaFirst.binding.label ? `（${ref2vaFirst.binding.label}）` : ''} 完全一致——它是上一镜头结束时的真实画面。画面中各元素在哪一侧就保持在哪一侧，禁止镜像、禁止换侧、禁止重摆。`
    : '';
  // Anchor each <Subject N> at its first appearance (H3 spec §5.3): one line
  // introducing all subjects with their source references.
  const subjectsLine = subjects
    ? (() => {
        const items: string[] = [];
        const identities = num.pictures.filter((picture) => picture.binding.roles.includes('identity'));
        if (!identities.length && plan.subject.primarySubject.trim()) items.push(`<Subject 1>（主体）`);
        for (const { binding, tag } of num.pictures) {
          const n = subjects.pictureSubject.get(tag);
          if (!n) continue;
          const role = binding.roles.includes('identity')
            ? `身份，来源 ${tag}${binding.label ? ` ${binding.label}` : ''}`
            : binding.roles.includes('first_frame')
            ? `开场画面，来源 ${tag}`
            : binding.roles.includes('last_frame')
              ? `结尾画面，来源 ${tag}`
              : `参考 ${tag}${binding.label ? ` ${binding.label}` : ''}`;
          items.push(`<Subject ${n}>（${role}）`);
        }
        return items.length ? `Subjects: ${items.join('，')}` : '';
      })()
    : '';
  const primaryTag = subjects && plan.subject.primarySubject.trim() ? '<Subject 1>' : '';
  const identitySubjects = num.pictures
    .filter((picture) => picture.binding.roles.includes('identity'))
    .map(({ binding, tag }) => `<Subject ${subjects?.pictureSubject.get(tag)}> ${referenceSubjectName(binding, '')}`);
  const subjectValue = identitySubjects.length
    ? identitySubjects.join('；')
    : plan.subject.primarySubject.trim() ? `${primaryTag} ${plan.subject.primarySubject.trim()}`.trim() : '';
  const identityControl = subjects ? identityControlLines(ctx, num, subjects) : [];
  const parts = [
    ...(refs.length ? [`References: ${refs.join(', ')}`] : []),
    ...(subjectsLine ? [subjectsLine] : []),
    ...identityControl,
    ...(startFrameLine ? [startFrameLine] : []),
    ...(endFrameLine ? [endFrameLine] : []),
    ...(continuityLine ? [continuityLine] : []),
    line('Director style', ctx.directorStyle ?? ''),
    ...narrativeContextLines(ctx),
    line('Subject', subjectValue),
    line('Action', plan.subject.action),
    line('Start position', plan.blocking.startPosition),
    line('End position', plan.blocking.endPosition),
    line('Facing', plan.blocking.facing),
    line('Movement axis', plan.blocking.movementAxis),
    line('Travel path', plan.blocking.travelPath),
    ...cameraDescriptionLines(ctx),
    screenDirectionLine(ctx),
    temporalBeatsLine(ctx),
    performanceObjectiveLine(ctx),
    line('Obstacle', plan.performance.obstacle),
    line('Tactic', plan.performance.tactic),
    line('Performance turn', plan.performance.performanceTurn),
    line('Movement quality', [plan.performance.movementQuality.weight, plan.performance.movementQuality.time, plan.performance.movementQuality.space, plan.performance.movementQuality.flow].filter(Boolean).join(', ')),
    line('Anticipation', plan.performance.anticipation),
    line('Primary action', plan.performance.primaryAction),
    line('Follow-through', plan.performance.followThrough),
    line('Recovery', plan.performance.recovery),
    gazeDescriptionLine(ctx),
    line('End pose', plan.performance.endPose),
    line('Location', plan.environment.location),
    line('Weather', plan.environment.weather),
    line('Medium', plan.environment.medium),
    line('Wind', plan.environment.wind),
    line('Lighting', plan.environment.lighting),
    line('Foreground', plan.environment.foreground),
    line('Midground', plan.environment.midground),
    line('Background', plan.environment.background),
    line('Reality', plan.reality.mode.replace(/_/g, ' ') + (plan.reality.constraints.length ? ` (${plan.reality.constraints.join('; ')})` : '')),
    line('Start state', plan.continuity.plannedStartState),
    line('End state', plan.continuity.plannedEndState),
  ].filter(Boolean);
  return parts.length ? `detailed_description:\n${parts.join('\n')}` : '';
}

function narrativeContextLines(ctx: CompileContext): string[] {
  const story = ctx.story;
  const beat = ctx.storyBeat;
  if (!story?.synopsis.trim() && !beat?.summary.trim()) return [];
  const scriptDialogue = beat ? relevantScriptDialogue(story?.body ?? '', beat.summary) : [];
  const quotedDialogue = (beat?.summary.match(/“[^”]+”/gu) ?? []).map((text) => text.slice(1, -1));
  const spokenLines = scriptDialogue.length
    ? scriptDialogue.map(({ speaker, text }) => `${speaker}：“${text}”`)
    : quotedDialogue.map((text) => `“${text}”`);
  return [
    story?.synopsis.trim() ? line('Episode premise', `${story.title}：${story.synopsis}`) : '',
    beat?.summary.trim() ? line('Current story beat — authoritative event scope', `${beat.title}：${beat.summary}`) : '',
    beat?.stateChange?.trim() ? line('Narrative change', beat.stateChange) : '',
    spokenLines.length ? line('Spoken lines', `按原始正文中的说话人和先后顺序逐字呈现：${spokenLines.join(' → ')}`) : '',
    line('Storytelling priority', '观众必须能从动作、表演、对白和声音理解当前剧情节拍及其因果；摄影设计只负责清楚呈现该事件，不得用氛围或技术描述取代剧情，也不得提前演出后续节拍'),
  ].filter((value): value is string => Boolean(value));
}

function relevantScriptDialogue(body: string, beatSummary: string): Array<{ speaker: string; text: string }> {
  if (!body.trim() || !beatSummary.trim()) return [];
  const lines = body.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  const dialogue: Array<{ speaker: string; text: string }> = [];
  for (let index = 0; index < lines.length - 1; index++) {
    const speaker = lines[index]!.match(/^([^：:]{1,24})[：:]$/u)?.[1]?.trim();
    if (!speaker) continue;
    const text = lines[index + 1]!;
    if (!text || /^[^：:]{1,24}[：:]$/u.test(text)) continue;
    dialogue.push({ speaker, text });
  }
  const normalizedSummary = normalizeNarrativeText(beatSummary);
  return dialogue.filter(({ text }) => {
    const normalized = normalizeNarrativeText(text);
    if (!normalized) return false;
    if (normalizedSummary.includes(normalized)) return true;
    const grams = bigrams(normalized);
    if (!grams.size) return normalizedSummary.includes(normalized);
    const summaryGrams = bigrams(normalizedSummary);
    let overlap = 0;
    for (const gram of grams) if (summaryGrams.has(gram)) overlap++;
    return overlap / grams.size >= 0.5;
  });
}

function normalizeNarrativeText(value: string): string {
  return value.toLocaleLowerCase().replace(/[\s，。！？、；：“”‘’…,.!?;:'"-]/gu, '');
}

function bigrams(value: string): Set<string> {
  if (value.length < 2) return new Set(value ? [value] : []);
  return new Set(Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2)));
}

function identityControlLines(
  ctx: CompileContext,
  num: ReturnType<typeof numberReferences>,
  subjects: ReturnType<typeof subjectMap>,
): string[] {
  const identities = num.pictures.filter((picture) => picture.binding.roles.includes('identity'));
  if (identities.length < 2) return [];

  const cast = identities.map(({ binding, tag }) => {
    const subjectTag = `<Subject ${subjects.pictureSubject.get(tag)}>`;
    return `${subjectTag} ${referenceSubjectName(binding, '')}`;
  });
  const lines = [
    `Cast lock: 画面中的人物集合严格等于以下 ${cast.length} 位：${cast.join('、')}；每位只出现一次，保持各自身份，不合并、不复制、不生成替身或相似人物。`,
  ];

  const environmentRefs = num.pictures.filter((picture) => picture.binding.roles.includes('environment'));
  if (environmentRefs.length) {
    lines.push(`Environment plate: ${environmentRefs.map(({ tag }) => tag).join('、')} 只定义建筑、家具、灯光与空间关系；画面人物完全由上述 Cast lock 唯一决定。`);
  }

  const aspectRatio = ctx.plan.generation.aspectRatio || ctx.shot.aspectRatio;
  const distantWide = /wide|全景|远景/i.test(ctx.plan.camera.shotSizeStart);
  if (aspectRatio === '9:16' && identities.length >= 3 && distantWide) {
    const owner = ctx.plan.subject.primaryMotionOwner.trim();
    const ownerEntry = identities.find(({ binding }) => referenceSubjectName(binding, '').toLocaleLowerCase() === owner.toLocaleLowerCase());
    const ownerTag = ownerEntry ? `<Subject ${subjects.pictureSubject.get(ownerEntry.tag)}> ${owner}` : owner;
    lines.push(`Composition priority: 9:16 竖幅多人构图优先保证${ownerTag ? `主要动作人物 ${ownerTag}` : '主要动作人物'}的上半身、双手与表情清晰可辨，其余人物也须能辨认身份；允许裁掉非关键房间边缘，不使用让三人都显得遥远的极远全景。`);
  }
  return lines;
}

function gazeDescriptionLine(ctx: CompileContext): string {
  const gaze = ctx.plan.performance.gaze.trim();
  if (!gaze) return '';
  if (/看向镜头|直视镜头|look(?:s|ing)? (?:at|into) (?:the )?(?:camera|lens)/i.test(gaze)) return line('Gaze', gaze);
  return line('Gaze lock', `${gaze}；以上目标是各角色唯一视线目标，视线不转向摄影机或观众`);
}

function line(section: string, value: string | null | undefined): string {
  const v = value?.trim() ?? '';
  return v ? `${section}: ${v}` : '';
}

function referenceSubjectName(binding: ReferenceBinding, fallback: string): string {
  const fromLabel = binding.label
    .replace(/\s*[·•｜|]\s*(主图|身份图|参考图).*$/u, '')
    .trim();
  return fromLabel || fallback || '参考主体';
}

function cameraDescriptionLines(ctx: CompileContext): string[] {
  const { camera } = ctx.plan;
  const combined = [camera.geometry, camera.dominantBehavior, ctx.cameraPlan].filter(Boolean).join(' ');
  const fixed = /固定|锁定|静止|fixed|locked|static/i.test(combined);
  return [
    line('Shot size', camera.shotSizeStart),
    fixed ? line('Framing lock', `${camera.shotSizeStart || '当前景别'}保持不变；全程禁止推拉、变焦、重新取景或景别变化`) : line('Shot size at peak', camera.shotSizePeak),
    fixed ? '' : line('Shot size at end', camera.shotSizeEnd),
    line('Camera geometry', camera.geometry),
    line('Lens intent', camera.lensIntent),
    line('Camera behavior', camera.dominantBehavior),
    fixed ? '' : line('Camera trigger', camera.trigger),
    fixed ? '' : line('Speed relation', camera.speedRelation),
    line('Stop condition', camera.stopCondition),
    line('Camera planning', ctx.cameraPlan ?? ''),
  ].filter((value): value is string => Boolean(value));
}

function performanceObjectiveLine(ctx: CompileContext): string {
  const { plan } = ctx;
  const objective = plan.performance.objective.trim();
  const endState = `${plan.intent.endState} ${plan.continuity.plannedEndState}`;
  const incompleteEnding = /到一半|未完成|尚未完成|仍在|继续|进行中|未结束/u.test(endState);
  const completionObjective = /完成|结束|做完/u.test(objective);
  if (objective && completionObjective && incompleteEnding) {
    const observableGoal = plan.performance.performanceTurn.trim()
      || plan.subject.action.trim()
      || plan.performance.primaryAction.trim()
      || plan.intent.dramaticGoal.trim();
    return line('Objective', observableGoal || objective.replace(/完成|结束|做完/gu, '推进'));
  }
  return line('Objective', objective);
}

/** Deterministic screen-direction constraint (skipped for neutral). */
function screenDirectionLine(ctx: CompileContext): string {
  const dir = ctx.shot.screenDirection ?? 'neutral';
  if (dir === 'neutral') return '';
  const phrase = dir === 'left_to_right' ? 'left to right' : 'right to left';
  return line('Screen direction', `subjects move from ${phrase}; keep faces, action, and prop placement on their established side — no mirroring, no side swap`);
}

/** Time progression of temporal beats: "0.0s–2.0s Approach; 2.0s–5.0s Action". */
function temporalBeatsLine(ctx: CompileContext): string {
  const beats = ctx.plan.temporalBeats?.filter((b) => b.label.trim()) ?? [];
  if (!beats.length) return '';
  const dur = ctx.plan.generation.durationSeconds ?? ctx.shot.durationSeconds ?? 5;
  const fmt = (f: number) => (f * dur).toFixed(1);
  const segs = beats
    .sort((a, b) => a.start - b.start)
    .map((b) => `${fmt(b.start)}s–${fmt(b.end)}s ${b.label.trim()}`);
  return line('Time progression', segs.join('; '));
}
