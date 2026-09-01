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

import type { DirectorPlan, H3Mode, ReferenceBinding, Shot } from '@h3mise/shared';

export interface CompileContext {
  shot: Shot;
  plan: DirectorPlan;
  references: ReferenceBinding[];
  /** Generation mode this prompt is compiled for (set by compileDeterministic). */
  mode?: H3Mode;
  directorStyle?: string;
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
    line('Shot size', plan.camera.shotSizeStart),
    line('Shot size at peak', plan.camera.shotSizePeak),
    line('Shot size at end', plan.camera.shotSizeEnd),
    line('Camera geometry', plan.camera.geometry),
    line('Lens intent', plan.camera.lensIntent),
    line('Camera behavior', plan.camera.dominantBehavior),
    line('Camera trigger', plan.camera.trigger),
    line('Speed relation', plan.camera.speedRelation),
    line('Stop condition', plan.camera.stopCondition),
    line('Objective', plan.performance.objective),
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
  const s1: string[] = [];
  if (primary) s1.push(primary);
  if (identities.length) s1.push(`其外观以 ${identities.map((i) => i.tag).join('、')} 为准`);
  if (s1.length) lines.push(`<Subject 1> 是 ${s1.join('，')}。`);
  const { pictureSubject } = ctx.mode === 'ref2va' ? subjectMap(num) : { pictureSubject: new Map<string, number>() };
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
  const parts = [p.intent.visualThesis.trim(), p.intent.dramaticGoal.trim()]
    .filter(Boolean)
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
    if (binding.ignore.length) return { mark: 'partially_preserved', why: `保留参考但忽略：${binding.ignore.join('、')}` };
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

/** Subject numbering shared by subjectDefinitions and detailedDescription so
 * both sections agree on which <Subject N> maps to what. <Subject 1> is the
 * primary subject; every non-identity picture gets its own subject number. */
function subjectMap(num: ReturnType<typeof numberReferences>): { pictureSubject: Map<string, number>; hasPrimary: boolean } {
  const pictureSubject = new Map<string, number>();
  let next = 2;
  for (const { binding, tag } of num.pictures) {
    if (binding.roles.includes('identity')) continue;
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
        if (plan.subject.primarySubject.trim()) items.push(`<Subject 1>（主体）`);
        for (const { binding, tag } of num.pictures) {
          if (binding.roles.includes('identity')) continue;
          const n = subjects.pictureSubject.get(tag);
          if (!n) continue;
          const role = binding.roles.includes('first_frame')
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
  const subjectValue = plan.subject.primarySubject.trim()
    ? `${primaryTag} ${plan.subject.primarySubject.trim()}`.trim()
    : '';
  const parts = [
    ...(refs.length ? [`References: ${refs.join(', ')}`] : []),
    ...(subjectsLine ? [subjectsLine] : []),
    ...(startFrameLine ? [startFrameLine] : []),
    ...(endFrameLine ? [endFrameLine] : []),
    ...(continuityLine ? [continuityLine] : []),
    line('Director style', ctx.directorStyle ?? ''),
    line('Subject', subjectValue),
    line('Action', plan.subject.action),
    line('Start position', plan.blocking.startPosition),
    line('End position', plan.blocking.endPosition),
    line('Facing', plan.blocking.facing),
    line('Movement axis', plan.blocking.movementAxis),
    line('Travel path', plan.blocking.travelPath),
    line('Shot size', plan.camera.shotSizeStart),
    line('Shot size at peak', plan.camera.shotSizePeak),
    line('Shot size at end', plan.camera.shotSizeEnd),
    line('Camera geometry', plan.camera.geometry),
    line('Lens intent', plan.camera.lensIntent),
    line('Camera behavior', plan.camera.dominantBehavior),
    line('Camera trigger', plan.camera.trigger),
    line('Speed relation', plan.camera.speedRelation),
    line('Stop condition', plan.camera.stopCondition),
    line('Objective', plan.performance.objective),
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
  return parts.length ? `detailed_description:\n${parts.join('\n')}` : '';
}

function line(section: string, value: string | null | undefined): string {
  const v = value?.trim() ?? '';
  return v ? `${section}: ${v}` : '';
}
