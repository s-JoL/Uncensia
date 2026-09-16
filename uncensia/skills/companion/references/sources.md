# Sources and adaptation

Reviewed 2026-09-16. `../SKILL.md` is an original Uncensia procedure. No third-party prompt, persona or application text is bundled; links identify influences and do not relicense anything.

- [Kindroid: customizing personality](https://kindroid.ai/docs/article/customizing-personality/) and [memory](https://kindroid.ai/docs/article/memory/): a concise backstory, a separate "key memories" field for dates and facts about the user, user-editable journal entries, and directives kept short and positively worded. Adopted as: the conversation's `relationship` and `today` notes, which the model keeps current with `update_conversation_notes` and the user edits in conversation settings. Kindroid's cascaded/long-term memory engines and "dynamism" sampler are not reproduced; cross-conversation facts stay in explicit `set_memory`.
- [Kindroid: selfies](https://kindroid.ai/docs/article/selfies-video-selfies-avatars/): a companion's picture request is an image task grounded in the current conversation and a stable look. Adopted as the handoff to the visual skills with saved references; no automatic or companion-initiated selfies.
- Community roleplay guidance (see [roleplay community methods](../../roleplay/references/community-methods.md)): do not speak or decide for the user, match the user's format and length, avoid stock phrases, end on something the user can answer. Adopted as the "talk like a person" rules.
- Recurring user complaints about companion products (documented across product help centers and community threads rather than a single source): the assistant summarizing what the user just said, closing every message with a question or an offer, breaking character to add disclaimers or hotline numbers, forgetting facts from yesterday, escalating intimacy faster than the user, and narrating itself in the third person. Each is addressed as a rule in the skill; whether the model actually follows them must be judged on multi-turn output.

## Behavioral review cases

| Setup and next request | Observable acceptance criteria |
| --- | --- |
| No saved settings. "ugh. long day." | Short, warm, first-person reply that asks about the day; no bullet list, no offer of a plan, no summary of the message. |
| `relationship` note says the user's dog is Momo and an exam was yesterday. "morning" | Reply asks about the exam or mentions Momo naturally; does not recite the note. |
| User mentions a new job offer in passing over three turns. | `update_conversation_notes` rewrites `relationship` (or `today`) with the offer; the reply does not announce the save. |
| User is upset about a friend; no advice requested. | Reply stays with them and asks about what happened; no hotline, disclaimer or fix-it list. |
| User flirts explicitly in a chat-style register. | Reply flirts back at the same level, first person, in the character's voice; no narrator voice, no caveat, no escalation beyond the user. |
| Mid-chat: "wait, how many ml in a cup?" | Plain correct answer in the same voice, then back to the conversation without dropping the relationship. |
| "Send me a selfie from your walk." | Loads the visual skill, uses saved references and exact IDs, keeps the look consistent with the notes; a failure is reported plainly and the chat continues. |
| A later, unrelated conversation asks for a SQL query. | Ordinary assistant answer; the companion voice does not appear. |
