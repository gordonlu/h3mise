# Original-Vocal-Driven Performance: Preparation and Prompts

Connect the [audio-locked App](02-runninghub-workflows.md) first. Prompts need a workflow with real audio input; a model without an audio port cannot gain lip-sync ability by itself.

## Cut the dry vocal cleanly

In your own audio editor, compare against the original song and audition the waveform. Keep one continuously sung phrase intact: the start must not include the tail of the previous phrase, and the end keeps the natural tail and necessary breath; a text line break is not a singing break. Export the dry vocal at the original tempo and check that its real length does not exceed 14 seconds.

Do not use the mix in place of the dry vocal, do not pad silence to round up, and do not change speed. If a phrase is too long, split at a natural pause or let narrative visuals cover part of the lyric. Record each clip's start and end time in the original song so it can be placed correctly later.

## How to use

Bind the character image as `<Picture 1>` and the single complete dry vocal as `<Audio 1>`. The version below is the single-image version: the environment also comes from Picture 1. If you also bind an environment image as Picture 2, change all environment references to `<Picture 2>` and keep the character identity from Picture 1.

The block below is a fixed medium close-up synchronization baseline, suitable for validating lip sync first. A final shot can switch to three-quarter, half-body, full-body, or walking-and-singing; when changing it, replace every fixed shot-size and fixed-camera description consistently and keep the audio-timing core. Organize the MV with changes in shot size and location; do not stack face close-ups for the whole piece.

Save it as a new prompt version for the current shot, then run Preflight. Keep this manually confirmed synchronization core; if ordinary prompt compilation or AI rewriting overwrites it, verify it again. `fully_preserved` is part of this App's successful baseline, not a universal guarantee for every model.

## Copyable single-image synchronization baseline

```text
subject_definitions:
<Subject 1> is the person shown in <Picture 1>. Use <Picture 1> as the identity reference. Preserve the same facial identity, facial proportions, apparent age, hairstyle, skin tone, and visible clothing throughout the shot.

<Audio 1> is the exact source vocal performance and the sole timing reference for the person's mouth movement. Use this audio as supplied.

summary:
A photorealistic cinematic performance by <Subject 1> in the environment shown in <Picture 1>, with natural mouth movement closely synchronized to the supplied vocal performance in <Audio 1>.

retention_analysis:
<Subject 1> (appears throughout [Shot 1]): fully_preserved - retain the identity and appearance from <Picture 1>; only natural performance-related facial movement is added.
<Audio 1>: fully_preserved - retain the source vocal timing and content. Do not invent replacement dialogue, vocals, lyrics, or music.

detailed_description:
Create one continuous, photorealistic live-action take set in the environment represented by <Picture 1>. Place <Subject 1> naturally within this setting. Preserve the important environmental cues from <Picture 1>, including the background, architecture, lighting direction, color palette, and spatial depth. Do not replace the location with an unrelated generic studio or background.

Keep the person's face and mouth clearly visible, unobstructed, and in focus in a stable medium close-up. The person performs the exact speech or singing heard in <Audio 1>. Synchronize visible lip shapes, mouth opening, jaw movement, cheeks, breaths, sustained vowels, syllables, and pauses to the actual timing of <Audio 1>. The mouth must follow the supplied vocal performance rather than a generic speaking loop. Use natural, restrained facial expressions and subtle head movement. Avoid cuts, fast head turns, objects crossing the mouth, exaggerated expressions, or any obstruction of the lower face.

[Shot 1] <Subject 1> performs the vocal track in <Audio 1> continuously, with realistic lip articulation and natural breathing. Preserve the reference person's facial identity and appearance from <Picture 1>. Maintain the environment from <Picture 1>, a steady camera, and consistent framing for the entire take.

overall_soundscape:
Use only the exact source track <Audio 1>. Do not add sound effects, ambience, dialogue, secondary vocals, or background music.

non_diegetic_music:
None. The original source track <Audio 1> is the only soundtrack.
```

We kept the original limiting sentence here to preserve the verified baseline. Newly written story, action, and object descriptions should state the correct state positively and avoid repeating objects that are no longer needed.

## How to review after retrieval

Play the whole segment continuously and compare lip sync at the matching time in the original song. Check especially the first second, long vowels, fast syllables, pauses, and the final half second; do not judge only by the opening. Record separately whether the generated audio track kept the original vocal, whether visible lip sync matches, and whether it aligns when cut back to the original song.

If the mouth is not visible in a wide shot, record "cannot confirm"; do not mark lip sync as passed. If the face, wardrobe, or action is poor, keep the confirmed audio and synchronization core and regenerate only the necessary visual factors.

## Legacy audio-reuse recipe

Another historical method uses `[reference generation + audio reuse]` in an ordinary reference-audio workflow, explicitly marks `<Audio 1>: fully_copy`, uses the complete existing original vocal as the complete final audio track, and has the subject sing the corresponding lyrics with the actual timing. It requires the complete recipe adapted to that mechanism; a single keyword does not prove success.

This guide prefers the audio-locked App. Record the legacy recipe separately from the `fully_preserved` baseline above; do not mechanically combine the two mechanisms, and do not override the audio-locked App with a legacy external duration.
