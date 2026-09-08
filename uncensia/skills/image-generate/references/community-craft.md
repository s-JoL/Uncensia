# Image craft

Adapted from [openai/skills imagegen](https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.system/imagegen/SKILL.md) at `49f948faa9258a0c61caceaf225e179651397431` and its [prompting.md](https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.system/imagegen/references/prompting.md) (Apache-2.0). Local license: [LICENSE.txt](LICENSE.txt). Changed: Uncensia tools and exact image IDs replace Codex CLI paths; the upstream use-case taxonomy is scaffolding, not a required slug.

Later reviews that informed original Uncensia wording, without copying their scripts or prompt packs:

- [Current OpenAI imagegen](https://github.com/openai/skills/blob/main/skills/.system/imagegen/SKILL.md): normalize a detailed brief; do not invent creative requirements.
- [SkillAtlas image-generation-enhanced](https://github.com/skillatlas/skills/blob/main/skills/image-generation-enhanced/SKILL.md) (MIT): lead with the visible result, prefer positive framing, give each reference a role, change as little as possible when iterating. Do not adopt its OpenRouter CLI, JSON-prompt default, or quality slogans.

## When the request is generate vs edit

From the upstream decision tree. These are intent checks, not keyword rules:

- No image, or images used only as style / composition / mood / subject guidance → generate. A reference can shape the description without becoming `source_image_id`.
- The user wants an existing picture changed while keeping parts of it → edit the selected version.
- Assume a new image unless they clearly ask to change an existing one.
- Do not treat “improve it” after an explicit fresh generation as permission to edit.

## Specificity

From `prompting.md`:

- If the brief is already specific, only normalize it. Do not add characters, props, brands, slogans, palettes, or story beats that were not asked for.
- If the brief is generic, add only the extra that materially helps: framing, intended use, a concrete setting that supports the request.
- A 30-year-old gardener does not need a weathered face to look photographic. When the prompt is crowded, drop your embellishments before weakening a user requirement.

## Prompt shape

Use labeled lines when the request is complex; skip lines that do not help:

```text
Use case: <optional taxonomy slug>
Asset type: <where it will be used>
Primary request: <user's main prompt>
Input images: <Image 1: role; Image 2: role>
Scene/backdrop: <environment>
Subject: <main subject>
Style/medium: <photo / illustration / 3D / …>
Composition/framing: <wide / close / top-down; placement>
Lighting/mood: <light and mood>
Color palette: <only if asked or already implied>
Materials/textures: <surfaces>
Text (verbatim): "<exact text>"
Constraints: <must keep>
Avoid: <must not appear>
```

Order the prose the same way: scene → subject → details → constraints. Name the intended use (poster, UI mock, product shot) when it sets polish. For photographs, use camera and light language. Quote on-image text exactly and say where it sits; spell uncommon words letter by letter when accuracy matters.

## References

- Do not assume every attached picture is an edit target.
- Label each one by index and role (`Image 1: edit target`, `Image 2: style reference`).
- `[Image 2]` in prose does not send pixels. Uncensia only sends an image whose exact `image_id` is in a source argument.
- For compositing, say what moves where and whose face, clothes, and background remain.

## Edits and iteration

- Write `change only X; keep Y unchanged`, and repeat the invariants on every follow-up.
- Prefer one targeted change per attempt over rewriting the whole prompt.
- After a result, inspect the pixels. Compare required facts and protected details separately. A matching coat color does not prove the face is unchanged.
- Prefer a concrete positive composition over a list of “no …” clauses. If an unwanted object appeared, describe what should occupy that region.

## Uncensia execution

Use the current tool schema. Generation creates a new asset; editing keeps the source and returns a child. Report real asset IDs and real errors. Do not add unsupported parameters or generic quality slogans.

The “keep the chosen operation across refinements” rule is a Uncensia correction from a live replay (fresh generation followed by “improve it” was wrongly turned into an edit). It is not an upstream guarantee.

Live exclusion example: [live-review-notes.md](live-review-notes.md).
