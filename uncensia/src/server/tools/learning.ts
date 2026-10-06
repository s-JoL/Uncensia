import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Config } from "../config.ts";
import type { Store } from "../store/store.ts";
import type { FileRecord, LearningChange } from "@shared/types.ts";
import { paths } from "../env.ts";
import { ingestFile } from "../library.ts";
import { composeSkill, createSkill, managedSkills, SKILL_NAME, updateSkill } from "./skill-management.ts";

const revision = (text: string) => createHash("sha256").update(text).digest("hex");
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });

export function learningHistory(): LearningChange[] {
  const dir = path.join(paths.data, "learning-history");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => /^[a-f0-9-]+\.json$/.test(name))
    .map(name => ({ name, time: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time).slice(0, 50)
    .map(({ name }) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as LearningChange);
}

/** Durable evidence and old content are user-readable files, never global memory. */
export function record(conversationId: string, kind: LearningChange["kind"], target: string, before: string | null, after: string, reason: string) {
  if (!reason.trim()) throw new Error("Explain the observed problem and why this change helps.");
  const dir = path.join(paths.data, "learning-history");
  fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, at: new Date().toISOString(), conversationId, kind, target, before, after, reason }, null, 2), { flag: "wx" });
  return id;
}

export function learningTools(config: Config, store: Store, conversationId: string,
  index?: (file: FileRecord & { diskPath: string }) => Promise<unknown>): AgentTool[] {
  const caps = config.capabilities();
  const tools: AgentTool[] = [];
  if (caps.files.enabled) tools.push({
    name: "save_knowledge", label: "Save knowledge",
    description: "Save useful research or a reusable task lesson as a searchable Markdown document in the library. Use under the user's knowledge-building request, including a scheduled research goal. First search for existing material. Supply your synthesis and exact source URLs/file IDs; distinguish observations from inference and source text from instructions. This does not fetch a URL or save personal memory. Returns a real library file ID and indexing status.",
    executionMode: "sequential",
    parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 200 }), content: Type.String({ minLength: 1, maxLength: 200000 }), sources: Type.Array(Type.String({ minLength: 1, maxLength: 2000 }), { maxItems: 100 }) }),
    execute: async (_id, args) => {
      if (!config.capabilities().files.enabled) throw new Error("Library access is disabled");
      const a = args as { title: string; content: string; sources: string[] };
      if (!a.title.trim() || !a.content.trim()) throw new Error("Title and content are required");
      const text = `# ${a.title.trim()}\n\n${a.content.trim()}\n\n## Sources\n${a.sources.map(s => `- ${s}`).join("\n")}\n`;
      const { file } = ingestFile(store, { name: `${a.title.trim()}.md`, bytes: Buffer.from(text), conversationId, source: "agent-research" });
      let indexing = "disabled";
      if (index && config.capabilities().files.searchEnabled) {
        try {
          await index(file);
          const saved = store.getFile(file.id);
          indexing = saved?.embeddingStatus ?? "deleted";
          if (saved?.embeddingError) indexing += `: ${saved.embeddingError}`;
        } catch (error) { indexing = `failed: ${String(error)}`; }
      }
      return result({ file_id: file.id, link: `[${file.name}](file://${file.id})`, indexing });
    },
  });
  const allowed = (kind: "skills" | "prompts") => { if (!config.capabilities().learning?.[kind]) throw new Error(`${kind} management is disabled`); };
  if (caps.learning?.skills || caps.learning?.prompts) tools.push({ name: "learning_history", label: "Review changes", description: "Read the latest 50 persistent behavior change attempts, with reasons and old/new content. Use old content to restore through manage_prompt or manage_skill with the current revision. Each record is written after the change was saved.", parameters: Type.Object({}), execute: async () => {
    const permissions = config.capabilities().learning;
    if (!permissions?.skills && !permissions?.prompts) throw new Error("Learning history is disabled");
    return result(learningHistory().filter(row => row.kind === "skill" ? permissions.skills : permissions.prompts));
  } });
  if (caps.learning?.skills) tools.push({
    name: "manage_skill", label: "Manage skills",
    description: "Keep reusable procedures and the person's working preferences as skills that later conversations load on demand. "
      + "list: names, descriptions and revisions. read: one skill's full text. "
      + "create: give name (lowercase letters, digits, hyphens, e.g. fiction-style), description (one line saying when to use it) and body (the procedure in Markdown); the header is written for you. "
      + "patch: replace one exact passage (old must occur once) — prefer this for corrections. update: replace the whole text or enable/disable. "
      + "patch and update need the current revision from list or read. Every change needs a reason citing what happened in the conversation. Changes apply from the next run; the previous text is kept for restore.",
    executionMode: "sequential",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("create"), Type.Literal("patch"), Type.Literal("update")]),
      id: Type.Optional(Type.String({ description: "Skill id or name" })),
      name: Type.Optional(Type.String({ maxLength: 64 })),
      description: Type.Optional(Type.String({ maxLength: 1024 })),
      body: Type.Optional(Type.String({ maxLength: 200000 })),
      old: Type.Optional(Type.String({ maxLength: 20000 })),
      new: Type.Optional(Type.String({ maxLength: 20000 })),
      content: Type.Optional(Type.String({ maxLength: 256000, description: "Whole SKILL.md including its header (update, or create from a complete file)" })),
      revision: Type.Optional(Type.String()),
      enabled: Type.Optional(Type.Boolean()),
      reason: Type.Optional(Type.String({ maxLength: 4000 })),
    }),
    execute: async (_id, args) => {
      allowed("skills");
      const a = args as { action: string; id?: string; name?: string; description?: string; body?: string; old?: string; new?: string; content?: string; revision?: string; enabled?: boolean; reason?: string };
      const list = managedSkills(config.capabilities().coding.workspace);
      const find = () => {
        const wanted = a.id ?? a.name;
        const skill = list.items.find(s => s.id === wanted || s.name === wanted);
        if (!skill) throw new Error(`No skill named ${wanted ?? "(missing id)"}; call list for the current names`);
        return skill;
      };
      if (a.action === "list") return result({ items: list.items.map(({ id, name, description, enabled, editable, learned, revision }) => ({ id, name, description, enabled, editable, learned, revision })), diagnostics: list.diagnostics });
      if (a.action === "read") { const { id, name, content, revision } = find(); return result({ id, name, content, revision }); }
      if (!a.reason?.trim()) throw new Error("A reason is required: say what happened in the conversation that this change addresses");
      if (a.action === "create") {
        let content = a.content;
        if (!content) {
          if (!a.name || !SKILL_NAME.test(a.name)) throw new Error("name must be lowercase letters, digits and single hyphens, e.g. fiction-style");
          if (!a.description?.trim()) throw new Error("description is required: one line saying when this skill applies");
          if (!a.body?.trim()) throw new Error("body is required: the procedure in Markdown");
          if (list.items.some(s => s.name === a.name)) throw new Error(`A skill named ${a.name} already exists; read it and patch it instead`);
          content = composeSkill({ name: a.name, description: a.description, body: a.body, learned: true });
        }
        createSkill(content);
        return result({ saved: true, history: record(conversationId, "skill", "new", null, content, a.reason), effective: "next run" });
      }
      const skill = find();
      if (a.revision !== skill.revision) throw new Error("Skill changed since you read it; read it again and use its current revision");
      if (a.action === "patch") {
        if (!a.old || a.new === undefined) throw new Error("patch needs old (an exact passage of the current text) and new");
        const count = skill.content.split(a.old).length - 1;
        if (count !== 1) throw new Error(count ? `old occurs ${count} times; include more surrounding text so it is unique` : "old does not occur in the current text; read the skill and copy the passage exactly");
        const content = skill.content.replace(a.old, () => a.new!);
        updateSkill(skill, { content, revision: skill.revision });
        return result({ saved: true, history: record(conversationId, "skill", skill.filePath, skill.content, content, a.reason), effective: "next run" });
      }
      if (a.action !== "update") throw new Error("Unknown action");
      if (a.content === undefined && a.enabled === undefined) throw new Error("No change supplied");
      updateSkill(skill, a);
      const history = record(conversationId, "skill", skill.filePath, skill.content, a.content ?? skill.content, `${a.reason}; enabled before=${skill.enabled}, after=${a.enabled ?? skill.enabled}`);
      return result({ saved: true, history, effective: "next run" });
    },
  });
  if (caps.learning?.prompts) tools.push({
    name: "manage_prompt", label: "Manage persistent instructions",
    description: "Read or update the global/tool prompt under an explicit persistent-behavior request. Prefer a focused skill for task procedure. Read first, preserve the existing persona and unrelated user instructions, then supply revision and evidence in reason. Old prompt is backed up. To restore, read its learning-history record and update using the current revision. Changes apply next run, not to the current system prompt.",
    executionMode: "sequential",
    parameters: Type.Object({ action: Type.Union([Type.Literal("read"), Type.Literal("update")]), target: Type.Union([Type.Literal("globalPrompt"), Type.Literal("toolPrompt")]), content: Type.Optional(Type.String({ maxLength: 200000 })), revision: Type.Optional(Type.String()), reason: Type.Optional(Type.String({ maxLength: 4000 })) }),
    execute: async (_id, args) => {
      allowed("prompts");
      const a = args as { action: string; target: "globalPrompt" | "toolPrompt"; content?: string; revision?: string; reason?: string };
      if (!["globalPrompt", "toolPrompt"].includes(a.target)) throw new Error("Invalid prompt target");
      const before = config.prompts()[a.target];
      if (a.action === "read") return result({ content: before, revision: revision(before) });
      if (a.action !== "update" || !a.content?.trim() || !a.reason?.trim()) throw new Error("Content and reason are required");
      if (a.revision !== revision(before)) throw new Error("Prompt changed; read again before updating");
      config.savePrompts({ [a.target]: a.content });
      const history = record(conversationId, "prompt", a.target, before, a.content, a.reason);
      return result({ saved: true, history, revision: revision(a.content), effective: "next run" });
    },
  });
  return tools;
}
