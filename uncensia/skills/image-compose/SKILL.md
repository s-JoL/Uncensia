---
name: image-compose
description: "Combine visible identity, clothing, pose, objects, or setting from several images using edit_image with explicit source roles."
contexts: [visual-continuity]
---

# Compose several source images

The user's explicit operation, model/backend, references, exclusions, and scope take precedence over this skill's defaults. Use the selected model's tool when specified; do not silently switch operation or backend. If only analysis or a written prompt is requested, return text without generation or editing. For a requested multi-image composition, use `edit_image` (or the selected model's edit tool). Put the base scene in `source_image_id` and contributors in `additional_source_image_ids`, in order and within the schema limit.

Use the user's declared roles, not upload order. A provided stable image ID is a reference; do not assume it is invalid from its spelling. If the base or a required contribution is ambiguous, ask specifically for that role. If a selected model lacks multiple-source support, explain this instead of silently switching models or dropping a source.

`[Image 2]` is prompt language only. Writing it in the prompt does not send pixels. A donor arrives only when its exact `image_id` is in `additional_source_image_ids`. If a call fails because a required source argument is missing, supply the exact known contributing ID before retrying; do not invent one or attach an excluded reference.

Send an extra image only when it contributes something visible that words cannot lock: a face, body, garment, object, place, texture, or pose. Alternate takes of the same subject usually need one chosen base. A reference that contributes only its visual treatment belongs to `image-style`.

Give every input explicit requested responsibilities, then state how the result fits together. Refer to extras as `[Image 2]`, `[Image 3]`, in the same order they were sent:

- First image: the base scene or subject and what must remain.
- Each later image: its requested destinations and contributions—identity, body, garment, object, material, pose geometry, light, or setting.
- Result: scale, facing, contact, and where each person or object belongs.

A pose reference contributes only limb placement and viewpoint unless more was requested. Keep ownership explicit when sources could blend: whose face, hair, skin, clothes, jewelry, and background. Name every source in the prompt or leave it out.

Example: `Use the first image as the base room and keep its window light and furniture. From [Image 2], copy only the woman's facial identity onto the woman standing at the table—same face, hair, and skin, not her clothes. She wears the red wool coat from [Image 3], fitted naturally to her existing pose. One coherent photograph, not a collage.`

Honor the user's explicit prompt-language request; otherwise follow the backend's documented prompting language, or use clear natural language if none is specified. Keep text to be rendered verbatim in its original language, quoted exactly. Keep supported controls in tool arguments. If an explicit requirement conflicts with backend capabilities, report the gap rather than silently changing it.

## Finish

After success, inspect returned pixels if available; use `view_image` only if needed. If you cannot inspect the result, avoid visual quality claims. Display that exact image once as `![brief description](image://exact-returned-id)`. On failure, report the actual error; never invent an image or id.

## Shared community craft

For complex prompts, typography, fidelity constraints or several reference images, use the read tool to load `../image-generate/references/community-craft.md` relative to this skill directory. This is the pinned Apache-2.0 OpenAI imagegen craft reference adapted to Uncensia. The current tool schema remains authoritative for executable parameters.
