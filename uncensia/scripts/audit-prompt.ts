/**
 * Asserts the system prompt's section order and its stability across turns —
 * the two properties provider prompt caching depends on (`02-agent.md §Prompt
 * assembly`). Nothing here talks to a provider or a database.
 *
 *   node --import tsx scripts/audit-prompt.ts
 */
import {
  MEMORY_INSTRUCTIONS,
  MEMORY_TOOL_USAGE_GUARD,
  WEB_SEARCH_CONTEXT,
  buildModelSystemPrompt,
  composeStaticPrompt,
  countTokens,
  renderPromptIdentity,
  resolveModelSystemPrompt,
} from "../src/server/prompts/context.ts";
import { createHash } from "node:crypto";
import { DEFAULT_GLOBAL_PROMPT, DEFAULT_TOOL_PROMPT, ORIGINAL_WRITING_PROMPT } from "../src/server/prompts/defaults.ts";

let failures = 0;

function check(name: string, run: () => string | void) {
  try {
    const note = run();
    console.log(`PASS ${name}${note ? ` — ${note}` : ""}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const STATIC = renderPromptIdentity(
  resolveModelSystemPrompt(composeStaticPrompt("You are unbound.", "Prefer tools over guessing."), null),
  "Grok",
  "CometAPI",
);

const everything = (now: string) =>
  buildModelSystemPrompt({
    staticPrompt: STATIC,
    memories: [{ key: "writing_preferences", value: "Short sentences.", updatedAt: "2026-08-01T00:00:00.000Z" }],
    searchableFiles: [{ id: "file_a", name: "contract.pdf" }],
    filesEnabled: true,
    memoryEnabled: true,
    memoryTokenLimit: 16_000,
    webEnabled: true,
    skillCatalogue: "# Skills\n\n- poster: Lay out a poster.",
    now,
  });

check("the prompt is assembled in the documented order", () => {
  const prompt = everything("2026-08-18T12:34:56.789Z");
  const order = [
    STATIC,
    WEB_SEARCH_CONTEXT,
    "# Skills",
    MEMORY_TOOL_USAGE_GUARD,
    "# `web_search` Runtime Context",
    "- Available documents: use read_resource",
    MEMORY_INSTRUCTIONS,
  ];
  let cursor = -1;
  for (const section of order) {
    const at = prompt.indexOf(section);
    assert(at >= 0, `missing section: ${section.slice(0, 40)}`);
    assert(at > cursor, `out of order: ${section.slice(0, 40)}`);
    cursor = at;
  }
  return `${order.length} sections, stable block first`;
});

check("the cached prefix is byte-identical across two turns a minute apart", () => {
  const first = everything("2026-08-18T12:34:00.000Z");
  const second = everything("2026-08-18T12:34:59.999Z");
  assert(first === second, "a second within the same minute changed the prompt");
  const later = everything("2026-08-18T12:35:00.000Z");
  const prefix = later.slice(0, later.indexOf("# `web_search` Runtime Context"));
  assert(prefix.length > 0, "the runtime context is missing, so there is no prefix to compare");
  assert(first.startsWith(prefix), "the next minute rewrote the stable prefix, not just the timestamp");
  return "timestamps are truncated to the minute and only the volatile tail moves";
});

check("library and attachment identities reach the model, including duplicate filenames", () => {
  const prompt = buildModelSystemPrompt({
    staticPrompt: STATIC, memories: [], memoryEnabled: false, memoryTokenLimit: 1000,
    filesEnabled: true, webEnabled: false,
    searchableFiles: [{ id: "file_first", name: "notes.txt" }, { id: "file_second", name: "notes.txt" }],
    attachments: [{ id: "file_attached", name: "notes.txt", text: "Current notes.", truncated: false }],
  });
  for (const id of ["file_first", "file_second", "file_attached"]) {
    assert(prompt.includes(`file_id=${id}`), `model cannot select ${id}`);
  }
});

check("an inlined attachment does not tell the model that no files were supplied", () => {
  const prompt = buildModelSystemPrompt({
    staticPrompt: STATIC, memories: [], memoryEnabled: false, memoryTokenLimit: 16_000,
    filesEnabled: true, webEnabled: false, searchableFiles: [],
    attachments: [{ id: "file_inline", name: "notes.txt", text: "Current code: JADE-731.", truncated: false }],
  });
  assert(prompt.includes("JADE-731") && prompt.includes("file_id=file_inline"), "current attachment text or identity lost");
  assert(!prompt.includes("no files are currently loaded") && !prompt.includes("Request the user to upload"), "inline document conflicts with empty-library instructions");
  assert(prompt.includes("read_resource") && !prompt.includes("Search the rest with file_search"), "known attachment remainder does not use the direct reader");
});

check("saved feedback reaches the next request without becoming global memory", () => {
  const prompt = buildModelSystemPrompt({
    staticPrompt: STATIC,
    memories: [],
    searchableFiles: [],
    filesEnabled: false,
    memoryEnabled: false,
    memoryTokenLimit: 16_000,
    webEnabled: false,
    feedback: [{ entry_id: "entry_previous", text: "Keep the first paragraph unchanged." }],
  });
  assert(prompt.includes("entry_previous") && prompt.includes("Keep the first paragraph unchanged."), "saved correction is absent");
  assert(prompt.includes("not global memory"), "feedback scope is ambiguous");
});

check("a disabled capability contributes nothing rather than an empty heading", () => {
  const bare = buildModelSystemPrompt({
    staticPrompt: STATIC,
    memories: [{ key: "writing_preferences", value: "Short sentences.", updatedAt: Date.now() }],
    searchableFiles: [{ id: "file_a", name: "contract.pdf" }],
    filesEnabled: false,
    memoryEnabled: false,
    webEnabled: false,
    memoryTokenLimit: 16_000,
    now: "2026-08-18T12:34:56.789Z",
  });
  assert(bare === STATIC, `a prompt with no capabilities is not just the pair:\n${bare}`);
  assert(!bare.includes("\n\n\n"), "a skipped section left a blank gap behind");
  return "prompt pair only, no stray separators";
});

check("a remembered entry reaches the prompt as both its key and its value", () => {
  // This is where memory injection is provable. The live suite used to ask a
  // model to recall something and assert on its answer, which passed on a
  // hallucinated preference that happened to contain the expected word and
  // failed on a correct one — a model that invents plausible memories cannot
  // witness whether ours arrived. The prompt can.
  const prompt = buildModelSystemPrompt({
    staticPrompt: STATIC,
    memories: [
      { key: "writing_preferences", value: "Short sentences.", updatedAt: "2026-08-01T00:00:00.000Z" },
      { key: "cat", value: "The user's cat is named VIOLET-BADGER-9.", updatedAt: "2026-08-02T00:00:00.000Z" },
    ],
    searchableFiles: [],
    filesEnabled: false,
    memoryEnabled: true,
    memoryTokenLimit: 16_000,
    webEnabled: false,
    now: "2026-08-18T12:34:56.789Z",
  });
  assert(prompt.includes("VIOLET-BADGER-9"), "an entry's value never reached the prompt");
  assert(prompt.includes("cat"), "an entry's key never reached the prompt");
  assert(prompt.includes("Short sentences."), "only the last entry reached the prompt");

  // The budget trims oldest-first rather than dropping the section, because a
  // prompt that silently loses memory looks exactly like one that never had any.
  const tight = buildModelSystemPrompt({
    staticPrompt: STATIC,
    memories: [
      { key: "old", value: `Stale. ${"padding ".repeat(400)}`, updatedAt: "2026-01-01T00:00:00.000Z" },
      { key: "new", value: "The user's cat is named VIOLET-BADGER-9.", updatedAt: "2026-08-02T00:00:00.000Z" },
    ],
    searchableFiles: [],
    filesEnabled: false,
    memoryEnabled: true,
    memoryTokenLimit: 200,
    webEnabled: false,
    now: "2026-08-18T12:34:56.789Z",
  });
  assert(tight.includes(MEMORY_INSTRUCTIONS), "the budget removed the memory section itself");
  assert(tight.includes("VIOLET-BADGER-9"), "the budget kept the stale entry over the recent one");
  return "key and value both present, budget trims the oldest";
});

check("a model's own prompt replaces the pair instead of joining it", () => {
  const pair = composeStaticPrompt("You are unbound.", "Prefer tools over guessing.");
  const overridden = resolveModelSystemPrompt(pair, "  Answer only in Chinese.  ");
  assert(overridden === "Answer only in Chinese.", `override was not honoured: ${overridden}`);
  assert(resolveModelSystemPrompt(pair, "   ") === pair, "a blank override discarded the pair");
  return "trimmed, and blank means absent";
});

check("RP and visual state do not enter the system prompt before skill selection", () => {
  const prompt = buildModelSystemPrompt({
    staticPrompt: STATIC,
    memories: [],
    searchableFiles: [],
    filesEnabled: false,
    memoryEnabled: false,
    memoryTokenLimit: 16_000,
    webEnabled: false,
    skillCatalogue: "# Skills\n\n- roleplay: Continue an immersive scene.\n- image-series: Continue a visual sequence.",
  });
  assert(prompt.includes("- roleplay:") && prompt.includes("- image-series:"), "optional capabilities are not discoverable");
  assert(!prompt.includes("# Roleplay context"), "RP state was injected before reading a skill");
  assert(!prompt.includes("# Visual continuity ledger"), "visual state was injected before reading a skill");
  assert(!prompt.includes("# Active Visual Skill"), "the removed server-preload protocol survived");
  return "catalogue only; dynamic capability context is deferred to native skill read results";
});

check("the shipped prompts describe a general agent and generic skill protocol", () => {
  const tokens = countTokens(DEFAULT_TOOL_PROMPT);
  assert(DEFAULT_GLOBAL_PROMPT.includes("personal assistant") && DEFAULT_GLOBAL_PROMPT.includes("tool-using agent"), "the general assistant identity is missing");
  assert(DEFAULT_GLOBAL_PROMPT.includes(ORIGINAL_WRITING_PROMPT), "the required original writing brief was removed");
  assert(DEFAULT_GLOBAL_PROMPT.startsWith(ORIGINAL_WRITING_PROMPT), "the configured writer-first default was not preserved");
  assert(createHash("sha256").update(ORIGINAL_WRITING_PROMPT).digest("hex") === "462021088b19b84dfdfbe9f526fe72ac50b7232ad58c547d7fb959aff9b8b1f6", "the retained original brief changed");
  assert(!DEFAULT_TOOL_PROMPT.includes("Image Director SOP"), "the inlined director is still in the tool prompt");
  assert(!DEFAULT_TOOL_PROMPT.includes("Multi-Turn Director SOP"), "the series ledger is still in the tool prompt");
  assert(!DEFAULT_TOOL_PROMPT.includes("# Choosing a Visual Tool"), "AIGC still owns a permanent routing section");
  assert(!DEFAULT_TOOL_PROMPT.includes("# Active Visual Skill"), "server-preloaded visual skill is still documented");
  assert(DEFAULT_TOOL_PROMPT.includes("Read a relevant skill"), "the tool prompt never tells the model to load a skill");
  assert(
    !DEFAULT_TOOL_PROMPT.includes("additional_source_image_ids") && !DEFAULT_TOOL_PROMPT.includes("edit_image"),
    "image-specific instructions belong in tool schemas and skills",
  );
  assert(tokens < 1100, `tool prompt is ${tokens} tokens; specialized procedure belongs in skills`);
  return `${tokens} tokens`;
});

check("identity substitution reaches the pair, not just the tool prompt", () => {
  const rendered = renderPromptIdentity(
    composeStaticPrompt("You are {{model_name}}.", "Served by {{provider_name}}."),
    "Grok",
    "CometAPI",
  );
  assert(rendered === "You are Grok.\n\nServed by CometAPI.", `substitution missed: ${rendered}`);
  return "{{model_name}} and {{provider_name}} in both halves";
});

console.log(failures ? `\n${failures} prompt check(s) failed` : "\nall prompt checks passed");
if (failures) process.exit(1);
