---
name: image-style
description: "Analyze an existing image's visual or photographic style (color, lighting, lens, medium), write a style prompt, or transfer that look. Use for analysis-only requests too; inspect pixels without generating when only analysis is requested."
contexts: [visual-continuity]
---

# Transfer a look, not content

The user's explicit operation, model/backend, references, exclusions, and scope take precedence over this skill's defaults. Use the selected model's tool when specified; do not silently switch operation or backend. If only analysis or a written prompt is requested, return text without generation or editing. For analysis or prompt-only work, inspect the reference if needed and describe only the requested style; do not make a media call. For fresh generation, describe the observed treatment in the generation prompt and attach references only if the selected generation schema supports them. A style reference alone does not require an edit.

A style request changes rendering behavior—medium, mark-making, color grade, light quality, or lens character. It does not change the people, pose, or setting unless the user separately asks for those changes.

For a requested style edit with a reference, use `edit_image` (or the selected model's edit tool): the content image is `source_image_id`, and the look image is the first entry in `additional_source_image_ids`. `[Image 2]` in the prompt does not send that picture; the id must be in the argument. Write:

`Transform the first image using only [named treatment] from [Image 2]. Keep the first image's subject, identity, pose, setting, and composition. Do not copy the second image's people, clothing, objects, or place.`

Name the exact portion of the look that transfers. If the request is only for color grade, do not also transfer medium or lighting. If an extra image contributes a face, garment, object, pose, or place, use `image-compose` instead.

For requested media creation with words only, use the chosen operation: generation for a new picture or editing for changes to an existing one. Describe the visible treatment concretely, such as `watercolor on cold-press paper, granulating blue-gray washes, dry-brush edges` or `unretouched daylight photograph, window light from the left, slight underexposure`. Do not rely on a famous artist's name or empty phrases such as `cinematic, 8K, masterpiece`.

Honor the user's explicit prompt-language request; otherwise follow the backend's documented prompting language, or use clear natural language if none is specified. Keep text to be rendered verbatim in its original language, quoted exactly. Keep supported controls in tool arguments. If an explicit requirement conflicts with backend capabilities, report the gap rather than silently changing it.

## Finish

For a media result, inspect supplied pixels before evaluating fidelity; use `view_image` when needed and available if pixels are absent. If inspection is unavailable, do not claim visual verification. After success, display that exact image once as `![brief description](image://exact-returned-id)`. On failure, report the actual error; never invent an image or id.

## Shared community craft

For complex prompts, typography, fidelity constraints or several reference images, use the read tool to load `../image-generate/references/community-craft.md` relative to this skill directory. This is the pinned Apache-2.0 OpenAI imagegen craft reference adapted to Uncensia. The current tool schema remains authoritative for executable parameters.
