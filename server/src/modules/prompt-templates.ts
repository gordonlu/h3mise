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
  // generic image/audio bindings; frame modes consume only their explicit
  // FirstFrame/LastFrame bindings.
  const references = ctx.references.filter((reference) => {
    const isFrame = reference.roles.includes('first_frame') || reference.roles.includes('last_frame');
    if (mode === 'ref2va') return !isFrame && (reference.type === 'image' || reference.type === 'audio');
    if (mode === 'i2va') return reference.roles.includes('first_frame');
    if (mode === 'l2va') return reference.roles.includes('last_frame');
    if (mode === 'fl2va') return isFrame;
    return false;
  });
  const modeCtx = { ...ctx, references };
  const num = numberReferences(references);
  const refLabel = (b: ReferenceBinding) => (b.label ? `(${b.label})` : '');
  const firstFrame = num.pictures.find((p) => p.binding.roles.includes('first_frame'));
  const lastFrame = num.pictures.find((p) => p.binding.roles.includes('last_frame'));

  if (mode === 'ref2va') {
    const sections = [
      subjectDefinitions(modeCtx, num),
      summary(modeCtx),
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
  const primary = ctx.plan.subject.primarySubject.trim();
  const others = num.pictures.filter(({ binding }) => binding.roles.includes('identity')).map(({ binding, tag }) => `${tag} ${binding.label || ''}`.trim());
  const all = [primary, ...others].filter(Boolean);
  if (all.length === 0) return '';
  return `subject_definitions:\n${all.map((s) => `- ${s}`).join('\n')}`;
}

function summary(ctx: CompileContext): string {
  const p = ctx.plan;
  const parts = [p.intent.visualThesis.trim(), p.intent.dramaticGoal.trim()].filter(Boolean);
  return parts.length ? `summary: ${parts.join('. ')}` : '';
}

function retentionAnalysis(ctx: CompileContext, num: ReturnType<typeof numberReferences>): string {
  const lines = [...num.pictures, ...num.videos, ...num.audios]
    .map(({ binding, tag }) => {
      const keep = binding.preserve.length ? `preserve: ${binding.preserve.join(', ')}` : '';
      const ignore = binding.ignore.length ? `ignore: ${binding.ignore.join(', ')}` : '';
      return `- ${tag} ${binding.label || ''}${keep ? ` — ${keep}` : ''}${ignore ? `; ${ignore}` : ''}`.trim();
    })
    .filter(Boolean);
  return lines.length ? `retention_analysis:\n${lines.join('\n')}` : '';
}

function detailedDescription(ctx: CompileContext, num: ReturnType<typeof numberReferences>): string {
  const refs = [...num.pictures, ...num.videos, ...num.audios].map(({ binding, tag }) => `${tag} ${binding.label || ''}`.trim()).filter(Boolean);
  const { plan } = ctx;
  const parts = [
    ...(refs.length ? [`References: ${refs.join(', ')}`] : []),
    line('Subject', plan.subject.primarySubject),
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

function line(section: string, value: string): string {
  const v = value.trim();
  return v ? `${section}: ${v}` : '';
}
