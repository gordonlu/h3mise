# Hand the Starter Task to an AI Assistant

Fill in the following and give it to an assistant that can operate local files or the H3Mise MCP. An assistant without automatic integration can still use it to produce a plan; it must not claim that generation it did not run has completed.

```text
Read AGENTS.md at the root of the H3Mise repository and every document in MV_STARTER_KIT/en/ first.
Do the reasoning yourself; use H3Mise's prepare/apply protocol and the current tool documentation to save plans and prompts.

I want to make an MV:
- Song, lyrics, and dry-vocal location: [fill in your own asset locations]
- Theme and mood: [fill in]
- Character and environment references: [fill in]
- Story direction or ending: [fill in, or propose options first]
- Delivery platform, aspect ratio, FPS, target size: [fill in]
- Budget and paid authorization: [fill in; if blank, prepare plans and Preflight only, do not submit]

First inspect the current H3Mise project and existing jobs, verify the project before writing, and do not force a switch away from someone else's project.
Connect the narrative App 2114228323600650242 and the original-audio-locked lip-sync App 2116366903353630721 based on current node detection; if the account cannot access them, explain the specific problem.
I will enter the key in the local Settings; do not read or output the key.

Write a one-sentence story first, then design visible actions, shot-size changes, singing placements, and a continuous route against the music.
Do not use a newly synthesized character first frame that I have not approved; bind identity and environment by reference role.
Prefer native 1080p at the target and measure the artifact size first; if the workflow does not support it, explain the actual limit before locking the full-piece specification.
For singing, use one complete continuous phrase of dry vocal, no longer than 14 seconds, with no padded silence and no speed change.
Save a separate prompt version using the singing baseline; the audio-locked App has no external duration node.

Validate one narrative and one singing sample first, then proceed under the current authorization.
When an idle slot is free and the next shot is ready, submit first, then review existing clips; for a shared account keep running plus queued jobs to at most 2 in total.
If a taskId already exists, query it and recover; do not retry blindly. When pausing or finishing, stop new paid jobs and save the handoff.
Keep Takes the user has approved; create a new version for revisions.
Record file decode, original audio track, continuous picture, visible lip sync, and user approval separately.
Do not describe node detection, a still frame, or LOCAL_READY as a passed review.
Finally deliver the clean version, the subtitled/titled cut, the cover, submission copy, actual costs, and the handoff.
```

H3Mise changes between versions. Tool parameters, input slots, and paid confirmation follow the currently installed version; the blank production tables and task instructions here are not API requests to execute blindly.
