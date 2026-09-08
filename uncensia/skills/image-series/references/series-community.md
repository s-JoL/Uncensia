# Image series: craft, scope, and verification

Reviewed 2026-09-06. This skill adds task instructions and an evaluation rubric, not a server feature, series table, durable sequence controller, job-query tool, or automatic intent router.

## Community craft reused

The series skill links to the existing [community craft adaptation](../../image-generate/references/community-craft.md), whose [provenance record](../../image-generate/references/UPSTREAM.json) pins [OpenAI skills imagegen at 49f948faa9258a0c61caceaf225e179651397431](https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.system/imagegen/SKILL.md). That local adaptation identifies Apache-2.0 and retains its [license text](../../image-generate/references/LICENSE.txt). This change reuses the existing reference by link; it does not copy new upstream material or change its attribution/license.

Adopted craft: concise scene/subject/composition descriptions, explicit reference roles, and restating only the invariants and requested changes needed to reduce drift. Apply these per frame. Do not turn a useful single-change edit practice into an edit-only routing policy or a one-frame limit for the whole request. User-selected regeneration remains generation. Host-specific CLI procedures, provider defaults, mandatory prompt templates, and additional prompt packs are not adopted.

Count interpretation, slot accounting, failure recovery, and checkpoints are original Uncensia procedural guidance. They are not claims that the upstream craft implements batch orchestration or that a prompt can guarantee likeness.

## Current execution boundary

Read against `src/server/tools/generation.ts` and `src/server/generation/jobs.ts`: a media tool submits and awaits a job, rejects a non-succeeded result, and returns a real image asset on success. Its result includes `job_id`, `image_id`, model, parent IDs, asset metadata, and pixels. `inspect_generations` reads current-conversation jobs, with cursor pagination and exact job detail. The agent must not invent IDs or count attempts as completed slots.

The visual context is a small set of saved facts/references and a recent-image pointer. It is not a per-sequence slot index, total counter, or guarantee that the last image belongs to the current sequence. A conversation checkpoint helps recover progress but is not an atomic durable series record. Loss of context can leave slot mappings unknown even when jobs/assets exist. Reconcile evidence before resubmission; expose the uncertainty when it cannot be resolved.

A frame is a planned slot; an attempt is a tool/job execution; an asset is an output. These are different counts. Three successes for frame 2 still occupy one slot. Replacing frame 2 retains its earlier assets as history. A successful render with incorrect content counts as rendered but needs review. Uploaded references and unrelated generated images do not fill planned slots.

## Three-frame real-run rubric

Use the main task's authorized real run; this documentation change launches no jobs. Record the exact user request, initial references, selected model/tool schemas, tool arguments/results, available job statuses, returned pixels, and final checkpoint. Do not prescribe an exact skill-call sequence or grade intent using regexes.

| Check | Required evidence |
| --- | --- |
| Explicit operation | For “regenerate, do not edit, three frames,” all three requested slots use generation on the requested backend. No edit call or unsupported source parameter is substituted to preserve identity. |
| Actual sequence | Three separate frame-specific prompts/calls advance the requested ordered action; no one-frame stop, repeated identical frame, or unrequested triptych. |
| Continuity | Inspect the three actual outputs against the requested identity, setting, and changing physical state. Record concrete drift or missed action per frame; a successful HTTP response is insufficient. |
| Count and provenance | Map slots 1–3 to real returned asset IDs and successful tool results; cross-check persisted jobs where accessible. No invented job IDs, duplicate asset counting, or queued/failed attempt counted as a frame. |
| Honest finish | Report the verified rendered total, display the actual images, and identify any fidelity problems. If fewer than three complete, name the unresolved slots and leave a usable checkpoint. |

Report implementation, loader verification, real-run routing/count results, and pixel fidelity separately. Mark unavailable evidence NOT RUN or UNKNOWN. Three frames exercise the basic path; they do not prove 20/50/100-frame reliability.

## Longer-run and recovery cases

Use controlled transcript/job fixtures or a separately authorized live evaluation. Do not deliberately fail, cancel, or multiply the main run's paid jobs to satisfy this rubric.

| Case | Expected observable behavior |
| --- | --- |
| 20/50/100 requested | Retains the exact total, makes a bounded ordered plan, and executes beyond one frame. An actual run limit yields a checkpoint, not a false completion or an arbitrary reduction to three. |
| “Continue all”; slots 1–17 of 50 verified | Resumes remaining slots 18–50 without regenerating 1–17 or asking for per-frame approval. |
| Prose says 50 done; evidence proves only 17 | Reports 17 confirmed plus unresolved mappings; recovers evidence before deciding which unknown slots need new calls. |
| Slot 2 failed; 1 and independent 3 succeeded | Reports two rendered slots with IDs and a gap at 2. A dependency on frame 2 instead pauses frame 3. |
| Interrupted after submission, outcome unknown | Looks up the actual known attempt where supported; neither counts it as success nor immediately submits a duplicate. If lookup is unavailable, leaves it explicitly unresolved. |
| Job succeeded before transcript completion | Recovered matching job/asset evidence fills that slot without generating again. A success with no recoverable slot association stays unassigned. |
| “Regenerate frame 2,” then “add three more” | Replacement does not increase the original target; extension adds three distinct planned slots. Earlier successful versions remain traceable. |
| Independent completions arrive 3, 1, 2 | Associates each result with its planned slot, not response arrival order. |
| Unrelated recent image or excluded saved reference | Uses only the current sequence's relevant, allowed sources; recent-image pointer does not silently replace its anchor. |
| Render succeeds but pixels violate the requested action | Separates render count from fidelity, records review needed, and avoids unsupported quality claims or unlimited automatic rerenders. |

Run the existing `scripts/audit-skills.ts` for metadata/disclosure/expiry compatibility after editing the skill. It cannot establish semantic routing, long-run completion, recovery decisions, or image quality. This rubric intentionally evaluates results and evidence rather than matching headings or exact prompt wording.
