# H3Mise Assistant Guide

This file tells coding assistants how to help a user run and configure H3Mise safely. Read it before changing provider settings, workflow mappings, project data, or render behavior.

## Product model

- H3Mise is local-first. Projects live under `H3MISE_HOME` (default `~/.h3mise`); do not commit, move, delete, or rewrite a user's project unless explicitly asked.
- RunningHub is a paid render provider. H3Mise sends an AI App a prompt, references, duration, aspect ratio, megapixels, and optional mapped parameters.
- The built-in Mock Provider is the safe fallback for learning and offline testing.
- ComfyUI Local is a separate render provider. Its workflow mapping and safe Agent procedure are documented in `ComfyUI.md`; read that file before importing or editing a ComfyUI profile.
- A `Shot` is the plan; a `Take` is a generated result. Never overwrite a Take to represent a new render.
- Storyboard is an optional visual planning layer before Shot design. Creating or editing its text panels is free; generating a sheet or regenerating one panel through RunningHub is a separate paid image task.
- Story skeletons and director-style presets are planning aids. Applying a skeleton restructures canonical StoryBeats in place by default; it must not append a duplicate set or silently render.

## Help a first-time user

Prefer the Settings UI over editing JSON or environment files.

1. Start H3Mise and confirm the UI and `GET /api/health` are available.
2. If the user only wants to explore, keep RunningHub unconfigured and use Mock. Do not push them into paid rendering.
3. For real rendering, explain that the user needs:
   - a RunningHub API Key from their own account;
   - a published RunningHub AI App ID whose workflow accepts the inputs they want to use.
4. Ask the user to enter the API Key directly in **Settings → Provider — RunningHub AI App**. Never request that they paste a secret into chat, and never print, log, commit, or screenshot it.
5. If using a different AI App, update its `appId`, save the profile, then run **检测并获取节点映射（apiCallDemo）**.
6. Explain the status honestly:
   - `unconfigured`: no usable mapping has been detected;
   - `nodes_detected`: node layout was read and mapped heuristically, but no real render has proved it;
   - `verified`: a real submission returned a task ID with this profile;
   - `failed`: inspect the detection or provider error before doing anything paid.
7. Before the first real render, bind the required assets, run Preflight, use the lowest practical valid duration and `0.6 MP`, show the user the cost/risk summary, and obtain explicit confirmation before submitting.

Useful non-secret checks:

```bash
curl -sS http://127.0.0.1:4789/api/health
curl -sS http://127.0.0.1:4789/api/providers
curl -sS http://127.0.0.1:4789/api/providers/runninghub/apikey
curl -sS http://127.0.0.1:4789/api/providers/runninghub/profile
```

The API-key status endpoint reports only whether a key exists and where it came from; it must never return the key itself.

## Adapt a different or changed RunningHub AI App

RunningHub AI Apps are not assumed to share fixed node IDs or field names. Treat every new App ID, republished workflow, or changed node layout as unverified.

1. Read the current profile with `GET /api/providers/runninghub/profile` and preserve a copy before editing.
2. Run `POST /api/providers/runninghub/verify`. This calls `apiCallDemo`, stores the returned node list, and maps recognized fields to H3Mise business inputs.
3. Inspect both `nodes` and `inputs`. Automatic mapping recognizes common names for:
   - prompt;
   - mode;
   - first and last frame;
   - reference images and reference audio;
   - duration;
   - aspect ratio/resolution;
   - megapixels;
   - sampling steps.
4. A mapping with an empty `nodeId` is disabled. Do not restore an old ID, invent an ID, or send the value through another field.
5. If names are ambiguous, compare the discovered node's `nodeName`, `fieldName`, `fieldType`, `fieldData`, and `description`, then edit the Profile JSON explicitly. Ask the user when two nodes remain plausible.
6. Custom provider parameters require `providerParamBindings` entries with an exact `nodeId` and `fieldName`. Unknown parameters are intentionally rejected; never hide them in the prompt or guess a destination.
7. Save the profile through `PUT /api/providers/runninghub/profile`, rerun Preflight, and make one minimal user-approved real submission. Only that successful submission may promote the profile to `verified`.

If detection fails or the workflow cannot express a requested H3 mode, keep that mode disabled and fall back to Mock or a supported mode. Do not bypass capability checks.

## Use optional Storyboards safely

- Do not tell a user that Storyboard generation is required. They can continue directly from Story to Shotboard without spending anything.
- H3Mise selects a `3`, `6`, or `9` panel layout from narrative-segment count, not total video duration. Stories with more than nine segments become multiple ordered pages.
- Text planning, fixed black-frame templates, sheet splitting, and sheet recomposition run locally. Each page generation and each single-panel regeneration is its own RunningHub paid task and requires explicit confirmation.
- The Storyboard Provider reuses the account-level RunningHub API Key, but has its own AI App ID, node mapping, verification state, size values, and cost estimate under **Settings → Provider — Storyboard 生图（可选付费）**.
- Treat a changed Storyboard App ID or mapping as unverified. Save it, run its node detection, and inspect the detected Prompt, Size, and Layout Image fields before the first paid submission.
- `nodes_detected` means only that the three inputs were discovered. A returned real task ID promotes the profile to `verified`.
- Never start Storyboard generation to test connectivity. Never prepare a replacement Storyboard series while one of its paid tasks is active; reconcile the existing provider task instead.
- Whole-sheet results are split into panel assets with local FFmpeg. Regenerating one panel creates a new version and recomposes the sheet; do not overwrite or delete the earlier asset version.
- For more than nine narrative segments, approve only after every page has a generated asset for every panel.
- Approval atomically connects panels to Shotboard: it reuses matching Beat-linked Shots, creates only missing Shots, and binds panel images as visual references. Reapproval must remain idempotent.

Useful non-secret checks:

```bash
curl -sS http://127.0.0.1:4789/api/providers/runninghub/storyboard-profile
curl -sS http://127.0.0.1:4789/api/storyboard/pages
```

## Assist story structure and director style

- Built-in narrative skeletons work without AI. Theme matching is deterministic; when AI ranking fails or is unavailable, keep the local recommendations usable and say that fallback occurred.
- A skeleton has `3`, `6`, and `9` segment variants. Applying one updates existing StoryBeat rows by order, creates or removes only the unlinked remainder, and preserves Beats already linked to professional Shots. Explicit append mode exists for API clients but is never the UI default.
- AI story splitting receives current Beats and atomically refines/replaces them on the server. It creates only missing linked Shots; browser closure, retry, or a partial HTTP sequence must not append duplicates.
- Beat-to-Shot materialization never guesses by array position. It creates a Shot only for an uncovered Beat and adds a deterministic minimum DirectorPlan derived from that Beat.
- Familiar style phrases such as a film, series, genre, or era name are lookup intent only. Resolve them to generic, observable direction for medium, production design, lighting, performance, camera, editing, and sound.
- Do not retain an imitated work name in the final H3 prompt. Do not reproduce recognizable characters, locations, dialogue, costumes, plots, or signature shots.
- Director style is subordinate to project facts, bound assets, continuity, explicit shot instructions, and physical plausibility. Inject only the attributes relevant to the current Shot and keep at most one dominant camera behavior.
- The resolved director style must reach built-in AI actions, external context packages, Storyboard prompts, and deterministic H3 compilation, including Ref2VA. If built-in AI is unavailable, deterministic style directives must still work.

## Connect ComfyUI

- Use a workflow exported in ComfyUI **API Format**, never a UI-only workflow JSON.
- Keep RunningHub and ComfyUI profiles separate. A project selects one Provider explicitly; never silently fall back to a different real Provider.
- Inspect inferred node/input mappings before verification. Ambiguous inputs must remain disabled until the user or their Agent maps them explicitly.
- Connection verification may call `/system_stats` and `/object_info`, but it must not submit `/prompt`.
- Default to loopback URLs. A non-loopback URL requires an explicit `allowRemote: true` after the endpoint has been reviewed.
- Current ComfyUI reference upload supports images only. Do not pretend audio or video bindings are connected.
- Follow the complete procedure and Profile schema in `ComfyUI.md`.

## Render safety rules

- Never start, retry, or duplicate a paid render merely to test connectivity.
- Never bypass Preflight, the active-job lock, reference limits, or provider capability checks.
- Reconcile a task that already has a RunningHub task ID instead of creating another paid job.
- When the provider reports success but H3Mise reports failure, query and reconcile the existing task before retrying.
- Use selected megapixels exactly as mapped. Supported presets are `0.6`, `0.8`, `1.0`, and `1.2`; do not silently substitute another value.
- Do not claim `nodes_detected` means the workflow is verified.
- Surface the provider error, stage, and task ID without exposing credentials.
- One-click preview and execution must calculate from the same canonical Beats, Shots, Takes, and jobs. Candidate Takes and active jobs block a new run until selected, rejected, or reconciled; the paid confirmation count must include Shots materialized from uncovered Beats.

## Development workflow

- Preserve unrelated user changes in a dirty worktree.
- Use `rg` for code search and `apply_patch` for text edits.
- For small visual-only edits, do not run a full build. For provider, persistence, render, or FFmpeg changes, add a targeted regression test and consolidate validation near the end.
- Use Mock for automated tests. Tests must not call paid APIs or require user credentials.
- Before committing a release-sized change, run `pnpm test` and `pnpm build` once, then fix and rerun only the failed target when appropriate.
- Never commit `.env`, local project directories, API keys, cookies, generated `output/`, or user exports.

## Key implementation locations

- `server/src/providers/registry.ts`: profile persistence, discovery, capability inference, and verification state.
- `server/src/providers/runninghub.ts`: upload, workflow input mapping, submission, polling, and download.
- `server/src/modules/preflight.ts`: deterministic checks before paid submission.
- `server/src/modules/render.ts`: persistent queue and reconciliation.
- `server/src/modules/storyboard.ts`: optional text boards, paid image jobs, reconciliation, splitting, and panel versioning.
- `server/src/modules/story-skeletons.ts`: built-in narrative structures, local matching, AI ranking fallback, and Beat creation.
- `server/src/modules/story-pipeline.ts`: atomic Beat proposal application, uncovered Beat-to-Shot materialization, and minimum DirectorPlan creation.
- `server/src/modules/director-styles.ts`: style aliases, generic presets, AI context, and deterministic H3 directives.
- `web/src/pages/SettingsPage.vue`: user-facing provider setup.
- `web/src/pages/StoryboardPage.vue`: optional multi-page Storyboard planning and paid-generation confirmation UI.
- `shared/src/provider.ts`: provider profile and capability contract.
