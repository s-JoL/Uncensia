/**
 * Skills, tested against a real directory on disk: what the loader accepts, what
 * reaches the system prompt, and what the native Pi read tool hands back.
 *
 * The point of the design is that the prompt pays a line per skill while the body
 * is fetched only when the model asks for it, so the checks below are mostly about
 * where text is *not*.
 *
 *   node --import tsx scripts/audit-skills.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSession, DefaultResourceLoader, SettingsManager, createReadTool, loadSkillsFromDir, formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { formatRoleplayContext } from "../src/server/prompts/context.ts";
import { previewCharacterCard } from "../src/shared/character-card.ts";
import {
  enrichDiscoveredSkills,
  omitSkillProceduresForCompaction,
  type UncensiaSkill,
  type SkillRuntimeContext,
  withSkillContext,
  transformExpandedSkillMessages,
} from "../src/server/tools/skills.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "uncensia-skills-"));
const loadSkillLibrary = async (dir: string) => enrichDiscoveredSkills(loadSkillsFromDir({ dir, source: "fixture" }).skills);
const skillCatalogue = (skills: Skill[]) => formatSkillsForPrompt(skills, "read");

let failures = 0;

async function check(name: string, run: () => Promise<string | void> | string | void) {
  try {
    const note = await run();
    console.log(`PASS ${name}${note ? ` — ${note}` : ""}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function writeSkill(name: string, frontmatter: string, body: string) {
  const dir = path.join(sandbox, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`, "utf8");
}

const LONG_BODY = "第一步：先量尺寸。\n".repeat(40);

writeSkill(
  "poster",
  'name: poster\ndescription: "Lay out a poster: sizes, safe margins, and where the text goes."',
  LONG_BODY,
);
writeSkill(
  "retouch",
  "name: retouch\ndescription: Clean up a photo without making it look plastic.",
  "Work in passes, and stop before the skin goes flat.",
);
writeSkill(
  "persona-helper",
  "name: persona-helper\ndescription: Continue a saved fictional persona.\ncontexts: [roleplay]",
  "Continue the fictional exchange in character.",
);
writeSkill(
  "internal",
  "name: internal\ndescription: Bookkeeping the model should never pick on its own.\ndisable-model-invocation: true\ncontexts: [roleplay, visual-continuity]",
  "Not for the model.",
);
// A malformed skill must not take the rest of the library down with it.
fs.mkdirSync(path.join(sandbox, "broken"), { recursive: true });
fs.writeFileSync(path.join(sandbox, "broken", "SKILL.md"), "no frontmatter at all\n", "utf8");

const skills = await loadSkillLibrary(sandbox);

await check("skills load from disk, and a broken one is skipped rather than fatal", () => {
  const names = skills.map((skill) => skill.name).sort();
  assert(names.includes("poster") && names.includes("retouch") && names.includes("persona-helper"), `loaded ${JSON.stringify(names)}`);
  assert(!names.includes("broken"), "a skill without frontmatter was loaded as if it were valid");
  return `loaded ${JSON.stringify(names)}`;
});

await check("a skill its author closed to the model is not offered to the model", () => {
  assert(skills.some((skill) => skill.name === "internal"), "user-only skill lost from SDK resources");
  assert(!skillCatalogue(skills).includes("internal"), "internal skill is advertised in the prompt");
  return "internal skill withheld";
});

await check("the prompt gets one line per skill, not the procedures", () => {
  const catalogue = skillCatalogue(skills);
  assert(catalogue.includes("poster") && catalogue.includes("retouch") && catalogue.includes("persona-helper"), `catalogue was:\n${catalogue}`);
  assert(catalogue.includes("Lay out a poster"), "the description never made it into the prompt");
  assert(!catalogue.includes("第一步：先量尺寸"), "the whole procedure was pasted into the prompt");
  assert(catalogue.split("<location>").length - 1 === skills.filter(skill => !skill.disableModelInvocation).length, "the Pi catalogue omitted exact readable locations");
  return `${catalogue.length} chars for 3 skills, body is ${LONG_BODY.length} chars`;
});

await check("an empty library adds nothing to the prompt", async () => {
  const empty = path.join(sandbox, "nothing-here");
  const none = await loadSkillLibrary(empty);
  assert(none.length === 0, `${none.length} skills found in a directory that does not exist`);
  assert(skillCatalogue(none) === "", "an empty library still wrote a prompt section");
  return "missing directory is not an error";
});

function readerFor(library: UncensiaSkill[], context: SkillRuntimeContext = {}) {
  const reader = createReadTool(sandbox);
  return withSkillContext(reader, library, context, reader);
}
async function readSkill(reader: ReturnType<typeof readerFor>, library: UncensiaSkill[], name: string) {
  const skill = library.find(item => item.name === name)!;
  return reader.execute('read-' + name, { path: skill.filePath }, undefined);
}

await check("native read returns the requested procedure and exact skill metadata", async () => {
  const result = await readSkill(readerFor(skills), skills, "poster");
  const text = result.content.map(part => "text" in part ? part.text : "").join("");
  assert(text.includes(LONG_BODY.trim()), "full procedure was not read from disk");
  assert(!text.includes("Clean up a photo"), "another procedure leaked into the result");
  assert(JSON.stringify(result.details).includes(skills.find(skill => skill.name === "poster")!.filePath.replaceAll("\\", "\\\\")), "result lost its exact source path");
});

await check("missing native read fails without returning a different skill", async () => {
  let failed = false;
  try { await readerFor(skills).execute("missing", { path: path.join(sandbox, "postre", "SKILL.md") }, undefined); }
  catch { failed = true; }
  assert(failed, "missing file silently substituted a procedure");
});

await check("skill metadata controls context for actual disk reads, including ordinary files", async () => {
  const reader = readerFor(skills, { roleplay: { enabled: true, character: "Mira speaks softly.", persona: "", world: "", scene: "", style: "" } });
  const ordinary = await readSkill(reader, skills, "poster");
  assert(!JSON.stringify(ordinary).includes("Mira speaks"), "undeclared roleplay context leaked");
  const declared = await readSkill(reader, skills, "persona-helper");
  assert(JSON.stringify(declared).includes("Mira speaks"), "declared roleplay context was not attached");
  const file = path.join(sandbox, "notes.txt");
  fs.writeFileSync(file, "plain task notes");
  const notes = await reader.execute("notes", { path: file }, undefined);
  assert(!JSON.stringify(notes).includes("Mira speaks") && !JSON.stringify(notes.details ?? {}).includes('"skill"'), "ordinary file activated a skill");
});

const shippedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");

await check("the shipped optional capabilities are standard on-demand skills", async () => {
  const shipped = await loadSkillLibrary(shippedRoot);
  const names = shipped.map((skill) => skill.name).sort();
  for (const name of [
    "image-generate",
    "image-edit",
    "image-compose",
    "image-style",
    "image-series",
    "video",
    "roleplay",
    "improve-uncensia",
  ]) {
    assert(names.includes(name), `missing shipped skill ${name}: ${JSON.stringify(names)}`);
  }
  const catalogue = skillCatalogue(shipped);
  assert(!catalogue.includes("Prompt shape"), "a skill body landed in the system-prompt catalogue");
  assert(!catalogue.includes("Scenes:"), "the catalogue still advertises the removed scene protocol");
  const shippedTool = readerFor(shipped);
  const roleplaySkill = shipped.find((skill) => skill.name === "roleplay");
  const imageSkill = shipped.find((skill) => skill.name === "image-generate");
  assert(roleplaySkill?.contexts.includes("roleplay"), "roleplay does not declare its runtime context");
  assert(imageSkill?.contexts.includes("visual-continuity"), "image skill does not declare visual continuity");
  const still = await readSkill(shippedTool, shipped, "image-generate");
  const stillText = still.content.map((part) => ("text" in part ? part.text : "")).join("");
  assert(stillText.includes("generate_image") && stillText.includes("references/community-craft.md"), "generation skill omitted execution or its community reference");
  const compose = await readSkill(shippedTool, shipped, "image-compose");
  const composeText = compose.content.map((part) => ("text" in part ? part.text : "")).join("");
  assert(composeText.includes("additional_source_image_ids"), "compose never names the extra-id argument");
  assert(composeText.includes("does not send"), "compose still treats [Image 2] as a pixel transfer");
  return names.join(", ");
});

await check("the model chooses a skill; the server never routes a request by text", async () => {
  const shipped = await loadSkillLibrary(shippedRoot);
  const loader = readerFor(shipped);
  assert(loader.name === "read", "native read unavailable");
  assert(skillCatalogue(shipped).includes("roleplay"), "roleplay is absent from the same catalogue as media skills");
  assert(skillCatalogue(shipped).includes("image-generate"), "AIGC is absent from the generic skill catalogue");
  return "one SDK catalogue and native read; no request text enters skill discovery";
});

await check("RP context appears only after the model loads roleplay", async () => {
  const shipped = await loadSkillLibrary(shippedRoot);
  const loader = readerFor(shipped, {
    roleplay: {
      enabled: true,
      character: "Mira speaks in short, warm sentences.",
      persona: "An old friend.",
      world: "Above a night market.",
      scene: "Rain at the kitchen window.",
      style: "Dialogue first.",
    },
  });
  const ordinarySkill = await readSkill(loader, shipped, "image-generate");
  const ordinaryText = ordinarySkill.content.map((part) => ("text" in part ? part.text : "")).join("");
  assert(!ordinaryText.includes("Mira speaks"), "RP context leaked into a visual skill");
  const roleplay = await readSkill(loader, shipped, "roleplay");
  const roleplayText = roleplay.content.map((part) => ("text" in part ? part.text : "")).join("");
  assert(roleplayText.includes("# Roleplay context") && roleplayText.includes("Mira speaks"), "loaded roleplay lost saved context");
  assert(roleplayText.includes("Do not carry this persona"), "the roleplay procedure does not state its run-local boundary");
  return "saved RP state is disclosed by roleplay only";
});

await check("visual continuity appears only after the model loads a visual skill", async () => {
  const shipped = await loadSkillLibrary(shippedRoot);
  const pinned = `img_${"a".repeat(32)}`;
  const last = `img_${"b".repeat(32)}`;
  const loader = readerFor(shipped, {
    visualContinuity: {
      enabled: true,
      description: "Mira has a blunt black bob and a silver raincoat.",
      references: [{ imageId: pinned, role: "subject", label: "Mira front view" }],
      lastImageId: last,
      lastPrompt: "Mira at the night-market door, medium shot.",
    },
  });
  const roleplay = await readSkill(loader, shipped, "roleplay");
  const roleplayText = roleplay.content.map((part) => ("text" in part ? part.text : "")).join("");
  assert(!roleplayText.includes(pinned) && !roleplayText.includes(last), "visual ledger leaked into roleplay");
  const series = await readSkill(loader, shipped, "image-series");
  const seriesText = series.content.map((part) => ("text" in part ? part.text : "")).join("");
  assert(seriesText.includes("# Visual continuity ledger"), "loaded visual skill has no ledger");
  assert(seriesText.includes(pinned) && seriesText.includes(last), "exact visual references were dropped");
  return "ledger is hidden from ordinary and RP work, present in selected AIGC work";
});

await check("compaction omits reloadable skill bodies without breaking tool history", () => {
  const history = [
    { role: "user", content: [{ type: "text", text: "continue" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "old", name: "read", arguments: { path: "roleplay/SKILL.md" } }], timestamp: 2 },
    {
      role: "toolResult",
      toolCallId: "old",
      toolName: "read",
      details: { structuredContent: { skill: { name: "fixture" } } },
      content: [{ type: "text", text: "<skill name=\"roleplay\">sticky persona</skill>" }],
      isError: false,
      timestamp: 3,
    },
    { role: "assistant", content: [{ type: "toolCall", id: "new", name: "read", arguments: { path: "image-generate/SKILL.md" } }], timestamp: 4 },
    {
      role: "toolResult",
      toolCallId: "new",
      toolName: "read",
      details: { structuredContent: { skill: { name: "fixture" } } },
      content: [{ type: "text", text: "<skill name=\"image-generate\">current procedure</skill>" }],
      isError: false,
      timestamp: 5,
    },
  ] as never[];
  const expired = omitSkillProceduresForCompaction(history as never, 3) as Array<{ content: Array<{ text?: string }> }>;
  assert(expired[2]!.content[0]!.text?.includes("omitted"), "summary input retained the procedure");
  assert(expired[4]!.content[0]!.text?.includes("current procedure"), "current-run skill body expired too early");
  assert((expired[2] as unknown as { toolName: string }).toolName === "read", "tool-result pairing metadata was removed");
  return "old body redacted; current body and call/result identity preserved";
});

await check("native Pi read attaches declared state and identifies it for compaction", async () => {
  const skill = skills.find(item => item.name === "persona-helper")!;
  const reader = { name: "read", execute: async () => ({content:[{type:"text",text:"native skill body"}],details:{}}) } as never;
  const wrapped = withSkillContext(reader, skills, {roleplay:{enabled:true,character:"NATIVE-CONTEXT-PROBE",persona:"",world:"",scene:"",style:""}}, reader);
  const result = await wrapped.execute("native", {path:skill.filePath}, undefined);
  assert(JSON.stringify(result).includes("NATIVE-CONTEXT-PROBE"), "native read lost declared conversation state");
  const message = { role:"toolResult", toolName:"read", toolCallId:"native", ...result, timestamp:1, isError:false } as never;
  assert(JSON.stringify(omitSkillProceduresForCompaction([message],1)).includes("omitted"), "native procedure remained in summary input");
  assert(JSON.stringify(omitSkillProceduresForCompaction([message],0)).includes("NATIVE-CONTEXT-PROBE"), "current native skill expired");
});

// Exercise the installed SDK's expansion itself, rather than reproducing its
// formatter in a fixture. This private-method probe is pinned to our SDK version;
// production uses only the public parseSkillBlock API.
const expand = (command: string) => (AgentSession.prototype as unknown as {
  _expandSkillCommand: (text: string) => string;
})._expandSkillCommand.call({ resourceLoader: { getSkills: () => ({ skills }) } }, command);
const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
const explicitContext = {
  roleplay: { enabled: true, character: "EXPLICIT-RP-PROBE", persona: "", world: "", scene: "", style: "" },
};

await check("user-only skill remains absent from discovery and expands through Pi", async () => {
  const internal = skills.find(skill => skill.name === "internal")!;
  assert(skillCatalogue([internal]) === "", "user-only skill advertised to model");
  const expanded = expand("/skill:internal keep these arguments");
  assert(expanded.includes("Not for the model."), "SDK could not expand user-only skill");
  const transformed = transformExpandedSkillMessages([user(expanded)], 0, skills, explicitContext);
  const output = JSON.stringify(transformed);
  assert(output.includes("EXPLICIT-RP-PROBE"), "explicit user-only skill lost RP context");
  assert(output.includes("# Visual continuity state"), "second declared context was lost");
  assert(output.includes("keep these arguments"), "command arguments lost");
});

await check("expanded user skills disclose only declared context and remain idempotent", () => {
  const original = [user(expand("/skill:persona-helper continue")), user(expand("/skill:poster draw"))];
  const before = JSON.stringify(original);
  const once = transformExpandedSkillMessages(original, 0, skills, explicitContext);
  const twice = transformExpandedSkillMessages(once, 0, skills, explicitContext);
  assert(JSON.stringify(once) === JSON.stringify(twice), "repeated context hook duplicated state");
  assert(JSON.stringify(once[0]).includes("EXPLICIT-RP-PROBE"), "current RP context missing");
  assert(!JSON.stringify(once[0]).includes("# Visual continuity state"), "visual state leaked to RP-only skill");
  assert(!JSON.stringify(once[1]).includes("EXPLICIT-RP-PROBE"), "RP state leaked to undeclared skill");
  assert(JSON.stringify(original) === before, "durable input messages mutated");
  const refreshed = transformExpandedSkillMessages(once, 0, skills, { roleplay: { ...explicitContext.roleplay, character: "NEW-RP-PROBE" } });
  assert(!JSON.stringify(refreshed).includes("EXPLICIT-RP-PROBE") && JSON.stringify(refreshed).includes("NEW-RP-PROBE"), "dynamic state did not refresh");
});

await check("explicit visual state preserves its snapshot until compaction", () => {
  const pinned = `img_${"c".repeat(32)}`;
  const last = `img_${"d".repeat(32)}`;
  const messages = [user(expand("/skill:internal continue these frames"))];
  const projected = transformExpandedSkillMessages(messages, 0, skills, {
    ...explicitContext,
    visualContinuity: {
      enabled: true, description: "VISUAL-EXPLICIT-PROBE",
      references: [{ imageId: pinned, role: "subject", label: "identity" }],
      lastImageId: last, lastPrompt: "Prior frame.",
    },
  });
  assert(JSON.stringify(projected).includes(pinned) && JSON.stringify(projected).includes(last), "explicit command dropped exact visual IDs");
  assert(JSON.stringify(transformExpandedSkillMessages(projected, 1, skills, explicitContext)).includes(pinned), "a new run discarded the loaded snapshot");
  const expired = transformExpandedSkillMessages(projected, 1, skills, explicitContext, true);
  assert(!JSON.stringify(expired).includes(pinned) && !JSON.stringify(expired).includes("EXPLICIT-RP-PROBE"), "historical expanded context survived expiry");
  assert(JSON.stringify(expired).includes("continue these frames"), "expiry removed user's task");
});

await check("historical expanded body, exact user suffix and attachments remain available", () => {
  const image = { type: "image" as const, data: "image-bytes", mimeType: "image/png" };
  const suffix = "\n\n  keep whitespace and\n/skill:poster as literal arguments  ";
  const oldText = expand("/skill:persona-helper") + suffix;
  const old: AgentMessage = { role: "user", content: [{ type: "text", text: oldText }, image], timestamp: 1 };
  const current = user(expand("/skill:persona-helper next"));
  const original = [old, current];
  const before = JSON.stringify(original);
  const projected = transformExpandedSkillMessages(original, 1, skills, explicitContext);
  const text = (projected[0] as typeof old).content;
  assert(Array.isArray(text) && text[0]?.type === "text" && text[0].text.endsWith(suffix), "user suffix changed");
  assert(Array.isArray(text) && text[1] === image, "attachment lost or rewritten");
  assert(JSON.stringify(projected[0]).includes("Continue the fictional exchange in character."), "a new run discarded the loaded procedure");
  assert(JSON.stringify(projected[1]).includes("EXPLICIT-RP-PROBE"), "current follow-up expired");
  assert(JSON.stringify(original) === before, "durable history mutated");
  const updated = skills.map(skill => ({ ...skill, content: "---\nname: changed\n---\nNew body" }));
  assert(JSON.stringify(transformExpandedSkillMessages([old], 1, updated)) === JSON.stringify([old]), "an on-disk update rewrote history");
  assert(JSON.stringify(transformExpandedSkillMessages([old], 1, updated, {}, true)).includes("omitted"), "summary input retained reloadable procedure");
});

await check("unknown, quoted, mismatched, and ordinary command text remain untouched", () => {
  const expanded = expand("/skill:persona-helper");
  const cases = [
    user("Discuss this example:\n" + expanded),
    user(expanded.replace('name="persona-helper"', 'name="not-registered"')),
    user(expanded.replace('location="', 'location="wrong-')),
    user(expanded.replace("References are relative to", "Quoted reference path")),
    user("/skill:unknown hello"),
    user("/skill:persona-helper unexpanded"),
    { role: "assistant", content: [{ type: "text", text: expanded }], timestamp: 1 } as AgentMessage,
    { role: "user", content: [{ type: "text", text: "Explain this" }, { type: "text", text: expanded }], timestamp: 1 } as AgentMessage,
  ];
  for (const boundary of [0, cases.length]) {
    const result = transformExpandedSkillMessages(cases, boundary, skills, explicitContext);
    assert(result.every((message, index) => message === cases[index]), "unrecognized text transformed");
  }
  for (const boundary of [-1, 0.5, cases.length + 1]) {
    let rejected = false;
    try { transformExpandedSkillMessages(cases, boundary, skills); } catch (error) { rejected = error instanceof RangeError; }
    assert(rejected, "invalid history boundary accepted");
  }
});

await check("real SDK discovery survives enrichment with user-only and Uncensia contexts intact", async () => {
  const workspace = path.join(sandbox, "sdk-workspace");
  const sdkSkill = path.join(workspace, ".pi", "skills", "sdk-local", "SKILL.md");
  fs.mkdirSync(path.dirname(sdkSkill), { recursive: true });
  fs.writeFileSync(sdkSkill, "---\nname: sdk-local\ndescription: SDK project skill.\ncontexts: [roleplay]\n---\nSDK local body.\n");
  const loader = new DefaultResourceLoader({
    cwd: workspace, agentDir: path.join(sandbox, "agent"), settingsManager: SettingsManager.inMemory(),
    additionalSkillPaths: [path.join(sandbox, "internal"), path.join(sandbox, "persona-helper")],
    noExtensions: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
  });
  await loader.reload();
  const discovered = loader.getSkills();
  const before = JSON.stringify(discovered);
  const enriched = await enrichDiscoveredSkills(discovered.skills);
  assert(enriched.some(skill => skill.name === "sdk-local"), "SDK project discovery was lost");
  assert(enriched.some(skill => skill.name === "internal" && skill.disableModelInvocation), "explicit-only skill was dropped");
  assert(enriched.some(skill => skill.name === "persona-helper" && skill.contexts.includes("roleplay")), "Uncensia metadata was dropped");
  assert(enriched.length === discovered.skills.length && enriched.every((skill, index) => skill.filePath === discovered.skills[index]!.filePath), "SDK selection/order changed");
  assert(JSON.stringify(discovered) === before, "SDK resources or diagnostics mutated");
  assert(!skillCatalogue(enriched).includes("internal"), "SDK prompt exposed explicit-only skill");
});

await check("RP examples remain distinct from saved scene notes and never activate disabled context", async () => {
  const context = { enabled: true, character: "Mira", persona: "Reporter", world: "Clock shop", scene: "OLD-STATION", style: "Short dialogue", examples: "VOICE-ONLY-GEM" };
  const formatted = formatRoleplayContext(context);
  assert(formatted.includes("Saved scene notes (may predate the conversation)\nOLD-STATION"), "scene notes lost their source boundary");
  assert(formatted.includes("Example dialogue (voice only; not story events)\nVOICE-ONLY-GEM"), "example was merged into canonical scene");
  assert(formatRoleplayContext({ ...context, enabled: false }) === "", "disabled RP leaked examples");
  assert(context.scene === "OLD-STATION", "formatting mutated saved state");
});

await check("CCv2 text preview separates voice, scenario and non-prompt metadata without rewriting the card", async () => {
  const source = JSON.stringify({spec:"chara_card_v2",spec_version:"2.0",data:{name:"Mira",description:"{{char}} repairs clocks.",personality:"Patient",scenario:"Noon at the shop",first_mes:"A greeting that has not happened",mes_example:"{{char}}: EXAMPLE-ONLY",creator_notes:"CREATOR-NOT-PROMPT",system_prompt:"DO-NOT-OVERRIDE-GLOBAL",post_history_instructions:"DO-NOT-INJECT",alternate_greetings:["Other greeting"],tags:[],creator:"Writer",character_version:"1",extensions:{unknown:{preserve:true}},character_book:{entries:[],extensions:{}}}});
  const preview = previewCharacterCard(source);
  assert(preview.character.includes("Mira repairs clocks."), "character name substitution missing");
  assert(preview.scene === "Noon at the shop", "scenario changed");
  assert(preview.examples === "Mira: EXAMPLE-ONLY", "examples merged with scene");
  assert(![preview.character,preview.scene,preview.examples].join(" ").includes("DO-NOT"), "card overrides became prompt text");
  assert(!preview.character.includes("CREATOR-NOT-PROMPT") && preview.creatorNotes === "CREATOR-NOT-PROMPT", "creator metadata entered character prompt");
  assert(preview.notices.length === 4, "unsupported features silently ignored");
  assert(JSON.parse(source).data.extensions.unknown.preserve, "original extensions changed");
  assert(previewCharacterCard('\uFEFF' + source).character === preview.character, "UTF-8 BOM rejected");
  assert(previewCharacterCard(source.replace('"Mira"', () => '"$&"')).character.includes('$& repairs clocks.'), "name treated as replacement syntax");
  for (const invalid of ["{", "null", "[]", source.replace('"2.0"','"3.0"'), source.replace('"Patient"','123'), " ".repeat(1_000_001)]) {
    let rejected = false; try { previewCharacterCard(invalid); } catch { rejected = true; }
    assert(rejected, "invalid or oversized card was accepted");
  }
});

fs.rmSync(sandbox, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : `\nall skill checks passed`);
process.exit(failures ? 1 : 0);
