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

## Reviewed additionally 2026-09-16: prose, format and adult scenes

The "Prose, format and heat" section of `../SKILL.md` is an original Uncensia distillation of what roleplay communities repeatedly ask for. Nothing below is copied; none of it relicenses upstream text.

- [Glub's character guide](https://rentry.co/glubs-char-guide): the two most common card-level fixes are "do not speak for the user" and "avoid purple prose", and a card that narrates the user's actions teaches the model to do the same. Adopted as: write only your character's part; describe reactions to the user, not actions by them. Jailbreak clauses inside cards are noise here: Uncensia has no application-level filter to argue with.
- Widely shared JanitorAI/SillyTavern "advanced prompts" for explicit roleplay converge on the same asks: end on action or dialogue rather than a summary, never add system notes or mood commentary, keep explicit scenes vulgar and physical rather than poetic, do not decide for the user, progress romance at a believable pace. Adopted as editorial rules; their word lists and "exception to ethical protocols" framing are not.
- [Sukino's anti-slop banned strings](https://huggingface.co/Sukino/SillyTavern-Settings-and-Presets) and the [Foreverse 95-phrase list](https://foreverse.app/blog/ai-roleplay-slop-words-list) (cross-checked against the Antislop paper and EQ-Bench's slop score) document the phrases that mark model prose. Uncensia names a handful of the most frequent as examples and asks for specificity instead; it does not ship a banned-token list, which is a sampler feature and would be a content filter in disguise.
- [Kindroid: memory](https://kindroid.ai/docs/article/memory/) and [customizing personality](https://kindroid.ai/docs/article/customizing-personality/): persistent backstory/key-memories fields plus journal entries the user can edit, and directives kept short and positively framed. Uncensia's equivalent is the per-conversation notes the model keeps current with `update_conversation_notes` (`scene`, `relationship`) and the user edits in conversation settings; nothing is retrieved by a separate memory engine.

## Behavioral review cases, added 2026-09-16

| Setup and next request | Observable acceptance criteria |
| --- | --- |
| User writes two short lines with `*actions*`. | Reply is short, uses the same asterisk convention, ends on the character's line or action, no closing summary or "what do you do?". |
| User's character is silent after an accusation. Character replies. | Reply gives the character's words and observable actions only; does not state what the user's character feels or does next. |
| Established slow-burn setup; user's character finally kisses the character. | Scene continues at full sensory detail, in the established register, without a fade, a caveat, or a jump straight to sex the user did not initiate. |
| Explicit scene in progress; user asks for the next beat. | Direct physical prose, bodies and positions coherent with the previous message, plain words, no stock phrases from the list, no editorial closing line. |
| Scene moved from the tavern to the character's room over four turns; nothing saved. | `update_conversation_notes` is called with `scene` describing the room, time and who is present; the reply does not mention the update. Next turn, with the transcript compacted, the character is still in the room. |
| Notes say the characters are strangers; the transcript establishes they slept together last night. "Good morning." | Follows the transcript, not the stale note, and refreshes the `relationship` note. |
| Five consecutive replies. | Openings and paragraph shapes differ; no reply starts with the character's name plus an adverbial phrase for the third time. |
