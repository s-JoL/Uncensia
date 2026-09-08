/** Real SDK replay against a local provider; no deployment history or API calls. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { omitForeignThinking } from "../src/server/agent/messages.ts";
import { startOpenAiStub } from "./stub-openai.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "uncensia-history-replay-"));
process.env.UNCENSIA_DATA_DIR = sandbox;
process.env.UNCENSIA_ACCESS_CODE = "HISTORYREPLAYFIXTURE";
const { createServices } = await import("../src/server/services.ts");
const { createPiLoop } = await import("../src/server/agent/loop.ts");
const services = createServices();
const stub = await startOpenAiStub(0, () => ({ kind: "text", text: "Fixture response to the latest request." }));
const assistant = (content: AssistantMessage["content"], model = "old"): AssistantMessage => ({
  role: "assistant", content, model, provider: "fixture::openai-chat", api: "openai-chat" as never,
  stopReason: "stop", timestamp: Date.now(),
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
try {
  services.store.upsertProvider({ id: "fixture", name: "fixture", baseUrl: stub.url + "/v1", auth: { style: "none" }, enabled: true });
  for (const id of ["old", "new"]) services.store.upsertModel({ id, providerId: "fixture", model: id, name: id, apiMode: "openai-chat", kind: "chat", enabled: true, pinned: false, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2000, thinkingLevel: "off" });
  services.reload();
  const old = services.registry.resolve("old").model;
  const next = services.registry.resolve("new").model;
  const thought = { type: "thinking" as const, thinking: "OLD_DELIBERATION: continue reviewing the camera", thinkingSignature: "reasoning_content" };
  const call = { type: "toolCall" as const, id: "search-call|item", name: "web_search", arguments: { query: "Luna Ultra 花屏" }, thoughtSignature: "FOREIGN_TOOL_SIGNATURE" };
  const original = [assistant([thought, { type: "text", text: "Camera answer" }, call])];
  const snapshot = JSON.stringify(original);
  assert.deepEqual(omitForeignThinking(original, old), original, "same-model reasoning and signatures must survive");
  for (const target of [next, { ...old, provider: "other" }, { ...old, api: "anthropic-messages" as never }]) {
    const output = omitForeignThinking(original, target);
    assert.doesNotMatch(JSON.stringify(output), /OLD_DELIBERATION/);
    assert.match(JSON.stringify(output), /Camera answer/);
    assert.match(JSON.stringify(output), /search-call/);
  }
  assert.equal(JSON.stringify(original), snapshot, "history must remain immutable");
  assert.deepEqual(omitForeignThinking([assistant([thought])], next), [], "omit thinking-only foreign messages");
  const redacted = assistant([{ ...thought, thinking: "", redacted: true }]);
  assert.deepEqual(omitForeignThinking([redacted], old), [redacted]);
  assert.deepEqual(omitForeignThinking([redacted], next), []);
  const explicit = { role: "user" as const, content: "OLD_DELIBERATION is text I explicitly wrote", timestamp: Date.now() };
  assert.deepEqual(omitForeignThinking([explicit, assistant([{ type: "text", text: "OLD_DELIBERATION is quoted prose" }])], next).length, 2);
  assert.deepEqual(omitForeignThinking(omitForeignThinking(original, next), next), omitForeignThinking(original, next));
  console.log("PASS model/provider/API identity, signed/redacted/thinking-only blocks, explicit prose and immutable repeat conversion");

  const manager = await services.sessions.session("replay");
  manager.appendMessage({ role: "user", content: "帮我查一下luna ultra的评价 花屏之类的问题", timestamp: Date.now() });
  manager.appendMessage({ ...original[0]!, stopReason: "toolUse" });
  manager.appendMessage({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "SEARCH_RESULT: detachable screen contacts" }], isError: false, timestamp: Date.now() });
  const answer = manager.appendMessage(assistant([{ type: "text", text: "相机评价。需要继续了解整体评价吗？" }]));
  // A failed/abandoned retry must not enter the active branch.
  manager.appendMessage({ role: "user", content: "ABANDONED_REQUEST", timestamp: Date.now() });
  manager.appendMessage({ ...assistant([thought]), stopReason: "error", errorMessage: "fixture 400" });
  await services.sessions.rewind("replay", answer);
  const before = JSON.stringify(manager.getEntries());

  async function open(modelId: string) {
    return createPiLoop({ manager, workspace: sandbox, providers: services.registry.runtime.getProviders(), model: services.registry.resolve(modelId).model,
      systemPrompt: "A general assistant. Follow the latest user request.", thinkingLevel: "off", tools: [],
      persist: message => message, onExtensionEvent: () => undefined,
      transformContext: async messages => messages, onPayload: payload => payload, beforeToolCall: async () => undefined });
  }
  const request = "生成一个luna ultra花屏的图片";
  const loop = await open("new");
  try { await loop.initialize?.(); await loop.prompt(request, []); } finally { await loop.dispose?.(); }
  const wire = stub.requests.at(-1)!;
  assert.doesNotMatch(JSON.stringify(wire), /OLD_DELIBERATION|FOREIGN_TOOL_SIGNATURE|ABANDONED_REQUEST/);
  assert.match(JSON.stringify(wire.messages?.at(-1)), /生成一个luna ultra花屏的图片/);
  const toolCall = wire.messages?.flatMap(m => m.tool_calls ?? [])[0];
  const result = wire.messages?.find(m => m.role === "tool");
  assert.ok(toolCall && result);
  assert.equal(result.tool_call_id, toolCall.id, "SDK must still normalize tool IDs together");
  assert.match(JSON.stringify(result), /SEARCH_RESULT/);
  assert.equal(JSON.stringify(manager.getEntries().slice(0, JSON.parse(before).length)), before);
  console.log("PASS actual SDK HTTP serialization of search → switch model → image request, including rewound error branch and tool pair");

  await services.sessions.rewind("replay", answer);
  const same = await open("old");
  try { await same.initialize?.(); await same.prompt("Retry with the original model", []); } finally { await same.dispose?.(); }
  assert.match(JSON.stringify(stub.requests.at(-1)), /reasoning_content.*OLD_DELIBERATION/);
  console.log("PASS switching back retains original reasoning signatures for same-model replay");

  manager.appendMessage({ role: "user", content: "EARLY_FACT " + "Context detail. ".repeat(9000), timestamp: Date.now() });
  manager.appendMessage(assistant([thought, { type: "text", text: "EARLY_ANSWER" }]));
  manager.appendMessage({ role: "user", content: "RECENT_FACT " + "Recent detail. ".repeat(9000), timestamp: Date.now() });
  manager.appendMessage(assistant([thought, { type: "text", text: "RECENT_ANSWER" }]));
  const compact = await open("new");
  const offset = stub.requests.length;
  try { await compact.initialize?.(); await compact.sdk!.compact(); } finally { await compact.dispose?.(); }
  assert.ok(stub.requests.length > offset, "compaction must reach the local provider");
  assert.doesNotMatch(JSON.stringify(stub.requests.slice(offset)), /OLD_DELIBERATION|ABANDONED_REQUEST/);
  assert.match(JSON.stringify(stub.requests.slice(offset)), /EARLY_FACT/);
  assert.ok(manager.getEntries().some(e => e.type === "compaction"));
  assert.match(JSON.stringify(manager.getEntries()), /OLD_DELIBERATION/, "compaction must not rewrite the original history");
  console.log("PASS native compaction drops foreign deliberation while retaining facts and original history");
} finally {
  await services.close();
  await stub.close();
  assert.equal(path.dirname(sandbox), os.tmpdir());
  assert.ok(path.basename(sandbox).startsWith("uncensia-history-replay-"));
  fs.rmSync(sandbox, { recursive: true, force: true });
}
