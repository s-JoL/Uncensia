---
name: image-series
description: "Plan, create, continue, or resume a set of images with recurring people or a shared theme: pose/scene options, illustrated stories, and long ordered sequences. Includes discussing choices before generating anything."
contexts: [visual-continuity]
---

# Continue a visual series

Use this procedure for the current sequence task. The image model does not remember earlier calls. Keep a compact working plan and evidence-backed progress in the conversation; never send that ledger itself as an image prompt. This skill does not create a durable series entity or guarantee unattended execution after a run ends.

During discussion, offer distinct choices with workable camera/framing ideas. A recommendation is yours; a selection belongs to the user. Keep visibility and composition constraints in the design of each option rather than presenting an incompatible option and later silently dropping it. If only discussion is requested, stop after the discussion with no renders.

## Honor the operation and scope

The user's explicit operation, model/backend, references, exclusions, and count take precedence over continuity preferences. If the user requests fresh generation or regeneration rather than editing, use the available `generate_image` tool (or the explicitly selected model's generation tool), even for the same person or viewpoint. Do not substitute `edit_image` to improve resemblance. For an explicit edit, use the appropriate edit tool and exact source IDs. If the chosen operation/backend cannot satisfy a required constraint, explain the gap without silently switching.

Choose continuity techniques within the active task's constraints. A shared theme or recurring character does not by itself require matching an existing image's pixels; do not add that requirement on the user's behalf. When exact visual identity is required and the operation is open, a suitable pixel-conditioned capability can help. When independent generation is selected, maintain the requested continuity in each prompt and disclose fidelity limits. Do not let a preferred continuity technique change an already selected operation or backend. Resolve an actual conflict between required fidelity and available capabilities before dependent work.

New subject matter without a required image match favors generation. Interpret intent from the request and conversation, not a keyword or regex rule. Replacing frame 7 keeps the agreed sequence size; adding three frames extends it. A short follow-up inherits the selected operation and references unless the user revises them. Resolve a material ambiguity from context or ask briefly before dependent calls.

Before rendering, show a compact numbered checklist of the requested deliverables and its total, recovering the scope from the conversation. When the user requests all previously listed options, retain every option and its original number; recommendations and difficulty notes are not user-approved exclusions. Resolve a difficult view with composition or disclose the obstacle for that item. Requests for 20, 50, or 100 frames remain those totals. “Continue all” means finish the remaining items. If no bounded scope can be recovered, ask for the target. The checklist is preparation, not fulfillment.

For a long sequence, outline compact phases and expand the next frames as needed, retaining exact numbering, requested count, and the intended ending. Execute the authorized remaining work without asking for permission at every frame. Continue until complete, cancelled, blocked, or interrupted by an actual execution limit; do not impose a fixed one-frame cap. Report the checkpoint and concrete blocker if the run cannot finish. Do not promise an automatic future continuation without a confirmed supported scheduling action.

## Maintain visual continuity

- **Identity:** visible age, face, hair, skin, build, marks, and persistent clothes or objects.
- **World:** place, time of day, screen direction, light source, and stable background anchors.
- **State:** pose, contact, gaze, clothing state, held objects, dirt, injury, and other accumulated consequences.
- **This shot:** the user's new instruction and the smallest camera or action change that gets there.

Apply the new instruction without silently resetting earlier visible state.

For generation, restate the concrete visible identity, world, and accumulated state needed for this frame, not “same as before.” Do not send source-image arguments to a tool whose schema does not support them or claim that prose guarantees exact identity. For editing, choose the confirmed source for this sequence, not blindly the conversation's latest image: it may belong to another task. Put it in `source_image_id`; put a contributing donor in `additional_source_image_ids` only when supported, with an explicit role. Naming a donor in prose does not attach its pixels. Honor excluded references and do not overwrite user-fixed references.

For an edit, write one narrow paragraph: state the requested camera or action delta, the dependent pose, fabric, shadow, or expression changes, and the few identity, world, and state anchors that must remain. Do not re-describe the whole source.

Give each requested frame its own prompt and generation/edit call using the current schema. A 50-frame request is not one image containing 50 panels unless the user requested a contact sheet. Put only this frame's anchors and action into its prompt; keep sequence planning outside it. Execute dependent frames in order, inspecting the prior successful result before using it as a source. Independent frames may run concurrently only when the available tools support it; retain planned numbering despite completion order.

Use the backend's documented prompting language where specified; otherwise use clear natural language. Preserve rendered text verbatim and keep supported controls in tool arguments. Load the applicable visual skill when additional operation-specific guidance is needed; its defaults do not override the user's explicit operation.

## Track, resume, and finish

Track each planned frame by ordinal, short purpose, operation/model, source IDs where applicable, attempt outcome, and exact returned asset ID. Include job IDs only when actually available. Count a slot as rendered only when a successful tool result or a verified `succeeded` job supplies a real image asset belonging to that slot. Planned, submitted, queued, running, failed, cancelled, and unknown outcomes do not count. A retry or replacement is another attempt for the same slot, not another completed frame. Keep earlier successful assets traceable; do not delete them when replacing a frame.

After each batch, compare the returned pixels with the checklist: requested action and composition, recurring identities and objects, visible anatomy, exclusions, and complete framing. Describe what is actually visible, including uncertainty; a prompt and a successful render are not evidence that a feature is present. Use `view_image` when the pixels needed for a judgment are absent or need closer inspection. Correct failures within the authorized task and any explicit budget, with bounded attempts and prior successful slots retained. The user should not have to repeat the original requirement to trigger repair. Compare the final slot mapping with the original checklist before finishing; disclose remaining defects or missing slots. Display each accepted image once as `![Frame N: brief description](image://exact-returned-id)` and keep progress concise.

On resume, reconcile the plan with actual tool results and accessible job/asset records. A prose statement like “50 done,” an attempt count, or the latest-image pointer alone is not evidence of 50 successes. Recover slot-to-asset mappings, retain confirmed successes, and continue missing slots. Use `inspect_generations` to resolve uncertain attempts or recover older pages, and its exact job details when the summary is insufficient. Do not duplicate a queued, running, or already successful job. If evidence is inaccessible, mark it unknown and state what is needed to resolve it; never reconstruct missing IDs from naming patterns.

Report failures with their real errors. Retry only when the cause has changed or there is a justified transient recovery, with a bounded attempt plan; never spin indefinitely or silently switch backend. If a failed frame is required as the next source, pause dependent frames. Independent later frames can proceed within scope, retaining the gap. At interruption or completion, leave a concise checkpoint: target/range, confirmed slot-to-asset mappings (or exact accessible evidence locations), unresolved attempts, review-needed slots, and next action. Claim completion only when all requested slots are accounted for and material fidelity problems are disclosed.

## Shared community craft

For complex framing, reference roles, typography, or drift constraints, read [the existing community craft reference](../image-generate/references/community-craft.md). Reuse its concise composition guidance and explicit invariants without copying a prompt pack into every frame. Adoption boundaries and the live-run review rubric are in [series community notes](references/series-community.md).
