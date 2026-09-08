import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startOpenAiStub } from "./stub-openai.ts";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uncensia-context-"));
process.env.UNCENSIA_DATA_DIR = dir;
process.env.UNCENSIA_ACCESS_CODE = "CONTEXTAUDITCODE";
const { createServices } = await import("../src/server/services.ts");
const { buildModelContext } = await import("../src/server/prompts/context.ts");
const { memoryTools } = await import("../src/server/tools/memory.ts");
const { withRuntimeContext } = await import("../src/server/agent/messages.ts");
const services = createServices();
services.config.savePrompts({ titleEnabled: false });
let round = 0;
const snapshots: string[] = [];
const stub = await startOpenAiStub(0, body => {
  const current = JSON.stringify(body.messages?.findLast(m => m.role === "user")?.content);
  snapshots.push(current);
  switch (++round) {
    case 1:
      assert.ok(current.includes("OLD_CONTEXT_MARKER"));
      return { kind: "tool", name: "set_memory", args: { intent: "User requested update", key: "preference", value: "NEW_CONTEXT_MARKER" } };
    case 2:
      assert.ok(current.includes("NEW_CONTEXT_MARKER") && !current.includes("OLD_CONTEXT_MARKER"));
      services.store.saveMemoryWithinBudget("preference", "EXTERNAL_CONTEXT_MARKER", 10, 16000);
      return { kind: "tool", name: "inspect_generations", args: { intent: "Check saved work" } };
    case 3:
      assert.ok(current.includes("EXTERNAL_CONTEXT_MARKER") && !current.includes("NEW_CONTEXT_MARKER"));
      return { kind: "tool", name: "delete_memory", args: { intent: "User requested forgetting", key: "preference" } };
    default:
      assert.ok(!current.includes("EXTERNAL_CONTEXT_MARKER"));
      assert.ok(current.includes("No saved memories"));
      return { kind: "text", text: "Memory refreshed." };
  }
});
try {
  services.store.upsertProvider({ id: "fixture", name: "fixture", baseUrl: stub.url + "/v1", auth: { style: "none" }, enabled: true });
  services.store.upsertModel({ id: "fixture", providerId: "fixture", model: "fixture", name: "fixture", apiMode: "openai-chat", kind: "chat", enabled: true, reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000, thinkingLevel: "off" });
  services.store.saveMemoryWithinBudget("preference", "OLD_CONTEXT_MARKER", 10, 16000);
  services.reload();
  const conv = services.store.createConversation("fixture", "Context freshness");
  const run = services.store.createRun(conv.id, "fixture");
  await services.runtime.start(run.id, conv.id, { message: "Update, then forget the saved preference as this fixture requests.", modelId: "fixture" });
  assert.equal(services.store.getRun(run.id)!.status, "completed");
  assert.equal(round, 4);
  const systems = stub.requests.map(r => JSON.stringify(r.messages?.filter(m => m.role === "system")));
  assert.ok(systems.every(s => s === systems[0] && !s.includes("CONTEXT_MARKER")));
  assert.ok(stub.requests.every(r => JSON.stringify(r.tools) === JSON.stringify(stub.requests[0]!.tools)));
  const raw = fs.readFileSync(path.join(dir, "sessions-sdk", `${conv.id}.jsonl`), "utf8");
  assert.ok(!raw.includes("uncensia-current-context"), "ephemeral context must not be persisted or compacted as user facts");
  const caps = services.config.capabilities();
  const before = JSON.stringify(memoryTools(services.store, caps.memory).map(t => t.parameters));
  services.store.saveMemoryWithinBudget("new_key", "a new fact", 10, 16000);
  assert.equal(JSON.stringify(memoryTools(services.store, caps.memory).map(t => t.parameters)), before);
  const input = { staticPrompt: "Stable identity", memories: [], searchableFiles: [], memoryEnabled: true, memoryTokenLimit: 16000, filesEnabled: true, webEnabled: true };
  const omitted = buildModelContext({ ...input, memoryTokenLimit: 0, memories: [{ key: "oversized", value: "Saved but outside the current budget", updatedAt: 60000 }] }).runtimeContext;
  assert.match(omitted, /Omitted for space: oversized/);
  assert.ok(!omitted.includes("No saved memories"), "budget omission must not claim saved memory is empty");
  assert.equal(buildModelContext({...input, now: 0}).systemPrompt, buildModelContext({...input, now: 60000, memories:[{key:"new",value:"changed",updatedAt:60000}]}).systemPrompt);
  const history = Array.from({length: 60}, (_, i) => ({role: "user" as const, content: `turn-${i}: ` + "long history ".repeat(500), timestamp:i}));
  const copy = JSON.stringify(history);
  const transformed = withRuntimeContext(history, "live state");
  assert.equal(transformed.length, history.length); assert.equal(transformed[0], history[0]); assert.equal(JSON.stringify(history), copy);
  const tool = memoryTools(services.store, caps.memory, conv.id, () => services.config.capabilities().memory)[0]!;
  services.config.saveCapabilities({memory:{...caps.memory,writeEnabled:false}});
  await assert.rejects(() => tool.execute("revoked", {intent:"old call",key:"new_key",value:"bad"}), /disabled/);
  console.log("PASS actual provider payloads: same-run memory update/delete and external edits; stable system and tools; no persisted snapshots; history preserved; revoked writes rejected");
} finally {
  await services.close(); await stub.close();
  assert.equal(path.dirname(dir),os.tmpdir()); assert.ok(path.basename(dir).startsWith("uncensia-context-")); fs.rmSync(dir,{recursive:true,force:true});
}
