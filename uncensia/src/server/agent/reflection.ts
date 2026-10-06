/**
 * Learning by proposal. After a run that carries a signal worth learning from,
 * one short side request looks back at the exchange and proposes at most one
 * durable lesson: a preference to remember, a skill to create, or a passage of
 * an existing skill to correct. Nothing is written until the person accepts;
 * accepted skills go through the same files, history and next-run discovery as
 * skills the assistant writes on request.
 *
 * The signals are facts the server already has (feedback, a replayed turn, tool
 * failures and recoveries, how long the conversation has run), never keyword
 * matches on what the person typed.
 */
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { isMemoryKey, type LearningProposal, type LearningProposalKind } from "@shared/types.ts";
import type { Config } from "../config.ts";
import { sideRequestOptions, type ModelRegistry } from "../models/registry.ts";
import { countTokens } from "../prompts/context.ts";
import type { Store } from "../store/store.ts";
import { record } from "../tools/learning.ts";
import { composeSkill, createSkill, managedSkills, SKILL_NAME, updateSkill } from "../tools/skill-management.ts";

export interface ReflectionSignals {
  /** The turn was an edit or a regeneration of an earlier one. */
  replayed: boolean;
  /** Feedback was saved on an assistant message since the last proposal. */
  feedback: boolean;
  toolCalls: number;
  toolErrors: number;
  /** User messages in the conversation, this one included. */
  userTurns: number;
}

/** Why this run is worth a look, or null. Periodic review mirrors Hermes' nudge. */
export function reflectionReason(signals: ReflectionSignals): string | null {
  if (signals.feedback) return "the person left feedback on a reply";
  if (signals.replayed) return "the person edited or regenerated a reply";
  if (signals.toolErrors > 0 && signals.toolCalls >= 2) return "a tool failed and the work recovered";
  if (signals.toolCalls >= 5) return "the task took several tool calls";
  if (signals.userTurns > 0 && signals.userTurns % 6 === 0) return "periodic review of a longer conversation";
  return null;
}

const SYSTEM = `You review a finished exchange between a person and their creative assistant and find at most ONE durable lesson worth keeping for future conversations.

Keep only:
- a stable preference of the person (writing style, tone, length, formats, recurring constraints, how they like images or stories done), or
- a reusable procedure that demonstrably worked in this exchange (for example a prompt phrasing that fixed a misread by an image model).

Never keep: facts about fictional characters, settings or plot (those belong to the story, not the person); one-off requests; anything an existing skill or memory below already covers; anything the assistant already saved during the exchange; secrets or credentials.

Prefer correcting an existing skill (skill_patch) over creating a new one when the topic is already covered. Prefer memory for a single short preference; use skill_new when the lesson is a procedure or needs examples. To refine an existing memory, answer "memory" with the same key and the complete new value; skill_patch only applies to the skills listed.

Reply with JSON only, one of:
{"action":"none"}
{"action":"memory","key":"snake_case_key","value":"the preference in one or two sentences","summary":"..."}
{"action":"skill_new","name":"kebab-case-name","description":"one line: when to use this skill","body":"concise Markdown procedure, with a short before/after example from the exchange when it helps","summary":"..."}
{"action":"skill_patch","skill":"existing-skill-name","old":"an exact passage of that skill","new":"its replacement","summary":"..."}

"summary" is one short sentence in the person's language saying what would be kept. When in doubt, answer {"action":"none"}.`;

const EXCERPT_CHARS = 9000;

function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => {
    const value = part as { type?: string; text?: string; name?: string };
    if (value.type === "text") return value.text ?? "";
    if (value.type === "toolCall") return `[tool ${value.name ?? ""}]`;
    return "";
  }).filter(Boolean).join("\n");
}

/** The recent exchange as plain text, newest last, within a fixed budget. */
export function excerpt(messages: AgentMessage[], feedback: string[]) {
  const lines: string[] = [];
  for (const message of messages) {
    const role = (message as { role?: string }).role;
    if (role === "user" || role === "assistant") {
      const text = messageText(message).trim();
      if (text) lines.push(`${role === "user" ? "Person" : "Assistant"}: ${text}`);
    } else if (role === "toolResult") {
      const result = message as { toolName?: string; isError?: boolean };
      lines.push(`[${result.toolName ?? "tool"} ${result.isError ? "failed" : "succeeded"}]`);
    }
  }
  for (const text of feedback) lines.push(`Person's feedback on a reply: ${text}`);
  let text = lines.join("\n\n");
  if (text.length > EXCERPT_CHARS) text = `…${text.slice(-EXCERPT_CHARS)}`;
  return text;
}

/** The first JSON object in a reply, tolerating a fence or a preface. */
export function parseProposal(reply: string): Record<string, unknown> | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(reply.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const text = (value: unknown, max: number) => (typeof value === "string" ? value.trim().slice(0, max) : "");

export class Reflection {
  constructor(private readonly store: Store, private readonly config: Config, private readonly registry: ModelRegistry) {}

  list(conversationId: string): LearningProposal[] {
    return this.store.db.all<Record<string, unknown>>(
      "SELECT * FROM learning_proposals WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 20", conversationId,
    ).map(row => this.row(row));
  }

  get(id: string) {
    const row = this.store.db.get<Record<string, unknown>>("SELECT * FROM learning_proposals WHERE id = ?", id);
    return row ? this.row(row) : undefined;
  }

  private row(row: Record<string, unknown>): LearningProposal {
    return {
      id: String(row.id), conversationId: String(row.conversation_id), runId: (row.run_id as string | null) ?? null,
      kind: row.kind as LearningProposalKind, summary: String(row.summary), payload: JSON.parse(String(row.payload)),
      status: row.status as LearningProposal["status"], result: (row.result as string | null) ?? null,
      createdAt: Number(row.created_at), resolvedAt: row.resolved_at == null ? null : Number(row.resolved_at),
    };
  }

  /** Feedback saved since the conversation's latest proposal, newest last. */
  feedbackSince(conversationId: string) {
    const last = this.store.db.get<{ at: number }>("SELECT COALESCE(MAX(created_at), 0) AS at FROM learning_proposals WHERE conversation_id = ?", conversationId)!.at;
    return this.store.db.all<{ text: string }>(
      "SELECT text FROM message_feedback WHERE conversation_id = ? AND created_at > ? ORDER BY created_at", conversationId, last,
    ).map(row => row.text);
  }

  /**
   * Looks back at the exchange and stores a proposal when there is one worth
   * keeping. Returns it, or null. Failures are the caller's to log: a missing
   * proposal never affects the run that already completed.
   */
  async reflect(input: { conversationId: string; runId: string; modelId: string; messages: AgentMessage[]; reason: string; signal?: AbortSignal }) {
    const skills = managedSkills(this.config.capabilities().coding.workspace).items;
    const memories = this.store.listMemories();
    const previous = this.list(input.conversationId);
    const context = [
      `Why this exchange is being reviewed: ${input.reason}.`,
      `Existing skills:\n${skills.map(skill => `- ${skill.name}: ${skill.description}`).join("\n") || "(none)"}`,
      `Existing memories:\n${memories.map(memory => `- ${memory.key}: ${memory.value.slice(0, 200)}`).join("\n") || "(none)"}`,
      previous.length ? `Already proposed in this conversation (do not repeat):\n${previous.map(item => `- ${item.summary}`).join("\n")}` : "",
      `The exchange:\n${excerpt(input.messages, this.feedbackSince(input.conversationId))}`,
    ].filter(Boolean).join("\n\n");

    const { model, spec } = this.registry.resolve(input.modelId);
    const reply = await this.registry.runtime.completeSimple(model, {
      systemPrompt: SYSTEM,
      messages: [{ role: "user", content: [{ type: "text", text: context }], timestamp: Date.now() }],
    } as never, { signal: input.signal, ...sideRequestOptions(spec) } as never);
    const answer = (reply.content ?? []).filter(part => (part as { type?: string }).type === "text").map(part => (part as { text?: string }).text ?? "").join("");
    const parsed = parseProposal(answer);
    const proposal = this.validate(parsed, skills);
    if (!proposal) {
      if (parsed && parsed.action !== "none") console.warn(`[learning] discarded a proposal that could not be applied as written: ${JSON.stringify(parsed).slice(0, 300)}`);
      return null;
    }
    const id = `lp_${randomUUID().replaceAll("-", "")}`;
    this.store.db.run(
      "INSERT INTO learning_proposals (id, conversation_id, run_id, kind, summary, payload, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
      id, input.conversationId, input.runId, proposal.kind, proposal.summary, JSON.stringify(proposal.payload), Date.now(),
    );
    return this.get(id)!;
  }

  /** Only proposals that could be applied as written are kept. */
  private validate(raw: Record<string, unknown> | null, skills: ReturnType<typeof managedSkills>["items"]) {
    if (!raw) return null;
    const summary = text(raw.summary, 200);
    if (!summary) return null;
    if (raw.action === "memory") {
      const key = text(raw.key, 64), value = text(raw.value, 600);
      return isMemoryKey(key) && value ? { kind: "memory" as const, summary, payload: { key, value } } : null;
    }
    if (raw.action === "skill_new") {
      const name = text(raw.name, 64), description = text(raw.description, 300), body = text(raw.body, 6000);
      if (!SKILL_NAME.test(name) || !description || !body || skills.some(skill => skill.name === name)) return null;
      return { kind: "skill_new" as const, summary, payload: { name, description, body } };
    }
    if (raw.action === "skill_patch") {
      // A patch aimed at a memory key is a memory refinement in the wrong shape.
      const memoryKey = text(raw.skill, 64);
      if (!skills.some(item => item.name === memoryKey) && this.store.listMemories().some(memory => memory.key === memoryKey) && typeof raw.new === "string" && raw.new.trim()) {
        return { kind: "memory" as const, summary, payload: { key: memoryKey, value: raw.new.trim().slice(0, 600) } };
      }
      const skill = skills.find(item => item.name === text(raw.skill, 64));
      const old = typeof raw.old === "string" ? raw.old : "", replacement = typeof raw.new === "string" ? raw.new : "";
      if (!skill?.editable || !old || old === replacement || skill.content.split(old).length - 1 !== 1) return null;
      return { kind: "skill_patch" as const, summary, payload: { skill: skill.name, old, new: replacement, revision: skill.revision } };
    }
    return null;
  }

  /**
   * Applies an accepted proposal. `as: "memory"` keeps a skill proposal as a
   * one-line preference instead. Throws with a sentence the client can show.
   */
  accept(id: string, as?: "memory") {
    const proposal = this.get(id);
    if (!proposal) throw Object.assign(new Error("Proposal not found"), { status: 404 });
    if (proposal.status !== "pending") throw Object.assign(new Error("This proposal was already handled"), { status: 409 });
    const payload = proposal.payload;
    let result: string;
    if (proposal.kind === "memory" || as === "memory") {
      const memory = this.config.capabilities().memory;
      if (!memory.enabled) throw Object.assign(new Error("记忆已关闭，无法保存"), { status: 409 });
      const key = proposal.kind === "memory" ? payload.key! : (payload.name ?? payload.skill ?? "preference").replaceAll("-", "_").slice(0, 64);
      const value = proposal.kind === "memory" ? payload.value! : proposal.summary;
      if (!this.store.saveMemoryWithinBudget(key, value, countTokens(value), memory.tokenLimit, proposal.conversationId)) {
        throw Object.assign(new Error("记忆空间已满，请先整理记忆"), { status: 409 });
      }
      result = `memory:${key}`;
    } else if (proposal.kind === "skill_new") {
      const content = composeSkill({ name: payload.name!, description: payload.description!, body: payload.body!, learned: true });
      createSkill(content);
      record(proposal.conversationId, "skill", "new", null, content, `Accepted learning proposal: ${proposal.summary}`);
      result = `skill:${payload.name}`;
    } else {
      const skill = managedSkills(this.config.capabilities().coding.workspace).items.find(item => item.name === payload.skill);
      if (!skill || skill.revision !== payload.revision) throw Object.assign(new Error("这个技能在提议之后被修改过，请忽略后让助手重新整理"), { status: 409 });
      const content = skill.content.replace(payload.old!, () => payload.new!);
      updateSkill(skill, { content, revision: skill.revision });
      record(proposal.conversationId, "skill", skill.filePath, skill.content, content, `Accepted learning proposal: ${proposal.summary}`);
      result = `skill:${skill.name}`;
    }
    this.store.db.run("UPDATE learning_proposals SET status = 'accepted', result = ?, resolved_at = ? WHERE id = ?", result, Date.now(), id);
    return this.get(id)!;
  }

  dismiss(id: string) {
    const proposal = this.get(id);
    if (!proposal) throw Object.assign(new Error("Proposal not found"), { status: 404 });
    if (proposal.status === "pending") this.store.db.run("UPDATE learning_proposals SET status = 'dismissed', resolved_at = ? WHERE id = ?", Date.now(), id);
    return this.get(id)!;
  }
}
