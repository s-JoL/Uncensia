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
import { createSkill, managedSkills, updateSkill } from "./skill-management.ts";

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
function record(conversationId: string, kind: LearningChange["kind"], target: string, before: string | null, after: string, reason: string) {
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
  if (!caps.coding.write) return tools;
  const allowed = () => { if (!config.capabilities().coding.write) throw new Error("Self-editing is disabled"); };
  tools.push({ name: "learning_history", label: "Review changes", description: "Read the latest 50 persistent behavior change attempts, with reasons and old/new content. Use old content to restore through manage_prompt or manage_skill with the current revision. Records are backups before a write, not proof of successful application.", parameters: Type.Object({}), execute: async () => { allowed(); return result(learningHistory()); } });
  tools.push({
    name: "manage_skill", label: "Manage skills",
    description: "List, create, revise or enable a reusable skill when authorized to improve persistent behavior. List first; update requires the exact current revision. Keep task-specific procedure in skills and preserve unrelated instructions. Record concrete evidence in reason. Saved changes are discovered on the next run. Old content is saved to learning history before a change; a history record is an attempted change, not proof it succeeded.",
    executionMode: "sequential",
    parameters: Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("create"), Type.Literal("update")]), id: Type.Optional(Type.String()), content: Type.Optional(Type.String({ maxLength: 256000 })), revision: Type.Optional(Type.String()), enabled: Type.Optional(Type.Boolean()), reason: Type.Optional(Type.String({ maxLength: 4000 })) }),
    execute: async (_id, args) => {
      allowed();
      const a = args as { action: string; id?: string; content?: string; revision?: string; enabled?: boolean; reason?: string };
      const list = managedSkills(config.capabilities().coding.workspace);
      if (a.action === "list") return result(list);
      if (!a.reason?.trim()) throw new Error("A reason is required");
      if (a.action === "create") {
        if (!a.content) throw new Error("Skill content is required");
        const history = record(conversationId, "skill", "new", null, a.content, a.reason);
        createSkill(a.content);
        return result({ saved: true, history, effective: "next run" });
      }
      if (a.action !== "update") throw new Error("Unknown action");
      const skill = list.items.find(s => s.id === a.id);
      if (!skill || a.revision !== skill.revision) throw new Error("Skill changed or is missing; list again before updating");
      if (a.content === undefined && a.enabled === undefined) throw new Error("No change supplied");
      const history = record(conversationId, "skill", skill.filePath, skill.content, a.content ?? skill.content, `${a.reason}; enabled before=${skill.enabled}, after=${a.enabled ?? skill.enabled}`);
      updateSkill(skill, a);
      return result({ saved: true, history, effective: "next run" });
    },
  }, {
    name: "manage_prompt", label: "Manage persistent instructions",
    description: "Read or update the global/tool prompt under an explicit persistent-behavior request. Prefer a focused skill for task procedure. Read first, preserve the existing persona and unrelated user instructions, then supply revision and evidence in reason. Old prompt is backed up. To restore, read its learning-history record and update using the current revision. Changes apply next run, not to the current system prompt.",
    executionMode: "sequential",
    parameters: Type.Object({ action: Type.Union([Type.Literal("read"), Type.Literal("update")]), target: Type.Union([Type.Literal("globalPrompt"), Type.Literal("toolPrompt")]), content: Type.Optional(Type.String({ maxLength: 200000 })), revision: Type.Optional(Type.String()), reason: Type.Optional(Type.String({ maxLength: 4000 })) }),
    execute: async (_id, args) => {
      allowed();
      const a = args as { action: string; target: "globalPrompt" | "toolPrompt"; content?: string; revision?: string; reason?: string };
      if (!["globalPrompt", "toolPrompt"].includes(a.target)) throw new Error("Invalid prompt target");
      const before = config.prompts()[a.target];
      if (a.action === "read") return result({ content: before, revision: revision(before) });
      if (a.action !== "update" || !a.content?.trim() || !a.reason?.trim()) throw new Error("Content and reason are required");
      if (a.revision !== revision(before)) throw new Error("Prompt changed; read again before updating");
      const history = record(conversationId, "prompt", a.target, before, a.content, a.reason);
      config.savePrompts({ [a.target]: a.content });
      return result({ saved: true, history, revision: revision(a.content), effective: "next run" });
    },
  });
  return tools;
}
