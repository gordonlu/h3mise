# From a Song to Your First Shots

## 1. Start the workstation

Download and extract the complete H3Mise package, and install Node.js 22.13 or newer with npm. On Windows, double-click `start.bat` in the root; on macOS, open `start.command`; on Linux, run `sh start.sh`. The first launch prepares dependencies and the web UI; keep the launcher window open while you work.

Video processing also needs FFmpeg and FFprobe. Confirm both are available in the Settings environment check. If you are only reading and planning a story, you can skip installing the video tools. Without a key, you can use the Mock example to learn the flow; Mock does not represent the image quality or lip sync of a real model.

## 2. Prepare your own assets

| Asset | Requirement |
| --- | --- |
| Complete song | The final mix master, used later as the continuous original track |
| Original lyrics | A correct text source; keep the musical time range for each section |
| Dry vocal | Used to drive the singing; preferably from the original song's stems, at the original tempo |
| Character reference | A clear single-person identity and wardrobe reference |
| Environment reference | The story location, showing layout, light direction, and space |

Fill in the [project production sheet](05-project-production-sheet.md) first. In one sentence, state what the protagonist must accomplish, what choice they make along the way, and what changes at the end. Emotion must unfold through visible action.

## 3. Configure the generation service

In Settings, first choose the RunningHub Mainland China or Global site, then enter your own API key for that same site. Enter the key only in the local Settings page.

Following the [workflow guide](02-runninghub-workflows.md), add two Apps: a general narrative App and an audio-locked singing App. Save each one, detect its nodes, and inspect the preview payload. Each App keeps its own mapping.

## 4. Create the project in H3Mise

Create a story project and enter the song length, aspect ratio, and visual style. Import characters, locations, and dry-vocal clips on the Assets page; create characters/locations and their references. Build StoryBeats by story section, then Shots. Storyboard image generation is optional and can be skipped.

A Shot is the plan; a Take is the generated result. For each shot, write the time range, action, shot size, camera position, references, and exit state, then save the director plan and prompt version.

## 5. Validate with two real samples first

First make one narrative shot with a specific character action, then one singing shot with a complete short phrase. The narrative shot uses character and environment references; the singing shot binds one complete dry vocal as described in the [singing guide](03-singing-prompts.md).

Run Preflight against the exact prompt version; after checking the App, assets, duration, aspect ratio, MP, and cost, submit under the current user's authorization. Do not submit a paid task just to test connectivity. After a sample succeeds, measure the actual width, height, frame rate, and duration, and review picture, lip sync, and the original audio track continuously.

Using a target of 1920×1080 as an example, first confirm that both the workflow and the H3Mise mapping support it, then inspect the actual file. The UI's "16:9" and "1MP" do not equal 1080p; the two reference configurations here cannot promise native 1080p. If the result does not meet the target, adjust the integration or agree on an accepted delivery size before batch generation.

## 6. Build the full piece along the story

Cover the full story first, then add key singing moments and details. Long phrases can be carried by a complete long take, or partly sung off-screen; every line does not need a face close-up. Change locations, shot sizes, and actions so each shot brings new information.

When authorized and the next shot is ready, submit idle slots first, then review existing artifacts. For shared accounts, keep running plus locally queued jobs to at most 2 in total; if the account limit is lower, follow the lower limit. Keep approved Takes; save revisions as new versions.

Finally keep a clean version without titles, a lyrics version with opening and ending cards, check phone readability, record actual charges, and save the current handoff. See [Review and delivery](06-review-and-delivery.md) for details.
