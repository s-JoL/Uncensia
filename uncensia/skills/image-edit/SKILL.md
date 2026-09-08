---
name: image-edit
description: "Make a local change to one existing image with edit_image while preserving identity, framing, and unaffected details."
contexts: [visual-continuity]
---

# Edit one existing image

Use this procedure when the user wants an existing image changed. An earlier instruction to generate independently still applies to "keep improving" unless the user changes that operation. Analysis or a written prompt alone needs no edit. For a requested single-image edit, use `edit_image` (or the selected model's edit tool) with exactly one `source_image_id`, copied from the conversation or a tool result. Editing means changing the source, not drawing a similar frame. Preserve explicit model, reference and scope choices.

Resolve the selected version before calling the tool. "Use the earlier green coat version" points to that returned ID, even if a newer red coat image exists. Describe what changes and what stays for this version; do not silently return to an older base after a successful face or scene revision.

For a single-image edit, omit `additional_source_image_ids`. Being attached does not make an image a contributor. In particular, an explicit request to ignore a reference overrides its saved purpose label; never send that reference to the image model.

Silently identify four things before writing the prompt:

- **Anchors:** identity, proportions, pose, framing, light, and objects that already work.
- **Delta:** the requested regions or relationships that change, from their old visible state to the new one.
- **Dependents:** shadows, fabric, contact, or expression that must change because of the delta.
- **Protected:** only the drift-prone features that must stay.

Then write a concise prompt describing all requested changes and their dependents; the following is illustrative scaffolding, not a language requirement:

`Edit the source image. Change [target and old visible state] to [new visible state]. Update [only physically dependent details]. Keep [critical identity, geometry, framing, light, or background] unchanged. Make no other changes.`

Avoid re-describing the whole frame; restyle or reframe it when requested. Locate the target by appearance and position, not by a character name or jargon label. For a face, name the visible eye, brow, mouth, and head change. For a pose, name the new support, limb placement, and the clothing or shadow that must follow. Inherit the source frame unless the user asked to reframe.

If another picture must donate a face, garment, place, pose, or look, load `image-compose` or `image-style`. If the selected model cannot accept the required references, explain the capability gap; do not silently replace the operation with sequential lookalike edits.

Honor the user's explicit prompt-language request; otherwise follow the backend's documented prompting language, or use clear natural language if none is specified. Keep text to be rendered verbatim in its original language, quoted exactly. Keep supported controls in tool arguments. If an explicit requirement conflicts with backend capabilities, report the gap rather than silently changing it.

## Finish

Compare the requested change and protected details against the selected source when both are visible. A matching coat color does not establish that the face, hands or framing are unchanged. Report the specific features you inspected and any visible drift; use approximate language for visual similarity rather than claiming pixel identity.

After success, use returned pixels to inspect the result; call `view_image` only when those pixels are absent and inspection is needed. If inspection is unavailable, do not claim visual verification. Display the exact returned image once as `![brief description](image://exact-returned-id)`. On failure, say that the edit did not complete and no edited image was produced. Sending an edit prompt is only an attempt: never say you changed, preserved or processed the image when the tool failed. Report the actual error briefly in the user's language; never invent an image or id.

## Shared community craft

For complex prompts, typography, fidelity constraints or several reference images, use the read tool to load `../image-generate/references/community-craft.md` relative to this skill directory. This is the pinned Apache-2.0 OpenAI imagegen craft reference adapted to Uncensia. The current tool schema remains authoritative for executable parameters.
