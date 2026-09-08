import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager, type SessionHeader } from "@earendil-works/pi-coding-agent";
import { paths } from "../env.ts";

export type ConversationSession = SessionManager;

/** Pi owns the conversation tree, compaction and JSONL persistence. */
export class Sessions {
  private readonly opened = new Map<string, SessionManager>();

  constructor(readonly directory = paths.sessions, private readonly cwd = paths.data) {
    fs.mkdirSync(this.directory, { recursive: true });
  }

  private file(id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid conversation id");
    return path.join(this.directory, `${id}.jsonl`);
  }

  async session(id: string): Promise<SessionManager> {
    const cached = this.opened.get(id);
    if (cached) return cached;
    const file = this.file(id);
    if (!fs.existsSync(file)) this.createFile(id, file);
    const session = SessionManager.open(file, this.directory, this.cwd);
    this.opened.set(id, session);
    return session;
  }

  private createFile(id: string, file: string) {
    const header: SessionHeader = { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: this.cwd };
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(header) + "\n", { flag: "wx", flush: true });
    fs.renameSync(temporary, file);
  }

  async entries(id: string) { return (await this.session(id)).getBranch(); }
  async context(id: string) { return (await this.session(id)).buildSessionContext(); }

  async rewind(id: string, entryId: string | null) {
    const session = await this.session(id);
    if (entryId) {
      if (!session.getEntry(entryId)) throw new Error("Unknown session entry");
      session.branch(entryId);
    } else session.resetLeaf();
    session.appendCustomEntry("uncensia.navigation", { targetId: entryId });
  }

  async fork(sourceId: string, targetId: string, entryId?: string) {
    const source = await this.session(sourceId);
    const target = this.file(targetId);
    if (fs.existsSync(target)) throw new Error("Target session already exists");
    if (entryId && !source.getEntry(entryId)) throw new Error("Unknown branch entry");
    const branch = source.getBranch(entryId);
    const header = { ...source.getHeader(), type: "session", version: 3, id: targetId, timestamp: new Date().toISOString(), cwd: this.cwd, parentSession: source.getSessionFile() };
    fs.writeFileSync(target, [header, ...branch].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx", flush: true });
    return this.session(targetId);
  }

  async stats(id: string) {
    const entries = (await this.session(id)).getEntries();
    let totalTokens = 0, costTotal = 0;
    for (const entry of entries) {
      const usage = entry.type === "message" && entry.message.role === "assistant" ? entry.message.usage : entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage : undefined;
      totalTokens += usage?.totalTokens ?? 0;
      costTotal += usage?.cost?.total ?? 0;
    }
    return { totalTokens, costTotal };
  }

  async forget(id: string) {
    this.opened.delete(id);
    const file = this.file(id);
    fs.rmSync(file, { force: true });
  }
  async close() { this.opened.clear(); }
}
