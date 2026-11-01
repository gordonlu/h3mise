# RunningHub: Narrative and Original-Audio Lip Sync

The following integration reference was checked on 2026-11-01. Both configurations already have real submission records in the author's local H3Mise. They are stored in the local global Provider settings and persist across projects; downloading the source code does not obtain the author's local configuration, key, or verification state. The nodes below may change as the Apps are updated, so new users must still detect them with their own account.

## Two Apps you can look up directly

| Purpose | Mainland China AI App | Suggested name |
| --- | --- | --- |
| General narrative, multiple references, video reference | [2114228323600650242](https://www.runninghub.cn/ai-detail/2114228323600650242) | H3 Narrative · Multi-reference |
| Original-audio-driven singing / lip sync | [2116366903353630721](https://www.runninghub.cn/ai-detail/2116366903353630721) | H3 Singing · Original audio, locked duration |

The audio-locked App's API call path is `/run/ai-app/2116366903353630721`; this is the invocation entry point, not the workflow editor page in the browser. H3Mise calls the API according to the region and mapping, so no separate script is needed.

These IDs correspond to verified Mainland China configurations; do not assume the same IDs work on the Global site. First confirm the App page and your own account access; if they are unavailable, use an App you can access with the same input capabilities and detect it again. Saving a mapping does not download the remote workflow model, node code, or usage rights to your machine.

## Register in Settings

1. Choose the site and enter your own key.
2. Add an item in the RunningHub App list, enter a name and App ID, and click Save.
3. Click "Detect nodes" for that item and verify the prompt, image, audio, duration, and size fields.
4. Use "Preview payload" to inspect the actual mapping. Detection only reads nodes; it does not generate video.
5. Set the narrative App as active by default; before singing, make the audio-locked item active, use `ref2va`, and check its inputs. Restore the narrative item after submission if necessary. Existing jobs run from their own request snapshots.

`nodes_detected` means nodes were found; `verified` means a real submission returned a task ID. Neither means the finished video or lip sync passed.

## Narrative App reference mapping

| Business input | nodeId.fieldName | Notes |
| --- | --- | --- |
| Prompt | `250.prompt` | Prompt for this shot |
| Reference images | `231.image` to `239.image` | Up to 9 slots; bind them according to the actual reference roles |
| Reference audio | `247.audio` to `249.audio` | Up to 3 slots |
| Reference video | `251.file` | Video reference slot |
| Duration | `222.value` | External duration parameter |
| Aspect ratio | `115.aspect_ratio` | Landscape enum is `16:9 (Widescreen)` |
| MP | `115.megapixels` | Total pixel parameter; choose a value the App actually supports |

The verified configuration supports `t2va / ref2va / vref2va`. These image slots are ordinary reference slots and cannot be treated as literal first or last frames. Real first/last-frame modes require a separate Frame App and real matching ports.

## Audio-locked lip-sync App reference mapping

| Business input | nodeId.fieldName | Notes |
| --- | --- | --- |
| Prompt | `250.prompt` | Use the [synchronization baseline](03-singing-prompts.md) |
| Character reference | `231.image` | Required; corresponds to `<Picture 1>` |
| Environment reference | `232.image` | Optional; corresponds to `<Picture 2>` |
| Single original dry vocal | `247.audio` | Corresponds to `<Audio 1>`; one complete phrase, no longer than 14 seconds |
| Aspect ratio | `115.aspect_ratio` | Landscape enum is `16:9 (Widescreen)` |
| MP | `115.megapixels` | Set a value supported by the App and the current H3Mise version |

**There is no external duration node, no reference video slot, and no first/last-frame slot. The actual audio length controls the generation duration.** Do not copy `222.value` from the narrative App, and do not pad silence or stretch the dry vocal to match the Shot's default seconds. Declare modes `t2va / ref2va` during detection; singing uses `ref2va` with the character reference.

Preflight must confirm that the workflow is enabled, exactly one real dry vocal is bound, and the character and environment reference numbering is correct. Do not invent mappings for parameters the App does not accept. After generation, measure the real output frame count; the video container may be slightly longer than the audio, so record the editing range separately.

## Resolution and cost

Historical successful integrations used 16:9 / 1MP; this is not a verified native-1080p recipe. The MP presets currently supported by H3Mise may also differ from the App's original node options; do not bypass the mapping to send larger values arbitrarily. Validate one sample at the target size first, then lock the output specification for the whole piece.

Both use the same account key and share concurrency. Costs are recorded by actual charges; price, availability, and queue speed are determined by the remote service. On timeout, check the existing task ID first and confirm its state before deciding whether to retry.
