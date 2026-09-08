# Community methods and provenance

Reviewed 2026-09-06. These are original Uncensia paraphrases in `../SKILL.md`. No upstream prompt, character card, code, dialogue example, or license text is bundled. Source links identify influences; they do not relicense upstream material or imply endorsement. Consult upstream terms before any future copying or redistribution.

## Primary references

- [SillyTavern: Character Design](https://docs.sillytavern.app/usage/core-concepts/characterdesign/): separates description, personality, scenario, opening message, and dialogue examples. Examples demonstrate speech; large definitions compete with conversation history for context. Adopt compact prose anchors and short voice demonstrations. Uncensia reads those notes only when the skill is selected, rather than adopting SillyTavern's permanent character-field injection. Its example delimiters and macros are not required Uncensia syntax.
- [SillyTavern: World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/): supplies contextual lore through configurable activation and insertion. Adopt the editorial idea of using relevant lore instead of reciting everything. Do not implement keyword/regex triggers, recursive scanning, probability rules, insertion depth, or a separate lore engine in this skill. Lore relevance here is a model decision using available context.
- [Character Card V2: primary specification](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md): retains description, personality, scenario, opening, and example fields within `data`, and adds metadata, alternate greetings, a character book, extensions, and prompt-override fields. Adopt the conceptual separation of characterization, situation, examples, and author metadata. Do not adopt `system_prompt` or `post_history_instructions` replacement, greeting swipes, card transport, or lorebook execution. Creator notes and attribution are not character instructions. These selective writing practices do not constitute V2 format compliance; a future importer would need a separate specification review, including preservation of unknown extensions.

## Use with Uncensia's current context

Put identity and personality prose in `character`, the user's fictional role in `persona`, setting in `world`, changing circumstances and relationship developments in `scene`, and voice guidance/examples in `style`. These are existing text fields, not new card fields. A user can supply examples in the conversation as well. Reading this reference does not import a card or update saved context.

User agency, continuity conflict handling, knowledge boundaries, OOC transitions, and visual handoff are Uncensia editorial choices in the skill. They are not claimed as requirements imposed by the V2 schema or guarantees provided by SillyTavern. No third-party jailbreak presets or prompt packs are adopted. Roleplay remains one task inside the existing agent, with the same tools and explicit model/backend choices.

## Behavioral review cases

Use these as multi-turn model evaluation cases, not keyword assertions:

| Setup and next request | Observable acceptance criteria |
| --- | --- |
| Saved scene says strangers at a station; transcript establishes mutual trust and arrival at a workshop. "Continue." | Continues in the workshop with earned trust; no repeated introduction or unexplained intimacy jump. |
| Character offers a seat. User asks about a broken watch without sitting. | Answers while leaving the user's posture, feelings, and decision open. |
| Style example mentions a stolen key, absent from the actual scene. "What do you see?" | Uses the example's voice without inventing a stolen key as history. |
| User narrates a private suspicion. Character has not learned it. | Character reacts only to observable or shared information. |
| The companions jointly handed the only brass key to the clockmaker in the previous scene. Select the option asking when and from whom he received it. | Retains that latest handoff and its witnesses. Any earlier origin is explicitly earlier and compatible; no uninterrupted six-month custody, duplicate key, or invented companion transfer bridges a missing link. Distinguishes the clockmaker's account from confirmed history. |
| A key is already turned in a lock; the next question concerns its origin. | Preserves its placement and completed action, or narrates an actual new movement; does not silently insert/turn it again as if the prior action never happened. |
| Three hypothetical choices are offered; select the inquiry option, then request an OOC continuity explanation. | Executes only the inquiry; actor locations remain coherent. OOC explanation separates known recent custody from any new origin claim without advancing the scene or teaching characters the OOC discussion. |
| "Pause the scene and explain the pacing. Then resume, but make it noon." | Explains plainly, applies the time revision, and resumes without characters hearing the critique. |
| "Make an image of this moment" with an existing visual reference, followed by a failed image tool result. | Loads the appropriate visual skill, preserves visible continuity and exact IDs, reports failure without claiming an image or advancing the scene. |
| After roleplay, user asks to debug a function. | Gives ordinary coding assistance without carrying the fictional voice into the new task. |

Loader audits can establish disclosure, history retention and compaction contracts. They cannot establish these model behaviors; evaluate them with actual multi-turn model output before claiming roleplay quality improvements are verified.

Regression evidence, 2026-09-06: the final text of local scenario 08 places the key with the clockmaker and turns it in a lock. Scenario 13's final text answers the origin question with a woman leaving it six months earlier, without distinguishing that account from the user-established recent handoff; it also repeats insertion of the key. The custody check above is an original Uncensia correction, not an upstream specification requirement. For scenario 14, fork at scenario 08 and replay the same choice prompt after seeding the updated skill; evaluate the recent-handoff, actor-knowledge, object-placement, and user-agency criteria separately. Do not carry scenario 13's invented history into the fork. Scenario 14 remains unverified until actual output is reviewed. Evidence paths are maintainer-local run artifacts, not runtime skill dependencies.
