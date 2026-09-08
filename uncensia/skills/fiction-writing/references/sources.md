# Sources and adaptation

Reviewed 2026-09-06. This is a small Uncensia adaptation of documented product workflows, not a claim that their complete prompts or applications have been imported.

- [NovelAI — Story Settings](https://docs.novelai.net/en/text/editor/storysettings/): optional memory for characters, setting and previous events, with a short author note for current direction. Adopt the distinction between story context and immediate direction; do not require the user to maintain a form or copy the application's context insertion rules.
- [DreamGen — Story Writing](https://dreamgen.com/story-writing): original fiction and fanfiction, reusable plot/character/location/style material, and direct user control over subsequent events. Adopt these user tasks in ordinary conversation without a separate mode.
- [Existing Uncensia roleplay sources](../../roleplay/references/community-methods.md): character voice, participant agency, and separation of examples from events. Keep interactive roleplay in that skill; writing a chapter does not itself make the user an in-scene participant.

The scope-completion, explicit-reference, no-fabricated-result and correction checks adapt the user's recorded Uncensia requirements. Their effectiveness must be evaluated on actual multi-turn output, not by matching these phrases in the source.

Reviewed additionally 2026-09-07:

- [SillyTavern Summarize](https://docs.sillytavern.app/extensions/summarize/) describes story summaries and their limits. [MemoryBooks](https://github.com/aikohanasaki/SillyTavern-MemoryBooks/blob/main/Start_Here.md) separates generating a summary from storing it in a lorebook. Uncensia adopts a concise, source-checked continuation point, not their storage or retrieval implementation.
- [Reddit long-context discussion](https://www.reddit.com/r/SillyTavernAI/comments/1uoc7o5/long_context_high_consistency_rps/) reports using summaries and scene notes for long RP. This is anecdotal task discovery, not evidence for a universal effective context length or an evaluated improvement in Uncensia. No prescribed context cutoff, extra model pass or automatic memory writer is added.
