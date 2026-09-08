---
name: image-generate
description: "Create or refine new images from a description: photos, posters, illustrations, diagrams, or designs. Use when the user wants a new picture, an independent regeneration, or to keep improving a generation task. Do not use when they asked to change one existing image, combine several sources, or continue a numbered series."
contexts: [visual-continuity]
---

# Create an image

Resolve the operation from the current goal and earlier constraints. Official image-skill practice ([OpenAI imagegen](https://github.com/openai/skills/blob/main/skills/.system/imagegen/SKILL.md)) treats this as two questions: is this a new picture or a change to an existing one; and is it one asset or many. Assume a new image unless the user clearly asks to change an existing one. Use `generate_image` (or the explicitly selected model's generation tool) for new work, an independent regeneration, or when attached pictures are only style / composition / mood / subject guidance. Those references inform the description; they are not `source_image_id`. If no operation was specified and the goal needs a selected image's identity or details in a new scene, use the editing or composition skill. Preserve the subject, medium, exact text and selected references; do not silently turn an illustration into a photograph.

For a simple image, a concise description is enough: subject and action, medium, composition, useful setting/light details, then constraints. Add only details that materially help. For a poster, diagram, typography, or a complex composition, read `references/community-craft.md` relative to this skill directory before writing the prompt. Its labeled specification is useful scaffolding, not a mandatory format for every backend.

Separate required visual facts from optional atmosphere. Keep specified age, subject count, clothing, objects and exact text intact when refining a detailed brief. Do not add adjectives that pull against them: a 30-year-old gardener does not need a weathered face to look photographic. When a prompt becomes crowded, remove your optional embellishments before weakening the user's requirements.

Express exclusions through a concrete positive composition where possible: an empty polished countertop, a single person, or a crop that keeps other actors outside the frame. If an unwanted object appeared, lead with what should occupy that region and its place in the composition instead of merely repeating the object's name after "no". Preserve the exclusion itself and use separate negative controls only when the backend supports and recommends them. For a difficult visual correction, consult [live review notes](references/live-review-notes.md), then inspect the new pixels; the example is not a guarantee.

Honor the user's explicit prompt-language request; otherwise follow the backend's documented prompting language, or use clear natural language if none is specified. Keep text to be rendered verbatim in its original language, quoted exactly. Keep supported controls in tool arguments. If an explicit requirement conflicts with backend capabilities, report the gap rather than silently changing it. Do not add unsupported parameters, generic quality slogans or unnecessary negative prompts.

The user's explicit operation, model/backend, references, exclusions, and scope take precedence over this skill's defaults. Analysis or a written prompt alone needs no media call. Preserve the requested count; use `image-series` for an ordered sequence rather than reducing it to one image.

Continue the chosen operation across refinements. If the user chose fresh generation, "improve it" means revising the description and generating again; it does not authorize editing the latest result. Inspect the reference and result, choose the few visible differences worth correcting, and carry the original anchors into the next prompt. State an honest limit when text-only regeneration cannot reproduce an exact face or pixel layout; do not promise an exact match or change operations to conceal that limit.

These examples illustrate intent, not keyword rules:

- "Study this greenhouse photo and draw a new version; don't edit it." Later: "Improve the lighting and try again." Inspect the relevant pixels, revise the description and generate a new image; the second turn retains the operation.
- "Keep this exact gardener and coat, and make a picture in an orchard." With no operation restriction, pass the selected reference through an available editing/composition capability.
- "Is the greenhouse accurate?" Inspect and answer. If a correction is needed, distinguish that finding from permission to change it; resume corrections already included in the user's task, otherwise wait for the new instruction.

For the shared prompting sources and adoption boundaries, see [community craft](references/community-craft.md). Examples do not override the active schema or the user's explicit choices.

## Result

A successful generation produces a real asset ID. Display that returned image once with `![description](image://returned-id)`. The tool may already return pixels; use `view_image` only if inspection is needed and the pixels were not supplied. Evaluate fidelity only after seeing the actual result. If inspection is unavailable, say what was generated without inventing visual quality claims. A failed call produces no image: report its actual error and only retry when something relevant has changed.
