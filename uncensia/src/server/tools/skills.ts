import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { parseFrontmatter, parseSkillBlock, stripFrontmatter, type Skill } from "@earendil-works/pi-coding-agent";
import type { RoleplayContext, VisualContinuityContext } from "@shared/types.ts";
import { paths } from "../env.ts";
import { formatRoleplayContext, formatVisualContinuityContext } from "../prompts/context.ts";

const SKILL_CONTEXTS = ["roleplay", "visual-continuity"] as const;
export type SkillContextName = (typeof SKILL_CONTEXTS)[number];

export interface UncensiaSkill extends Skill {
  content: string;
  /** Optional runtime state named by the skill itself, never inferred from the request or skill name. */
  contexts: SkillContextName[];
}

/**
 * Skills are folders of written instructions the agent can pull in when a task
 * calls for them: `data/skills/<name>/SKILL.md`, with a `name` and `description`
 * in the frontmatter and the procedure in the body.
 *
 * Only the one-line descriptions go into the system prompt. The body — which can
 * be thousands of tokens of procedure — is fetched by native read, and only
 * for the skill the model actually decided to use. That is what makes a large
 * library of skills affordable: the prompt grows by a line per skill, not by a
 * document per skill.
 *
 * Settings can edit these files or exclude a skill from SDK discovery.
 * Disabling does not delete its instructions or rewrite earlier conversations.
 */
function declaredContexts(content: string, filePath: string): SkillContextName[] {
  try {
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(content);
    const values = Array.isArray(frontmatter.contexts)
      ? frontmatter.contexts
      : frontmatter.contexts === undefined
        ? []
        : [frontmatter.contexts];
    const declared = values.filter((value): value is string => typeof value === "string");
    const unknown = declared.filter((value) => !SKILL_CONTEXTS.includes(value as SkillContextName));
    if (unknown.length) console.warn(`[skills] unknown contexts in ${filePath}: ${unknown.join(", ")}`);
    return [...new Set(declared.filter((value): value is SkillContextName => SKILL_CONTEXTS.includes(value as SkillContextName)))];
  } catch (error) {
    console.warn(`[skills] could not read contexts in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/** Enrich Pi's effective discovery result; never reinsert excluded skills or
 * replace its name-collision winners. Call after resourceLoader.reload(), and
 * use this same snapshot for read wrapping and explicit-command transforms.
 * additionalSkillPaths includes Uncensia's directory; SDK diagnostics remain with the loader. */
export async function enrichDiscoveredSkills(skills: Skill[]): Promise<UncensiaSkill[]> {
  return Promise.all(skills.map(async skill => {
    const content = await fs.readFile(skill.filePath, "utf8");
    return { ...skill, content, contexts: declaredContexts(content, skill.filePath) };
  }));
}

export interface SkillRuntimeContext {
  roleplay?: RoleplayContext;
  visualContinuity?: VisualContinuityContext;
}

const CONTEXT_PROVIDERS: Record<SkillContextName, (context: SkillRuntimeContext) => string> = {
  roleplay: (context) =>
    formatRoleplayContext(context.roleplay) ||
    "# Saved roleplay context\n\nNo saved roleplay context is enabled. Use only the current request and conversation.",
  "visual-continuity": (context) =>
    formatVisualContinuityContext(context.visualContinuity) ||
    "# Visual continuity state\n\nThe reader has not enabled saved visual continuity for this conversation. Use only exact image ids present in the request or transcript.",
};

function runtimeContextFor(skill: UncensiaSkill, context: SkillRuntimeContext) {
  return skill.contexts.map((name) => CONTEXT_PROVIDERS[name](context)).join("\n\n");
}

/** Pi's native read is the skill entry point. Attach only the state declared by
 * the exact SKILL.md being read; unrelated reads never activate a procedure. */
export function withSkillContext(reader: AgentTool, skills: UncensiaSkill[], context: SkillRuntimeContext, restrictedReader: AgentTool): AgentTool {
  const byPath = new Map(skills.map(skill => [path.resolve(skill.filePath), skill]));
  return { ...reader, execute: async (id, args, signal, update) => {
    const file = path.resolve(String((args as { path?: string }).path ?? ""));
    const relative = path.relative(paths.skills, file);
    const inSkills = !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
    const result = await (inSkills ? restrictedReader : reader).execute(id, args, signal, update);
    const skill = byPath.get(file);
    if (!skill) return result;
    const attached = runtimeContextFor(skill, context);
    return { ...result, content: [...result.content, ...(attached ? [{ type: "text" as const, text: attached }] : [])],
      details: { ...result.details as object, structuredContent: { skill: { name: skill.name, path: skill.filePath } } } };
  }};
}

const EXPLICIT_CONTEXT_START = "\n\n<uncensia-skill-context>\n";
const EXPLICIT_CONTEXT_END = "\n</uncensia-skill-context>";

/** Model-facing copy only: apply before history budgeting/compaction input,
 * never in message persistence. historyLength is the current run boundary in
 * this message array, not a turn count. The host must keep it aligned if Pi
 * compacts/replaces history. Current steering/follow-up expansions also qualify.
 * Recognition uses Pi's parser plus the discovered exact name/path/baseDir.
 * This is syntax recognition, not proof of origin: a verbatim pasted SDK block
 * is indistinguishable from an SDK expansion without host provenance metadata.
 * Unknown or no-longer-discovered skills are deliberately left untouched. */
export function transformExpandedSkillMessages(
  messages: AgentMessage[], historyLength: number, skills: UncensiaSkill[], context: SkillRuntimeContext = {},
  forCompaction = false,
): AgentMessage[] {
  if (!Number.isInteger(historyLength) || historyLength < 0 || historyLength > messages.length) {
    throw new RangeError("Skill history boundary must be an index in the supplied messages");
  }
  const byLocation = new Map(skills.map(skill => [skill.filePath, skill]));
  const transformText = (text: string, historical: boolean) => {
    const parsed = parseSkillBlock(text);
    if (!parsed) return text;
    const skill = byLocation.get(parsed.location);
    if (!skill || skill.name !== parsed.name) return text;
    const referenceLine = `References are relative to ${skill.baseDir}.\n\n`;
    if (!parsed.content.startsWith(referenceLine)) return text;
    const opening = `<skill name="${parsed.name}" location="${parsed.location}">\n`;
    const closingOffset = opening.length + parsed.content.length;
    // Keep the user's argument suffix byte-for-byte (the SDK parser trims it).
    const suffix = text.slice(closingOffset + "\n</skill>".length);
    // Keep the SDK's loaded procedure available to later related turns. The
    // model decides its scope; a new HTTP run is not a semantic task boundary.
    // Historical snapshots are never rewritten with today's saved context.
    if (historical) return forCompaction ? `[Skill ${skill.name} procedure omitted from summary input.]${suffix}` : text;
    const canonical = referenceLine + stripFrontmatter(skill.content).trim();
    // Only append to the actual current procedure (or our own prior transform).
    // Do not interpret arbitrary XML-looking user prose as a skill invocation.
    if (parsed.content !== canonical && !(parsed.content.startsWith(canonical + EXPLICIT_CONTEXT_START) && parsed.content.endsWith(EXPLICIT_CONTEXT_END))) return text;
    const attached = runtimeContextFor(skill, context);
    const body = canonical + (attached ? EXPLICIT_CONTEXT_START + attached + EXPLICIT_CONTEXT_END : "");
    return `${opening}${body}\n</skill>${suffix}`;
  };
  return messages.map((message, index) => {
    if (message.role !== "user") return message;
    if (typeof message.content === "string") {
      const content = transformText(message.content, index < historyLength);
      return content === message.content ? message : { ...message, content };
    }
    // Pi puts the expansion in the first text block, followed by attachments.
    // Do not activate quoted blocks in later text/attachment parts.
    const first = message.content[0];
    if (first?.type !== "text") return message;
    const text = transformText(first.text, index < historyLength);
    return text === first.text ? message : { ...message, content: [{ ...first, text }, ...message.content.slice(1)] };
  });
}

/**
 * Omit reloadable procedures from compaction input, while retaining user tasks
 * and tool pairing. Normal model turns keep the SDK's loaded skill history;
 * HTTP run boundaries do not decide whether a procedure is still useful.
 */
export function omitSkillProceduresForCompaction(messages: AgentMessage[], historyLength: number): AgentMessage[] {
  return messages.map((message, index) => {
    const row = message as { role?: string; toolName?: string; details?: { structuredContent?: { skill?: unknown } } };
    if (index >= historyLength || row.role !== "toolResult" || !row.details?.structuredContent?.skill) return message;
    return {
      ...message,
      content: [{ type: "text", text: "[Skill procedure omitted from summary input; reload if needed.]" }],
    } as AgentMessage;
  });
}
