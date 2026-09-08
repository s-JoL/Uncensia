---
name: video
description: "Create a video with generate_video: choose text or a first frame, describe timed subject and camera motion, and protect continuity."
contexts: [visual-continuity]
---

# Video

Use `generate_video` (or the explicitly selected model's video tool). The user's explicit operation, model/backend, references, exclusions, and scope take precedence over this skill's defaults. Use the selected model's tool when specified; do not silently switch operation or backend. If only analysis or a written prompt is requested, return text without generation or editing. For a short clip, default to one continuous shot and one clear beat. If the user explicitly asks for a longer sequence and the schema permits the duration, describe a small number of ordered timed beats; do not invent a montage or location change they did not ask for.

Keep the requested number of clips and their order; use one clip only when that is the requested scope. Distinguish several clips from several timed beats within one clip. Execute the authorized scope without per-clip confirmation. Track each slot against real successful job/asset results; attempts and replacements do not increase the completed count. On interruption, report confirmed outputs and unresolved slots. Do not silently truncate duration/count to fit a backend or create unsolicited variations.

## Where the motion starts

- Honor explicit text-to-video or image-to-video choice. When unspecified, an existing image can anchor a requested face, framing, or look; name its exact ID as `source_image_id` only when the selected schema supports it. Prose alone cannot guarantee identical appearance.
- For explicit text-to-video, describe required visible anchors without substituting image-to-video.
- If the requested workflow includes creating a first still, make it with the matching image skill, inspect the successful result, then animate it within the existing authorization. Do not add a first-frame approval step.

## Write for time, not for a frame

An image prompt describes a state. A video prompt describes a change. Use concise prose with clear timing, covering:

1. **Subject motion:** who moves, which part, direction, speed, where the movement ends.
2. **Camera:** hold, pan, tilt, push, pull, orbit, follow, or handheld — and how far. A static camera is a real choice.
3. **What stays:** identity, clothing, setting, light, screen direction.

For a short clip, use one beat: one gesture, look, approach, or turn. For a longer requested sequence, use compact ordered timing such as `0–5s`, `5–10s`, only when the model's schema supports that duration. Keep subject, screen direction, wardrobe, environment, and motivated light continuous between beats.

Animating a still: describe only the movement away from it. Re-describing the subject, clothes, and room invites a redraw.

This motion-first approach is also documented in [Runway's Image to Video guide](https://help.runwayml.com/hc/en-us/articles/48324313115155-Image-to-Video-Prompting-Guide). Treat it as prompting craft, not a cross-provider parameter contract: Runway-specific durations and controls do not imply support in the selected Uncensia backend.

Include requested dialogue, sound, subtitles, on-screen text, split screens, or transitions only where the backend supports them; report a capability gap instead of silently dropping a requirement. Use the current schema for executable arguments.

Honor the user's explicit prompt-language request; otherwise follow the backend's documented prompting language, or use clear natural language if none is specified. Keep text to be rendered verbatim in its original language, quoted exactly. Keep supported controls in tool arguments. If an explicit requirement conflicts with backend capabilities, report the gap rather than silently changing it.

If designing an opening frame is part of the requested workflow, load `image-generate` or `image-series` first, then come back here.

## Finish

After the tool succeeds, use the returned job or asset status exactly. Do not write `video://` markup; the client renders the clip. On failure, report the actual error and do not claim a video exists.
