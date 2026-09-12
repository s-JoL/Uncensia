import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startOpenAiStub } from "./stub-openai.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uncensia-learning-"));
process.env.UNCENSIA_DATA_DIR = dir;
process.env.UNCENSIA_ACCESS_CODE = "LEARNINGAUDITCODE";
const { createServices } = await import("../src/server/services.ts");
const { createApp } = await import("../src/server/http/app.ts");
const { learningTools, learningHistory } = await import("../src/server/tools/learning.ts");
const { managedSkills } = await import("../src/server/tools/skill-management.ts");
const services = createServices();
const stub = await startOpenAiStub(0, body => {
  const last = body.messages?.findLastIndex(m => m.role === "user") ?? 0;
  if (!body.messages?.slice(last + 1).some(m => m.role === "tool")) return { kind: "tool", name: "save_knowledge", args: { title: "Runtime research", content: "Runtime durable evidence: amber telescope.", sources: ["https://example.org/evidence"] } };
  return { kind: "text", text: "Research saved." };
});
try {
  services.store.upsertProvider({ id: "fixture", name: "fixture", baseUrl: stub.url + "/v1", auth: { style: "none" }, enabled: true });
  services.store.upsertModel({ id: "fixture", providerId: "fixture", model: "fixture", name: "fixture", apiMode: "openai-chat", kind: "chat", enabled: true, reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000, thinkingLevel: "off" });
  const conv = services.store.createConversation("fixture", "Learning audit");
  const tools = () => learningTools(services.config, services.store, conv.id, file => services.retrieval.indexFile(file));
  const call = async (name: string, args: object) => {
    const tool = tools().find(t => t.name === name); assert.ok(tool, name);
    const value = await tool.execute("fixture", args);
    return JSON.parse((value.content[0] as { text: string }).text);
  };
  // Legacy installations inherit their old write permission once; saving any
  // capability materializes the independent values for subsequent updates.
  services.store.setSetting("capabilities", { coding: { read: true, write: false, shell: false, workspace: dir } });
  assert.deepEqual(services.config.capabilities().learning, { skills: false, prompts: false });
  services.config.saveCapabilities({ coding: { ...services.config.capabilities().coding, write: true } });
  assert.ok(!tools().some(t => t.name === "manage_prompt"));
  assert.ok(!tools().some(t => t.name === "manage_skill"));
  services.store.setSetting("capabilities", { coding: { read: true, write: true, shell: false, workspace: dir } });
  assert.deepEqual(services.config.capabilities().learning, { skills: true, prompts: true });
  services.config.saveCapabilities({ coding: { ...services.config.capabilities().coding, write: false } });
  assert.ok(tools().some(t => t.name === "manage_skill"), "workspace writes do not control skills");
  services.config.saveCapabilities({ learning: { skills: true, prompts: false } });
  assert.ok(tools().some(t => t.name === "manage_skill"));
  assert.ok(!tools().some(t => t.name === "manage_prompt"));
  const staleSkill = tools().find(t => t.name === "manage_skill")!;
  services.config.saveCapabilities({ learning: { skills: false, prompts: true } });
  assert.ok(!tools().some(t => t.name === "manage_skill"));
  assert.ok(tools().some(t => t.name === "manage_prompt"));
  await assert.rejects(() => staleSkill.execute("revoked-skill", { action: "list" }), /disabled/);
  assert.equal(services.config.capabilities().coding.write, false);
  services.config.saveCapabilities({ learning: { skills: true, prompts: true } });
  services.config.saveCapabilities({ coding: { ...services.config.capabilities().coding, read: true, write: true, workspace: dir } });
  const original = await call("manage_prompt", { action: "read", target: "toolPrompt" });
  await call("manage_prompt", { action: "update", target: "toolPrompt", content: original.content + "\nFixture procedure.", revision: original.revision, reason: "Fixture observed a missing step" });
  await assert.rejects(() => call("manage_prompt", { action: "update", target: "toolPrompt", content: "stale", revision: original.revision, reason: "stale" }), /changed/);
  const current = await call("manage_prompt", { action: "read", target: "toolPrompt" });
  await call("manage_prompt", { action: "update", target: "toolPrompt", content: learningHistory()[0]!.before, revision: current.revision, reason: "Restore fixture baseline" });
  assert.equal(services.config.prompts().toolPrompt, original.content);
  const content = "---\nname: audit-learning\ndescription: Use for fixture verification.\n---\n\nVerify amber telescope.\n";
  await call("manage_skill", { action: "create", content, reason: "A repeated verified procedure" });
  let skill = managedSkills(dir).items.find(s => s.name === "audit-learning")!; assert.ok(skill);
  await call("manage_skill", { action: "update", id: skill.id, revision: skill.revision, content: content + "Check sources.\n", reason: "Source check was missing" });
  await assert.rejects(() => call("manage_skill", { action: "update", id: skill.id, revision: skill.revision, content, reason: "stale" }), /changed/);
  assert.ok(managedSkills(dir).items.find(s => s.name === "audit-learning")!.content.includes("Check sources"));
  const knowledge = { title: "Evidence", content: "The amber telescope is a fixture, not a real fact.", sources: ["https://example.org/evidence"] };
  const saved = await call("save_knowledge", knowledge);
  assert.equal(saved.indexing, "indexed", "keyword indexing does not claim ready vector embeddings");
  assert.equal((await call("save_knowledge", knowledge)).file_id, saved.file_id);
  const found = await services.retrieval.searchFiles("amber telescope", "keyword", 10, [saved.file_id]);
  assert.ok(found.results.length > 0);
  const failedIndexer = learningTools(services.config, services.store, conv.id, async file => {
    services.store.setFileEmbeddingStatus(file.id, "failed", "No extractable text");
  }).find(tool => tool.name === "save_knowledge")!;
  const failed = await failedIndexer.execute("failed-index", { ...knowledge, title: "Failed index" });
  assert.match(JSON.parse((failed.content[0] as { text: string }).text).indexing, /^failed: No extractable text$/);
  const revokedIndexer = tools().find(tool => tool.name === "save_knowledge")!;
  services.config.saveCapabilities({ files: { ...services.config.capabilities().files, searchEnabled: false } });
  const unindexed = await revokedIndexer.execute("revoked-index", { ...knowledge, title: "Search disabled" });
  assert.equal(JSON.parse((unindexed.content[0] as { text: string }).text).indexing, "disabled");
  services.config.saveCapabilities({ files: { ...services.config.capabilities().files, searchEnabled: true } });
  const oldTool = tools().find(t => t.name === "manage_prompt")!;
  services.config.saveCapabilities({ learning: { skills: true, prompts: false } });
  await assert.rejects(() => oldTool.execute("late", { action: "read", target: "globalPrompt" }), /disabled/);
  services.reload();
  const run = services.store.createRun(conv.id, "fixture");
  await services.runtime.start(run.id, conv.id, { message: "Save the research using save_knowledge.", modelId: "fixture" });
  assert.equal(services.store.getRun(run.id)!.status, "completed");
  const offered = JSON.parse(services.db.get<{ data: string }>("SELECT data FROM events WHERE run_id=? AND type='context.captured'", run.id)!.data).tools as string[];
  assert.ok(!offered.includes("manage_prompt"), "Runtime must omit disabled prompt management");
  assert.ok(offered.includes("manage_skill"), "Runtime retains independently enabled skill management");
  assert.ok(offered.includes("write"), "Runtime retains independently enabled workspace writing");
  assert.ok(services.db.get("SELECT id FROM files WHERE name = ?", "Runtime research.md"));
  const app = createApp(services);
  assert.equal((await app.request("/v1/learning/history")).status, 401);
  console.log("PASS learning: revision conflict, prompt restore, skill discovery, indexed knowledge and deduplication, revoked permissions, real Runtime tool path, authenticated history");
} finally {
  await services.close(); await stub.close();
  assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith("uncensia-learning-"));
  fs.rmSync(dir, { recursive: true, force: true });
}
