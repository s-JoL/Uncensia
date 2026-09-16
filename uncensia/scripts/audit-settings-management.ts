import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startOpenAiStub } from "./stub-openai.ts";
import { createReadTool } from "@earendil-works/pi-coding-agent";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uncensia-settings-"));
process.env.UNCENSIA_DATA_DIR = dir;
process.env.UNCENSIA_ACCESS_CODE = "SETTINGSAUDITCODE";
const { createServices } = await import("../src/server/services.ts");
const { createApp } = await import("../src/server/http/app.ts");
const { createPiLoop } = await import("../src/server/agent/loop.ts");
const { classifyModel } = await import("../src/server/models/catalogue.ts");
const services = createServices();
const app = createApp(services);
const stub = await startOpenAiStub(0, () => ({ kind: "text", text: "fixture" }));
let auth = "";
async function call(method: string, route: string, body?: unknown) {
  return app.request(`/v1${route}`, { method, headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
try {
  assert.equal((await call("GET", "/skills")).status, 401);
  auth = ((await (await call("POST", "/auth/token", { accessCode: "SETTINGSAUDITCODE", deviceName: "settings-audit" })).json()) as { token: string }).token;
  const source = "---\nname: fixture-managed\ndescription: UNIQUE_MANAGED_SKILL_DESCRIPTION\n---\n\nOriginal skill body.\n";
  assert.equal((await call("POST", "/skills", { content: source })).status, 201);
  assert.equal((await call("POST", "/skills", { content: source })).status, 400);
  assert.equal((await call("POST", "/skills", { content: source.replace("fixture-managed", "../../escape") })).status, 400);
  // The editor and SDK discovery must agree on BOM and newline handling.
  for (const [name, newline] of [["fixture-crlf", "\r\n"], ["fixture-cr", "\r"]]) {
    const content = "\uFEFF" + source.replace("fixture-managed", name!).replace("UNIQUE_MANAGED_SKILL_DESCRIPTION", name!).replaceAll("\n", newline!);
    assert.equal((await call("POST", "/skills", { content })).status, 201);
    const discovered = await (await call("GET", "/skills")).json() as { items: Array<{ name: string }> };
    assert.ok(discovered.items.some(item => item.name === name));
  }
  const listing = async () => await (await call("GET", "/skills")).json() as { items: Array<{ id: string; name: string; content: string; revision: string; enabled: boolean; editable: boolean }> };
  const item = (await listing()).items.find(item => item.name === "fixture-managed")!;
  assert.ok(item.editable && item.enabled);
  assert.equal((await call("PATCH", `/skills/${item.id}`, { content: source + "Edited", revision: item.revision })).status, 200);
  assert.equal((await call("PATCH", `/skills/${item.id}`, { content: source, revision: item.revision })).status, 409);
  assert.equal((await call("PATCH", `/skills/${item.id}`, { enabled: "false" })).status, 400);
  assert.match((await listing()).items.find(row => row.id === item.id)!.content, /Edited/);
  console.log("PASS skills authentication, create/edit, duplicate/path validation and stale edit conflict");

  services.store.upsertProvider({ id: "fixture", name: "fixture", baseUrl: stub.url + "/v1", auth: { style: "none" }, enabled: true });
  services.store.upsertModel({ id: "fixture", providerId: "fixture", model: "fixture", name: "fixture", apiMode: "openai-chat", kind: "chat", enabled: true, reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000, thinkingLevel: "off" });
  services.reload();
  assert.equal((await call("POST", "/models/bulk", { providerId: "fixture", models: [
    { model: "valid-first", apiMode: "openai-chat", contextWindow: 32000 },
    { model: "invalid-second", apiMode: "openai-chat", contextWindow: -1 },
  ] })).status, 400);
  assert.equal(services.store.getModel("fixture-valid-first"), undefined);
  for (const contextWindow of [0, -1, 1.5, null, "1000000"]) {
    assert.equal((await call("PATCH", "/models/fixture", { contextWindow })).status, 400);
    assert.equal(services.store.getModel("fixture")!.contextWindow, 32000);
  }
  async function run() {
    const loop = await createPiLoop({ manager: await services.sessions.session(`fixture-${stub.requests.length}`), workspace: dir,
      providers: services.registry.runtime.getProviders(), model: services.registry.resolve("fixture").model,
      systemPrompt: "General assistant", thinkingLevel: "off", tools: [createReadTool(dir)], persist: message => message,
      onExtensionEvent: () => undefined, transformContext: async messages => messages, onPayload: payload => payload, beforeToolCall: async () => undefined });
    try { await loop.initialize?.(); await loop.prompt("Hello", []); } finally { await loop.dispose?.(); }
    return JSON.stringify(stub.requests.at(-1));
  }
  assert.match(await run(), /UNIQUE_MANAGED_SKILL_DESCRIPTION/);
  assert.equal((await call("PATCH", `/skills/${item.id}`, { enabled: false })).status, 200);
  assert.doesNotMatch(await run(), /UNIQUE_MANAGED_SKILL_DESCRIPTION/);
  assert.ok(fs.existsSync(path.join(dir, "skills", "fixture-managed", "SKILL.md")));
  assert.equal((await call("PATCH", `/skills/${item.id}`, { enabled: true })).status, 200);
  assert.match(await run(), /UNIQUE_MANAGED_SKILL_DESCRIPTION/);
  console.log("PASS toggle changes real SDK outgoing skill catalogue without deleting instructions");

  // Local extensions: created from the settings screen, switched off without deleting, and removed to a trash folder.
  const extensionSource = "export default function (pi) {\n  pi.registerTool({ name: \"unique_fixture_tool\", label: \"fixture\", description: \"UNIQUE_EXTENSION_TOOL\", parameters: { type: \"object\", properties: {} }, async execute() { return { content: [{ type: \"text\", text: \"ok\" }] }; } });\n}\n";
  assert.equal((await call("POST", "/extensions", { name: "Bad Name", content: extensionSource })).status, 400);
  assert.equal((await call("POST", "/extensions", { name: "fixture-ext", content: "const x = 1;" })).status, 400);
  assert.equal((await call("POST", "/extensions", { name: "fixture-ext", content: extensionSource })).status, 201);
  assert.equal((await call("POST", "/extensions", { name: "fixture-ext", content: extensionSource })).status, 400);
  type Resources = { extensions: Array<{ id: string; name: string; enabled: boolean; editable: boolean; source: string; revision: string }>; packages: Array<{ source: string; enabled: boolean; installedPath: string | null; resources: { extensions: number; skills: number; prompts: number } }>; status: { loaded: string[]; errors: unknown[] } | null };
  const resources = async () => await (await call("GET", "/extensions")).json() as Resources;
  const ext = (await resources()).extensions.find(row => row.name === "fixture-ext")!;
  assert.ok(ext.editable && ext.enabled && ext.source === "local");
  assert.match(await run(), /UNIQUE_EXTENSION_TOOL/);
  assert.ok((await resources()).status!.loaded.some(file => file.endsWith("fixture-ext.ts")));
  assert.equal((await call("PATCH", `/extensions/${ext.id}`, { enabled: false })).status, 200);
  assert.doesNotMatch(await run(), /UNIQUE_EXTENSION_TOOL/);
  assert.equal((await resources()).extensions.find(row => row.id === ext.id)!.enabled, false);
  assert.equal((await call("PATCH", `/extensions/${ext.id}`, { content: extensionSource + "// edited\n", revision: "stale" })).status, 409);
  assert.equal((await call("PATCH", `/extensions/${ext.id}`, { content: extensionSource + "// edited\n", revision: ext.revision })).status, 200);
  assert.equal((await call("PATCH", `/extensions/${ext.id}`, { enabled: true })).status, 200);
  assert.match(await run(), /UNIQUE_EXTENSION_TOOL/);
  assert.equal((await call("DELETE", `/extensions/${ext.id}`)).status, 200);
  assert.equal((await call("DELETE", `/extensions/${ext.id}`)).status, 404);
  assert.ok(fs.readdirSync(path.join(dir, "agent", "extensions-trash")).some(file => file.endsWith("fixture-ext.ts")));
  assert.doesNotMatch(await run(), /UNIQUE_EXTENSION_TOOL/);
  console.log("PASS local extensions: validation, real SDK tool registration follows enable/disable, stale edits conflict, delete moves to trash");

  // Packages: a local folder is installed through Pi's own package manager; disabling removes its resources from the next run.
  const packageDir = path.join(dir, "fixture-package");
  fs.mkdirSync(path.join(packageDir, "skills", "packaged"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "extensions"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "skills", "packaged", "SKILL.md"), "---\nname: packaged\ndescription: UNIQUE_PACKAGED_SKILL\n---\n\nPackaged body.\n");
  fs.writeFileSync(path.join(packageDir, "extensions", "packaged.ts"), extensionSource.replace("UNIQUE_EXTENSION_TOOL", "UNIQUE_PACKAGED_TOOL"));
  for (const route of ["/extensions/packages", "/extensions/packages/update"]) assert.equal((await call("POST", route, { source: 42 })).status, 400);
  assert.equal((await call("PATCH", "/extensions/packages", { source: "npm:never-added", enabled: false })).status, 404);
  assert.equal((await call("DELETE", "/extensions/packages", { source: "npm:never-added" })).status, 404);
  assert.equal((await call("POST", "/extensions/packages", { source: path.join(dir, "missing-package") })).status, 400);
  assert.equal((await call("POST", "/extensions/packages", { source: packageDir })).status, 201);
  assert.equal((await call("POST", "/extensions/packages", { source: packageDir })).status, 400);
  const installed = (await resources()).packages.find(row => row.source === packageDir)!;
  assert.ok(installed.enabled);
  assert.deepEqual(installed.resources, { extensions: 1, skills: 1, prompts: 0 });
  const packaged = (await resources()).extensions.find(row => row.name === "packaged")!;
  assert.ok(!packaged.editable && packaged.enabled && packaged.source === packageDir);
  assert.equal((await call("PATCH", `/extensions/${packaged.id}`, { content: "export default function () {}", revision: packaged.revision })).status, 400);
  assert.equal((await call("DELETE", `/extensions/${packaged.id}`)).status, 400);
  let outgoing = await run();
  assert.match(outgoing, /UNIQUE_PACKAGED_SKILL/); assert.match(outgoing, /UNIQUE_PACKAGED_TOOL/);
  assert.equal((await call("PATCH", `/extensions/${packaged.id}`, { enabled: false })).status, 200);
  outgoing = await run();
  assert.match(outgoing, /UNIQUE_PACKAGED_SKILL/); assert.doesNotMatch(outgoing, /UNIQUE_PACKAGED_TOOL/);
  assert.equal((await call("PATCH", "/extensions/packages", { source: packageDir, enabled: false })).status, 200);
  assert.equal((await resources()).extensions.find(row => row.id === packaged.id)!.enabled, false);
  outgoing = await run();
  assert.doesNotMatch(outgoing, /UNIQUE_PACKAGED_SKILL/); assert.doesNotMatch(outgoing, /UNIQUE_PACKAGED_TOOL/);
  assert.equal((await call("DELETE", "/extensions/packages", { source: packageDir })).status, 200);
  assert.equal((await resources()).packages.length, 0);
  assert.ok(fs.existsSync(path.join(packageDir, "skills", "packaged", "SKILL.md")));
  console.log("PASS packages: shape and existence validation, local install through Pi, per-file and whole-package disable reach the real SDK catalogue, removal keeps local files");

  for (const model of ["deepseek-v4-flash-0731", "deepseek-v4-flash-vision", "gemini-3.7-flash", "glm-5.3-flash", "glm-5.3", "kimi-k3"]) {
    const suggestion = classifyModel(model, "fixture");
    assert.ok(suggestion.contextWindow >= 1_000_000, model);
    assert.equal(suggestion.windowSource, "catalogue");
  }
  assert.equal(classifyModel("grok-4.6", "fixture").contextWindow, 500000);
  assert.equal(classifyModel("glm-5.3-flash", "fixture").input.includes("image"), true);
  assert.equal(classifyModel("gemini-unreleased-test", "fixture").windowSource, "guessed");
  assert.equal(((await (await call("GET", "/model-reference?model=unknown-test")).json()) as { reference: unknown }).reference, null);
  console.log("PASS exact model references, dated aliases, vision and unknown-version provenance");

  const first = services.store.createConversation("fixture", "First");
  const second = services.store.createConversation("fixture", "Second");
  for (const conversation of [first, second]) services.store.createBackgroundTask({ conversationId: conversation.id, modelId: "fixture", prompt: "future", runAt: Date.now() + 3600000 });
  const tasks = await (await call("GET", "/background-tasks")).json() as { items: Array<{ id: string }> };
  assert.equal(tasks.items.length, 2);
  assert.equal((await call("DELETE", `/background-tasks/${tasks.items[0]!.id}`)).status, 200);
  assert.equal(services.store.listBackgroundTasks(first.id).length, 1);
  console.log("PASS cross-conversation task listing and cancellation retain per-conversation isolation");
} finally {
  await services.close(); await stub.close();
  assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith("uncensia-settings-"));
  fs.rmSync(dir, { recursive: true, force: true });
}
