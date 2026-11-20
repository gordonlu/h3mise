import type { ReferenceBinding, ShotProductionConfig } from '@h3mise/shared';

function cameraDirective(production: ShotProductionConfig): string {
  const camera = production.camera;
  const values = [
    camera.heightMeters === null ? '' : `height ${camera.heightMeters}m`,
    camera.focalLengthMm === null ? '' : `${camera.focalLengthMm}mm lens`,
    camera.tiltDegrees === null ? '' : `downward tilt ${camera.tiltDegrees} degrees`,
  ].filter(Boolean).join(', ');
  if (!camera.locked && !values) return '';
  return [
    `camera_setup: ${camera.locked ? 'One locked-off camera for the entire shot; maintain fixed pan, tilt, zoom, framing and one continuous shot.' : 'Camera setup:'} ${values}`.trim(),
    'All recording equipment stays off-screen throughout the surveillance viewpoint.',
  ].join('\n');
}

function cctvDirective(production: ShotProductionConfig): string {
  if (!production.cctv.enabled) return '';
  return [
    'surveillance_clean_plate: Fixed off-screen surveillance viewpoint. Generate a clean scene picture reserved for post graphics; keep lettering, timestamps, REC symbols, camera labels, watermarks and interface graphics out of the generated image.',
    'CAM label, location, increasing time and REC are added later by the local overlay layer; all recording equipment stays off-screen.',
  ].join('\n');
}

function audioDirective(production: ShotProductionConfig, references: ReferenceBinding[]): string {
  if (production.audio.mode === 'native_dialogue') {
    const cues = production.audio.dialogue.map((cue) => {
      const speaker = cue.speaker || 'UNMARKED_SPEAKER';
      return `<d speaker="${speaker.replace(/["<>]/g, '')}" start="${cue.startSeconds.toFixed(2)}" end="${cue.endSeconds.toFixed(2)}">${cue.text}</d>`;
    });
    return [
      'native_dialogue (approximate timing; onset is a creative estimate):',
      ...cues,
      'H3 native dialogue cannot guarantee exact second-level onset. For exact sync, use a reference-audio workflow and conform the selected Take locally.',
    ].join('\n');
  }
  if (production.audio.mode === 'reference_audio') {
    let audioIndex = 0;
    const lines = references.filter((binding) => binding.type === 'audio').map((binding) => {
      audioIndex += 1;
      const policy = binding.audioPolicy ?? { mode: 'reference' as const, startSeconds: null, endSeconds: null };
      const start = policy.startSeconds ?? 0;
      const end = policy.endSeconds === null ? 'asset-end' : policy.endSeconds.toFixed(2);
      return `<Audio ${audioIndex}>: ${policy.mode}; source ${start.toFixed(2)}–${end}s; use only this explicit range.`;
    });
    return ['audio_reference:', ...lines, 'Reference audio timing belongs to the audio workflow. Keep spoken words exclusively in the audio reference and reserve overall_soundscape for non-dialogue ambience.'].join('\n');
  }
  if (production.audio.mode === 'tts_dry') {
    return 'audio_post: Use only the separately supplied dry TTS/dialogue stem in local post. Additional vocals and output variants require an explicit user request.';
  }
  return '';
}

function segmentDirective(production: ShotProductionConfig): string {
  const segment = production.segment;
  if (!segment.groupId || segment.kind === 'single') return '';
  const details = segment.kind === 'time_jump'
    ? `Narrative time jumps forward ${segment.timeJumpSeconds}s while the physical camera stays identical.`
    : segment.kind === 'surveillance_skip'
      ? `Surveillance playback skips every ${segment.frameSkip} frame(s); the physical camera and scene geometry stay identical.`
      : 'Continuous action continues from the sibling segment at the identical physical camera.';
  return `locked_camera_segment: ${segment.kind}, part ${segment.index}/${segment.count}. ${details}`;
}

export function productionPromptDirectives(production: ShotProductionConfig, references: ReferenceBinding[]): string {
  return [cameraDirective(production), cctvDirective(production), audioDirective(production, references), segmentDirective(production)]
    .filter(Boolean)
    .join('\n\n');
}
