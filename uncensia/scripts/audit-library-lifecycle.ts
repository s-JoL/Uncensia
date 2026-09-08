/**
 * Isolated functional API audit. Run: runtime/node/node.exe --import tsx scripts/audit-library-lifecycle.ts
 * Add --e2e to run the existing default/settings/chat E2E checks on this temporary server.
 * Real services, SQLite, extraction, retrieval, SDK sessions and authenticated HTTP handlers.
 * Chat completion acknowledges or dispatches an explicitly specified memory operation;
 * a local deterministic embedding endpoint tests vector lifecycle, not semantic quality.
 * Assertions inspect actual requests/state, never a stub's claimed answer.
 * No hosted model, production data, inherited credentials or fixed listening port is used.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { startOpenAiStub } from "./stub-openai.ts";
import { DEFAULT_GLOBAL_PROMPT, DEFAULT_TOOL_PROMPT, ORIGINAL_WRITING_PROMPT } from "../src/server/prompts/defaults.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "uncensia-library-lifecycle-"));
// Set before importing any server module: env.ts fixes all storage paths on import.
process.env.UNCENSIA_DATA_DIR = directory;
process.env.UNCENSIA_ROOT = path.join(directory, "package");
process.env.UNCENSIA_ACCESS_CODE = "LIBRARY-LIFECYCLE-TEST";
for (const key of Object.keys(process.env)) {
  if (/API_KEY|TOKEN|SECRET|EMBEDDING_KEY|TAVILY_KEY/.test(key)) delete process.env[key];
}
const packageSkills = path.join(process.env.UNCENSIA_ROOT, "skills");
for (const name of ["unchanged", "edited", "removed"]) {
  fs.mkdirSync(path.join(packageSkills, name), { recursive: true });
  fs.writeFileSync(path.join(packageSkills, name, "SKILL.md"), `---\nname: ${name}\ndescription: Package ownership fixture.\n---\nOriginal procedure.`);
}
const packageWorkflows = path.join(process.env.UNCENSIA_ROOT, "workflows");
fs.mkdirSync(packageWorkflows, { recursive: true });
fs.writeFileSync(path.join(packageWorkflows, "removed.json"), "{}");
const { createServices } = await import("../src/server/services.ts");
const { createApp } = await import("../src/server/http/app.ts");
const { paths } = await import("../src/server/env.ts");
for (const target of Object.values(paths)) {
  const relative = path.relative(directory, target);
  assert(!relative.startsWith("..") && !path.isAbsolute(relative), `Unisolated path: ${target}`);
}
let services = createServices();
let app = createApp(services);
let token = "";
let action: { name: string; args: Record<string, unknown> } | undefined;
let dispatched = false;
const stub = await startOpenAiStub(0, () => {
  if (action && !dispatched) {
    dispatched = true;
    return { kind: "tool", ...action };
  }
  return { kind: "text", text: "Acknowledged." };
});
const results: Array<{ name: string; passed: boolean; error?: string }> = [];
// JSON response shapes vary across endpoints; outcomes are asserted at each call site.
async function request(method: string, url: string, body?: unknown, status = 200): Promise<any> {
  const response = await app.request(`/v1${url}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = response.status === 204 ? null : await response.json();
  assert.equal(response.status, status, `${method} ${url}: ${JSON.stringify(payload)}`);
  return payload;
}
async function check(name: string, test: () => Promise<void>) {
  try { await test(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    results.push({ name, passed: false, error: detail }); console.error(`FAIL ${name}\n${detail}`);
  }
}
async function upload(name: string, text: string, status = 201) {
  const form = new FormData();
  form.set("file", new File([text], name, { type: "text/plain" }));
  const response = await app.request("/v1/files", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
  const file = await response.json() as any;
  assert.equal(response.status, status, JSON.stringify(file));
  assert(!("diskPath" in file) && !("sha256" in file));
  return file;
}
async function indexed(id: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const file = await request("GET", `/files/${id}`);
    if (file.embeddingStatus === "indexed" || file.embeddingStatus === "ready") return file;
    assert.notEqual(file.embeddingStatus, "failed", JSON.stringify(file));
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Index timeout: ${id}`);
}
async function search(query: string, fileIds?: string[], mode = "keyword", limit = 10) {
  return (await request("POST", "/files/search", { query, fileIds, mode, limit })).results as Array<{ id: string; excerpt: string; name: string }>;
}
async function run(conversationId: string, text: string, attachments: string[] = [], extra = {}) {
  stub.requests.length = 0; dispatched = false;
  const started = await request("POST", `/conversations/${conversationId}/runs`, { text, attachments, ...extra }, 202);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await request("GET", `/runs/${started.runId}`);
    if (state?.status === "completed" && !services.runtime.isActive(conversationId)) return;
    assert(!["failed", "cancelled"].includes(state?.status ?? ""), JSON.stringify(state));
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Run timeout: ${started.runId}`);
}
const model = (id: string, kind = "chat") => ({ id, name: id, providerId: "audit", model: id, apiMode: "openai-chat", kind, enabled: true, input: ["text"], contextWindow: 32000, maxTokens: 500, thinkingLevel: "off" });
const red = "Project Solstice delivery uses crimson barges. The internal code is ORCHID742. 内部代号是红珊瑚。";
const blue = "Project Solstice delivery uses cobalt gliders. The internal code is COBALT915. 内部代号是蓝翡翠。";
let first: any, second: any, conversation: any;
let originalMessages: any;
try {
  token = (await request("POST", "/auth/token", { accessCode: process.env.UNCENSIA_ACCESS_CODE, deviceName: "library-audit" })).token;
  await request("PATCH", "/capabilities", { embedding: { enabled: false }, web: { enabled: false }, coding: { workspace: directory } });
  await request("PUT", "/prompts", { titleEnabled: false });
  await request("POST", "/providers", { id: "audit", name: "audit", baseUrl: `${stub.url}/v1`, auth: { style: "none" }, enabled: true }, 201);
  await request("POST", "/models", model("audit-chat"), 201);
  conversation = await request("POST", "/conversations", { modelId: "audit-chat", title: "Library audit" }, 201);

  const seedreamId = "siray:seedream-5.0-pro-i2i-spicy";
  const seededModels = await request("GET", "/models");
  const freshSeedream = seededModels.items.find((item: any) => item.id === seedreamId);
  await check("fresh defaults match the configured chat, media and prompt baseline", async () => {
    assert.equal(seededModels.defaultEditModelId, seedreamId);
    assert.equal(seededModels.defaultModelId, "openrouter-tencent-hy4-preview");
    assert.equal(freshSeedream.params.siray.maxSources, 10);
    assert.deepEqual(freshSeedream.ops, ["image_to_image"]);
    assert(!services.store.getProvider("venice"));
    assert(!services.store.getProvider("cometapi"));
    assert.deepEqual(services.store.listModels().filter(m => m.providerId === "openrouter").map(m => m.model), ["tencent/hy4-preview"]);
    assert.deepEqual(services.store.listModels().filter(m => m.providerId === "siray" && m.enabled).map(m => m.model), ["bytedance/seedream-5.0-pro-i2i-spicy", "alibaba/wan-3.0-t2v-spicy", "alibaba/wan-3.0-i2v-spicy", "alibaba/wan-3.0-ref2v-spicy"]);
    assert.deepEqual(services.store.listModels().filter(m => m.providerId === "siray" && m.agentTool).map(m => m.model), ["alibaba/wan-3.0-i2v-spicy", "alibaba/wan-3.0-ref2v-spicy"]);
    assert.equal(services.config.prompts().globalPrompt, DEFAULT_GLOBAL_PROMPT);
    assert(services.config.prompts().globalPrompt.includes(ORIGINAL_WRITING_PROMPT));
    assert.equal(services.store.getMeta("initialized"), "true");
  });
  await check("restart preserves configured model parameters, disabled state and deleted defaults", async () => {
    await request("PATCH", "/models/" + seedreamId, { enabled: false, pinned: false, params: { maxSources: 1, editModel: "my-edit-model", promptHints: "" } });
    const before = services.store.getModel(seedreamId)!;
    const defaults = services.config.generationDefaults();
    services.store.deleteModel("siray:wan-3.0-ref2v-spicy");
    await services.close(); services = createServices(); app = createApp(services);
    assert.deepEqual(services.store.getModel(seedreamId), before);
    assert.deepEqual(services.config.generationDefaults(), defaults);
    assert(!services.store.getModel("siray:wan-3.0-ref2v-spicy"), "deleted packaged model was recreated");
    await request("PATCH", "/models/" + seedreamId, { enabled: freshSeedream.enabled, pinned: freshSeedream.pinned, params: freshSeedream.params });
  });
  await check("recorded package prompt updates while edited and deliberately empty prompts survive", async () => {
    const previous = "A previous packaged tool prompt.";
    await request("PUT", "/prompts", { toolPrompt: previous, globalPrompt: "My custom assistant." });
    const hashes = JSON.parse(services.store.getMeta("prompt_hashes")!);
    hashes.toolPrompt = createHash("sha256").update(previous).digest("hex");
    services.store.setMeta("prompt_hashes", JSON.stringify(hashes));
    await services.close(); services = createServices(); app = createApp(services);
    assert.equal(services.config.prompts().toolPrompt, DEFAULT_TOOL_PROMPT);
    assert.equal(services.config.prompts().globalPrompt, "My custom assistant.");
    await request("PUT", "/prompts", { globalPrompt: "" });
    await services.close(); services = createServices(); app = createApp(services);
    assert.equal(services.config.prompts().globalPrompt, "");
  });
  await request("PUT", "/prompts", { globalPrompt: DEFAULT_GLOBAL_PROMPT });

  await check("conflicting documents retain exact content and identity; no-key indexing works", async () => {
    first = await upload("solstice-red.txt", red);
    second = await request("POST", "/files/notes", { name: "solstice-blue", text: blue }, 201);
    assert.notEqual(first.id, second.id);
    for (const [file, text] of [[first, red], [second, blue]] as const) {
      assert.equal((await indexed(file.id)).embeddingStatus, "indexed");
      assert.equal((await request("GET", `/files/${file.id}/text`)).text, text);
    }
    const hits = await search("Solstice");
    assert.deepEqual(new Set(hits.map(hit => hit.id)), new Set([first.id, second.id]));
    for (const hit of hits) assert.equal(hit.excerpt, hit.id === first.id ? red : blue);
  });
  await check("scoped retrieval excludes conflicting sources, including top-1 and empty scope", async () => {
    for (const mode of ["keyword", "hybrid"]) {
      for (const file of [first, second]) {
        const hits = await search("Solstice", [file.id], mode, 1);
        assert.equal(hits.length, 1); assert.equal(hits[0]!.id, file.id);
        assert.equal(hits[0]!.excerpt, file.id === first.id ? red : blue);
      }
      assert.deepEqual(await search("Solstice", [], mode), []);
      assert.deepEqual(await search("Solstice", ["file_missing"], mode), []);
      assert.deepEqual(await search("COBALT915", [first.id], mode), []);
    }
    assert((await search("内部代号是什么", [second.id])).some(hit => hit.excerpt.includes("蓝翡翠")));
    await request("POST", "/files/search", { query: "Solstice", fileIds: "invalid" }, 400);
  });
  await check("duplicate upload folds into original without orphan bytes or duplicate hits", async () => {
    const before = fs.readdirSync(paths.files).sort();
    assert.equal((await upload("renamed-copy.txt", red, 200)).id, first.id);
    assert.deepEqual(fs.readdirSync(paths.files).sort(), before);
    assert.equal((await search("ORCHID742")).length, 1);
  });
  await check("package updates preserve edited and deleted skills/workflows, while adding new files", async () => {
    const custom = "My own procedure.";
    fs.writeFileSync(path.join(paths.skills, "edited", "SKILL.md"), custom);
    fs.rmSync(path.join(paths.skills, "removed", "SKILL.md"));
    fs.rmSync(path.join(paths.workflows, "removed.json"));
    for (const name of ["unchanged", "edited", "removed", "new-skill"]) {
      fs.mkdirSync(path.join(packageSkills, name), { recursive: true });
      fs.writeFileSync(path.join(packageSkills, name, "SKILL.md"), `---\nname: ${name}\ndescription: Package ownership fixture.\n---\nUpdated procedure.`);
    }
    await services.close(); services = createServices(); app = createApp(services);
    assert.match(fs.readFileSync(path.join(paths.skills, "unchanged", "SKILL.md"), "utf8"), /Updated procedure/);
    assert.equal(fs.readFileSync(path.join(paths.skills, "edited", "SKILL.md"), "utf8"), custom);
    assert(!fs.existsSync(path.join(paths.skills, "removed", "SKILL.md")));
    assert(!fs.existsSync(path.join(paths.workflows, "removed.json")));
    assert(fs.existsSync(path.join(paths.skills, "new-skill", "SKILL.md")));
  });
  await check("workspace files preserve source bytes, reject escapes and deliver searchable downloads", async () => {
    const { workspaceFileTools } = await import("../src/server/tools/workspace-files.ts");
    const workspace = path.join(directory, "workspace"); fs.mkdirSync(workspace, { recursive: true });
    const coding = { workspace, read: true, write: true, shell: false };
    const tools = new Map(workspaceFileTools(services.store, coding, conversation.id, file => services.retrieval.indexFile(file)).map(tool => [tool.name, tool]));
    const call = (name: string, args: object) => tools.get(name)!.execute("audit", args, undefined);
    await call("import_file", { file_id: first.id, path: "input.txt" });
    assert.equal(fs.readFileSync(path.join(workspace, "input.txt"), "utf8"), red);
    await assert.rejects(call("import_file", { file_id: first.id, path: "input.txt" }), /exist/i);
    await assert.rejects(call("import_file", { file_id: first.id, path: "../escaped.txt" }), /outside/);
    await assert.rejects(call("publish_file", { path: "../master.key" }), /outside/);
    fs.writeFileSync(path.join(workspace, "output.md"), "Workspace delivery marker DELIVER813.");
    const published = await call("publish_file", { path: "output.md" });
    const fileId = (published.details as { file_id: string }).file_id;
    assert.equal(services.store.getFile(fileId)!.source, "workspace");
    assert((await search("DELIVER813", [fileId])).length > 0);
    assert.equal(((await call("publish_file", { path: "output.md" })).details as { file_id: string }).file_id, fileId);
    const response = await app.request(`/v1/files/${fileId}/content?download=1`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert(response.headers.get("content-disposition")?.startsWith("attachment;"));
    assert(response.headers.get("content-security-policy")?.includes("sandbox"));
    assert.equal(await response.text(), "Workspace delivery marker DELIVER813.");
    assert.deepEqual(workspaceFileTools(services.store, { ...coding, read: false, write: false }, conversation.id), []);
    // Image publication uses the same asset/provenance path as an upload, without rendering.
    const { default: sharp } = await import("sharp");
    const imagePath = path.join(workspace, "output.png");
    await sharp({ create: { width: 24, height: 24, channels: 3, background: "blue" } }).png().toFile(imagePath);
    const image = await call("publish_file", { path: "output.png" });
    const imageId = (image.details as { file_id: string }).file_id;
    assert(imageId.startsWith("img_") && services.store.getImageAsset(imageId));
    const bytes = await app.request(`/v1/images/${imageId}`, { headers: { authorization: `Bearer ${token}` } });
    assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), fs.readFileSync(imagePath));
    await call("import_file", { file_id: imageId, path: "round-trip.png" });
    assert.deepEqual(fs.readFileSync(path.join(workspace, "round-trip.png")), fs.readFileSync(imagePath));
    // An offline document may carry megabytes of pixels. Only its actual prose
    // belongs in the index or in a future model request.
    const html = `<html><head><style>.card{color:red}</style><script>DO_NOT_INDEX_SCRIPT</script></head><body><h1>Offline &amp; complete</h1><p>HTMLBODY819</p><div hidden>HIDDEN_SECRET</div><img src="data:image/png;base64,${"a".repeat(2_000_000)}"></body></html>`;
    fs.writeFileSync(path.join(workspace, "offline.html"), html);
    const document = await call("publish_file", { path: "offline.html" });
    const htmlId = (document.details as { file_id: string }).file_id;
    const chunks = services.store.chunks(htmlId);
    assert(chunks.length > 0 && chunks.length < 3);
    const plain = chunks.map(chunk => chunk.text).join("\n");
    assert(plain.includes("Offline & complete") && plain.includes("HTMLBODY819"));
    assert(!plain.includes("base64") && !plain.includes("DO_NOT_INDEX_SCRIPT") && !plain.includes("HIDDEN_SECRET"));
    assert.equal(fs.readFileSync(services.store.getFile(htmlId)!.diskPath, "utf8"), html);
  });
  await check("malformed search requests return 400 without changing the library", async () => {
    const before = await request("GET", "/files");
    const invalid: unknown[] = [null, [], {}, { query: 123 }, { query: null }, { query: [] }, { query: {} }, { query: false }, { query: "   " }];
    for (const mode of [null, 123, [], {}, false, "unknown", "KEYWORD", ""]) invalid.push({ query: "Solstice", mode });
    for (const limit of [null, "2", [], {}, false, 0, -1, 1.5, 51, 1e100]) invalid.push({ query: "Solstice", limit });
    // Invalid input must be rejected even when an empty selection avoids retrieval.
    invalid.push({ query: "Solstice", fileIds: [], mode: "unknown" }, { query: "Solstice", fileIds: [], limit: "2" });
    for (const body of invalid) {
      const error = await request("POST", "/files/search", body, 400);
      assert.equal(error.error.code, "invalid", JSON.stringify(body));
      assert.equal(typeof error.error.message, "string");
    }
    assert.deepEqual(await request("GET", "/files"), before);
    assert((await request("POST", "/files/search", { query: "  Solstice  " })).results.length > 0);
    for (const limit of [1, 50]) assert((await search("Solstice", [first.id], "keyword", limit)).length > 0);
  });
  await check("caught indexing errors return failed status, keep saved bytes and recover on reindex", async () => {
    const marker = "AUDIT_EMBEDDING_UNAVAILABLE";
    let calls = 0;
    const endpoint = http.createServer(async (req, res) => {
      for await (const _chunk of req) { /* consume the real embedding request */ }
      calls++;
      res.writeHead(503, { "content-type": "text/plain" }); res.end(marker);
    });
    await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
    const address = endpoint.address(); assert(address && typeof address !== "string");
    const before = await request("GET", "/capabilities");
    try {
      await request("PATCH", "/capabilities", { embedding: { enabled: true, baseUrl: `http://127.0.0.1:${address.port}`, model: "audit-failing-embedding", dimensions: 3 } });
      await request("PUT", "/capabilities/secrets/embedding", { value: "local-test-placeholder" });
      const text = "This saved note must survive an embedding outage: OUTAGE374.";
      const created = await request("POST", "/files/notes", { name: "embedding-outage", text }, 201);
      assert.equal(created.embeddingStatus, "failed");
      assert(created.embeddingError.includes(marker));
      assert.deepEqual(await request("GET", `/files/${created.id}`), created);
      assert.equal((await request("GET", `/files/${created.id}/text`)).text, text);
      const revised = "The saved correction must also survive: RECOVERY832.";
      const edited = await request("PUT", `/files/${created.id}/text`, { text: revised });
      assert.equal(edited.embeddingStatus, "failed");
      assert(edited.embeddingError.includes(marker));
      assert.equal((await request("GET", `/files/${created.id}/text`)).text, revised);
      assert.equal(calls, 2);
      assert.deepEqual(await search("OUTAGE374", [created.id]), []);
      assert((await search("RECOVERY832", [created.id])).some(hit => hit.excerpt === revised));
      // Missing embeddings still permit real keyword indexing after the outage.
      await request("DELETE", "/capabilities/secrets/embedding");
      const recovered = await request("POST", `/files/${created.id}/reindex`);
      assert.equal(recovered.embeddingStatus, "indexed");
      assert.equal(recovered.embeddingError, null);
      assert.equal(recovered.embedded, 0); assert(recovered.chunks > 0);
      const empty = await request("POST", "/files/notes", { name: "empty-note", text: "" }, 201);
      assert.equal(empty.embeddingStatus, "failed");
      assert.equal(empty.embeddingError, "No extractable text");
    } finally {
      await request("DELETE", "/capabilities/secrets/embedding");
      await request("PATCH", "/capabilities", { embedding: before.embedding });
      await new Promise<void>((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve()));
    }
  });
  await check("attached document reaches current model request, excluding conflicting document body", async () => {
    await run(conversation.id, "Read the document attached to this message.", [second.id]);
    assert(stub.requests.length > 0);
    const sent = JSON.stringify(stub.requests[0]!.messages);
    assert(sent.includes(blue)); assert(!sent.includes(red));
    const system = JSON.stringify(stub.requests[0]!.messages?.filter(message => message.role === "system"));
    assert(!system.includes("Documents attached to this message"));
    const current = JSON.stringify(stub.requests[0]!.messages?.findLast(message => message.role === "user"));
    assert(current.includes("Documents attached to this message"));
    assert(!current.includes(`${second.name} (user reference library)`));
    originalMessages = (await request("GET", `/conversations/${conversation.id}/messages`)).items;
    const user = originalMessages.find((message: any) => message.role === "user");
    const refs = user.content.content.filter((part: any) => part.type === "file_ref");
    assert.deepEqual(refs, [{ type: "file_ref", file_id: second.id, name: second.name, mime_type: second.mime, bytes: second.bytes }]);
    assert(!JSON.stringify(originalMessages).includes(blue));
  });
  await check("later turn keeps attachment ID but does not repeat document body", async () => {
    await run(conversation.id, "Continue without a new attachment.");
    const sent = JSON.stringify(stub.requests[0]!.messages);
    assert(sent.includes(second.id)); assert(!sent.includes(blue));
    assert(!sent.includes("# Documents attached to this message"));
  });
  await check("restart preserves attachment identity and edit/retry can reattach it", async () => {
    const before = (await request("GET", `/conversations/${conversation.id}/messages`)).items;
    await services.close(); services = createServices(); app = createApp(services);
    assert.deepEqual((await request("GET", `/conversations/${conversation.id}/messages`)).items, before);
    const user = before.find((message: any) => message.role === "user");
    await run(conversation.id, "Read this attachment again after editing my question.", [second.id], { fromSeq: user.seq });
    assert(JSON.stringify(stub.requests[0]!.messages).includes(blue));
    const messages = (await request("GET", `/conversations/${conversation.id}/messages`)).items;
    assert.equal(messages.filter((message: any) => message.role === "user").length, 1);
    assert(JSON.stringify(messages).includes(second.id));
  });
  await check("memory tool records real source; correction replaces prompt fact and clears attribution", async () => {
    const value = "For this audit, I prefer copper notebooks.";
    action = { name: "set_memory", args: { intent: "User explicitly asked to remember", key: "audit_preference", value } };
    try { await run(conversation.id, `Remember this: ${value}`); } finally { action = undefined; }
    let memory = (await request("GET", "/memory")).items.find((item: any) => item.key === "audit_preference");
    assert.equal(memory.value, value); assert.equal(memory.sourceConversationId, conversation.id);
    assert.equal((await request("GET", `/conversations/${memory.sourceConversationId}`)).id, conversation.id);
    const corrected = "For this audit, I prefer jade notebooks.";
    await request("PUT", "/memory/audit_preference", { value: corrected });
    memory = (await request("GET", "/memory")).items.find((item: any) => item.key === "audit_preference");
    assert.equal(memory.sourceConversationId, null); assert.equal(memory.value, corrected);
    await run(conversation.id, "Continue.");
    const system = JSON.stringify(stub.requests[0]!.messages?.filter(message => message.role === "system"));
    assert(!system.includes(corrected)); assert(!system.includes(value));
    const current = JSON.stringify(stub.requests[0]!.messages?.findLast(message => message.role === "user"));
    assert(current.includes(corrected)); assert(!current.includes(value));
    await request("DELETE", "/memory/audit_preference");
    assert(!(await request("GET", "/memory")).items.some((item: any) => item.key === "audit_preference"));
    await run(conversation.id, "Continue again.");
    assert(!JSON.stringify(stub.requests[0]!.messages?.filter(message => message.role === "system")).includes(corrected));
    assert(!JSON.stringify(stub.requests[0]!.messages?.findLast(message => message.role === "user")).includes(corrected));
  });
  await check("invalid memory requests cannot overwrite a saved fact", async () => {
    await request("PUT", "/memory/retained", { value: "Keep this exact sentence." });
    for (const value of ["", " ", "x".repeat(10001), 42, {}, []]) {
      await request("PUT", "/memory/retained", { value }, 400);
      assert.equal((await request("GET", "/memory")).items.find((item: any) => item.key === "retained").value, "Keep this exact sentence.");
    }
    await request("PUT", "/memory/bad.key", { value: "invalid" }, 400);
  });
  await check("memory budget rejection is atomic; replacement and deletion free capacity", async () => {
    const before = await request("GET", "/capabilities");
    await request("PATCH", "/capabilities", { memory: { tokenLimit: 256 } });
    try {
      await request("PUT", "/memory/budget", { value: "汉".repeat(200) });
      const saved = await request("GET", "/memory");
      await request("PUT", "/memory/overflow", { value: "字".repeat(900) }, 400);
      assert.deepEqual(await request("GET", "/memory"), saved);
      await request("PUT", "/memory/budget", { value: "short" });
      assert((await request("GET", "/memory")).tokens < saved.tokens);
      await request("DELETE", "/memory/budget");
      await request("PUT", "/memory/reused", { value: "汉".repeat(200) });
      await request("DELETE", "/memory/reused");
    } finally { await request("PATCH", "/capabilities", { memory: before.memory }); }
  });
  await check("memory retains historical source ID after conversation deletion; tool can forget it", async () => {
    const source = await request("POST", "/conversations", { modelId: "audit-chat", title: "Memory source" }, 201);
    action = { name: "set_memory", args: { intent: "Explicit remember request", key: "source_fact", value: "This fixture uses amber folders." } };
    try { await run(source.id, "Remember: this fixture uses amber folders."); } finally { action = undefined; }
    assert.equal((await request("GET", "/memory")).items.find((item: any) => item.key === "source_fact").sourceConversationId, source.id);
    await request("DELETE", `/conversations/${source.id}`, undefined, 204);
    const retained = (await request("GET", "/memory")).items.find((item: any) => item.key === "source_fact");
    assert.equal(retained.value, "This fixture uses amber folders.");
    // A historical source ID is still true provenance even after its conversation is gone.
    assert.equal(retained.sourceConversationId, source.id);
    await request("GET", `/conversations/${retained.sourceConversationId}`, undefined, 404);
    action = { name: "delete_memory", args: { intent: "Explicit forget request", key: "source_fact" } };
    try { await run(conversation.id, "Forget the source_fact memory."); } finally { action = undefined; }
    assert(!(await request("GET", "/memory")).items.some((item: any) => item.key === "source_fact"));
  });
  await check("editing immediately replaces searchable facts and retains attachment identity", async () => {
    const updated = "Project Solstice delivery now uses ivory ferries. The internal code is IVORY286.";
    const file = await request("PUT", `/files/${second.id}/text`, { name: "corrected.md", text: updated });
    assert.equal(file.id, second.id);
    assert.equal((await request("GET", `/files/${second.id}/text`)).text, updated);
    assert.deepEqual(await search("COBALT915", [second.id]), []);
    assert((await search("IVORY286", [second.id])).some(hit => hit.excerpt === updated));
    const reindexed = await request("POST", `/files/${second.id}/reindex`);
    assert.equal(reindexed.embedded, 0); assert(reindexed.chunks > 0);
    await run(conversation.id, "Read the corrected attachment.", [second.id]);
    const sent = JSON.stringify(stub.requests[0]!.messages);
    assert(sent.includes(updated)); assert(!sent.includes(blue));
  });
  await check("editing while indexing is disabled cannot expose stale text", async () => {
    const note = await request("POST", "/files/notes", { name: "disabled-index", text: "RETIRED917 is obsolete." }, 201);
    await indexed(note.id);
    await request("PATCH", "/capabilities", { files: { searchEnabled: false } });
    try {
      await request("PUT", `/files/${note.id}/text`, { text: "CURRENT385 is the replacement." });
      assert.deepEqual(await search("RETIRED917", [note.id]), []);
    } finally { await request("PATCH", "/capabilities", { files: { searchEnabled: true } }); }
    await request("POST", `/files/${note.id}/reindex`);
    assert((await search("CURRENT385", [note.id])).length > 0);
  });
  await check("invalid document edits leave original bytes and retrieval intact", async () => {
    const before = (await request("GET", `/files/${first.id}/text`)).text;
    for (const body of [{ text: 12 }, { name: {}, text: "destructive" }]) {
      await request("PUT", `/files/${first.id}/text`, body, 400);
      assert.equal((await request("GET", `/files/${first.id}/text`)).text, before);
    }
  });
  await check("delete removes bytes and retrieval, preserves historical attachment and rejects reuse", async () => {
    const disk = services.store.getFile(second.id)!.diskPath;
    const before = (await request("GET", `/conversations/${conversation.id}/messages`)).items;
    await request("DELETE", `/files/${second.id}`, undefined, 204);
    assert(!fs.existsSync(disk));
    await request("GET", `/files/${second.id}`, undefined, 404);
    await request("GET", `/files/${second.id}/content`, undefined, 404);
    assert.deepEqual(await search("IVORY286"), []);
    assert.equal(services.store.chunks(second.id).length, 0);
    assert.equal(services.db.all("SELECT * FROM embeddings WHERE file_id = ?", second.id).length, 0);
    assert.deepEqual((await request("GET", `/conversations/${conversation.id}/messages`)).items, before);
    assert(JSON.stringify(before).includes(second.id));
    await request("POST", `/conversations/${conversation.id}/runs`, { text: "Read deleted attachment", attachments: [second.id] }, 422);
    assert.deepEqual((await request("GET", `/conversations/${conversation.id}/messages`)).items, before);
    assert((await search("ORCHID742", [first.id])).length > 0);
  });
  await check("real vector index obeys file scope and rebuilds after edit/delete", async () => {
    // Deterministic embedding transport fixture, not a semantic-quality claim. Real extraction
    // sends real document bytes through HTTP; production embedding storage/LanceDB do all indexing.
    const inputs: string[] = [];
    const endpoint = http.createServer(async (req, res) => {
      try {
        assert.equal(req.url, "/embeddings");
        let raw = ""; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw) as { input: string[] };
        inputs.push(...body.input);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: body.input.map((text, index) => ({ index, embedding: [text.includes("AMBER631") ? 1 : 0, text.includes("JADE824") ? 1 : 0, 0.01] })) }));
      } catch (error) { res.statusCode = 500; res.end(String(error)); }
    });
    await new Promise<void>(resolve => endpoint.listen(0, "127.0.0.1", resolve));
    const address = endpoint.address(); assert(address && typeof address !== "string");
    const before = await request("GET", "/capabilities");
    try {
      await request("PATCH", "/capabilities", { embedding: { enabled: true, baseUrl: `http://127.0.0.1:${address.port}`, model: "audit-vector", dimensions: 3 } });
      await request("PUT", "/capabilities/secrets/embedding", { value: "local-test-placeholder" });
      const amberText = "The vector fixture dispatch code is AMBER631.";
      const jadeText = "The conflicting vector fixture dispatch code is JADE824.";
      const amber = await request("POST", "/files/notes", { name: "vector-amber", text: amberText }, 201);
      const jade = await request("POST", "/files/notes", { name: "vector-jade", text: jadeText }, 201);
      assert.equal(amber.embeddingStatus, "ready"); assert.equal(jade.embeddingStatus, "ready");
      assert(inputs.includes(amberText) && inputs.includes(jadeText));
      assert(services.db.all("SELECT * FROM embeddings WHERE file_id = ?", amber.id).length > 0);
      assert.equal((await search("AMBER631", undefined, "semantic", 1))[0]!.id, amber.id);
      assert.equal((await search("AMBER631", [jade.id], "semantic", 1))[0]!.id, jade.id);
      assert.deepEqual(await search("AMBER631", [], "semantic"), []);
      const revised = "The corrected vector dispatch code is JADE824.";
      await request("PUT", `/files/${amber.id}/text`, { text: revised });
      const hits = await search("JADE824", [amber.id], "semantic", 1);
      assert.equal(hits[0]!.excerpt, revised);
      assert.deepEqual(await search("AMBER631", [amber.id], "keyword"), []);
      await request("PATCH", "/capabilities", { files: { searchEnabled: false } });
      await request("PUT", `/files/${amber.id}/text`, { text: "The unindexed replacement is QUARTZ529." });
      assert.equal(services.db.all("SELECT * FROM embeddings WHERE file_id = ?", amber.id).length, 0);
      assert.deepEqual(await search("JADE824", [amber.id], "semantic"), []);
      await request("DELETE", `/files/${jade.id}`, undefined, 204);
      assert.equal(services.db.all("SELECT * FROM embeddings WHERE file_id = ?", jade.id).length, 0);
      assert.deepEqual(await search("JADE824", [jade.id], "semantic"), []);
    } finally {
      await request("DELETE", "/capabilities/secrets/embedding");
      await request("PATCH", "/capabilities", { embedding: before.embedding, files: before.files });
      await new Promise<void>((resolve, reject) => endpoint.close(error => error ? reject(error) : resolve()));
    }
  });
  await check("unavailable chat default is preserved in API, never silently substituted", async () => {
    await request("POST", "/models", model("audit-unavailable"), 201);
    await request("PUT", "/models/default", { modelId: "audit-unavailable" });
    await request("PATCH", "/models/audit-unavailable", { enabled: false });
    assert.equal((await request("GET", "/models")).defaultModelId, "audit-unavailable");
    await request("PATCH", "/capabilities", { memory: { writeEnabled: false } });
    assert.equal((await request("GET", "/models")).defaultModelId, "audit-unavailable");
    assert.equal((await request("GET", "/bootstrap")).defaultModelId, "audit-unavailable");
    const pending = await request("POST", "/conversations", { title: "Unavailable default" }, 201);
    assert.equal(pending.modelId, "audit-unavailable");
    const before = (await request("GET", `/conversations/${pending.id}/messages`)).items;
    stub.requests.length = 0;
    const rejected = await request("POST", `/conversations/${pending.id}/runs`, { text: "Do not substitute a model." }, 400);
    assert.equal(rejected.error.code, "unknown_model");
    assert(rejected.error.message.includes("audit-unavailable"));
    assert.equal(stub.requests.length, 0);
    assert.deepEqual((await request("GET", `/conversations/${pending.id}/messages`)).items, before);
    assert.equal((await request("GET", `/conversations/${pending.id}`)).activeRun, null);
    await services.close(); services = createServices(); app = createApp(services);
    assert.equal((await request("GET", "/models")).defaultModelId, "audit-unavailable");
    await request("PATCH", "/models/audit-unavailable", { enabled: true });
    await run(pending.id, "The same model is available again.");
    assert.equal((await request("GET", `/conversations/${pending.id}`)).modelId, "audit-unavailable");
    await request("DELETE", "/models/audit-unavailable", undefined, 204);
    assert.equal((await request("GET", "/models")).defaultModelId, "audit-unavailable");
    await request("POST", `/conversations/${pending.id}/runs`, { text: "Deleted model must fail." }, 400);
  });
  await check("unconfigured default keeps identity and fails before creating a run", async () => {
    await request("POST", "/providers", { id: "audit-no-key", name: "Missing credentials", baseUrl: `${stub.url}/v1`, auth: { style: "bearer" }, enabled: true }, 201);
    await request("POST", "/models", { ...model("audit-no-key-chat"), providerId: "audit-no-key" }, 201);
    assert.equal((await request("PUT", "/models/default", { modelId: "audit-no-key-chat" })).defaultModelId, "audit-no-key-chat");
    const pending = await request("POST", "/conversations", { title: "Unconfigured default" }, 201);
    assert.equal(pending.modelId, "audit-no-key-chat");
    stub.requests.length = 0;
    const rejected = await request("POST", `/conversations/${pending.id}/runs`, { text: "Missing credential" }, 422);
    assert.equal(rejected.error.code, "not_configured");
    assert.equal(stub.requests.length, 0);
    assert.deepEqual((await request("GET", `/conversations/${pending.id}/messages`)).items, []);
    assert.equal((await request("GET", `/conversations/${pending.id}`)).activeRun, null);
    await request("PUT", "/models/default", { modelId: "audit-chat" });
  });
  await check("empty default discovers usable chat; empty installation reports no model", async () => {
    // Setup-only state: exercise absence of a saved choice without changing seed behavior.
    services.store.setSetting("defaultModelId", "");
    assert.equal((await request("GET", "/models")).defaultModelId, "audit-chat");
    assert.equal(services.store.getSetting("defaultModelId", "missing"), "");
    const fresh = await request("POST", "/conversations", { title: "No explicit default" }, 201);
    assert.equal(fresh.modelId, "audit-chat");
    await run(fresh.id, "Automatic selection is allowed for an empty default.");
    await request("PATCH", "/models/audit-chat", { enabled: false });
    assert.equal((await request("GET", "/models")).defaultModelId, "");
    const rejected = await request("POST", "/conversations", { title: "No usable chat" }, 422);
    assert.equal(rejected.error.code, "no_model");
    await request("PATCH", "/models/audit-chat", { enabled: true });
    await request("PUT", "/models/default", { modelId: "audit-chat" });
  });
  await check("unavailable generation defaults survive partial settings saves and restart", async () => {
    const before = await request("GET", "/models");
    assert(before.defaultImageModelId && before.defaultEditModelId && before.defaultVideoModelId);
    for (const id of new Set([before.defaultImageModelId, before.defaultEditModelId, before.defaultVideoModelId])) {
      await request("PATCH", `/models/${encodeURIComponent(id)}`, { enabled: false });
    }
    await request("PUT", "/models/generation-defaults", { editModelId: before.defaultEditModelId });
    await services.close(); services = createServices(); app = createApp(services);
    const after = await request("GET", "/models");
    for (const key of ["defaultImageModelId", "defaultEditModelId", "defaultVideoModelId"]) assert.equal(after[key], before[key]);
    assert.equal(services.db.all("PRAGMA foreign_key_check").length, 0);
    assert.equal(Object.values(services.db.get("PRAGMA integrity_check")!)[0], "ok");
  });
  if (process.argv.includes("--e2e")) {
    // Existing E2E reads generation catalogue metadata in these checks; it never renders.
    const catalogue = await request("GET", "/models");
    await request("PATCH", `/models/${encodeURIComponent(catalogue.defaultImageModelId)}`, { enabled: true });
    await request("PUT", "/prompts", { titleEnabled: true });
    const { serve } = await import("@hono/node-server");
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!server.listening) await new Promise<void>(resolve => server.once("listening", resolve));
    const address = server.address(); assert(address && typeof address !== "string");
    try {
      for (const name of [
        "bootstrap exposes what a cold client needs",
        "unknown model api modes are rejected without creating a row",
        "plain chat streams text and generates a title",
        "settings changes take effect on the next run",
        "generation defaults bind the studio and the agent",
        "failures answer in the documented envelope",
      ]) {
        await check(`E2E: ${name}`, async () => {
          const child = spawn(process.execPath, ["--import", "tsx", "scripts/e2e.ts", name], {
            cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
            env: { ...process.env, UNCENSIA_BASE: `http://127.0.0.1:${address.port}/v1`, UNCENSIA_E2E_STUB: "1", UNCENSIA_E2E_LIVE: "0" },
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });
          let output = "";
          child.stdout.on("data", chunk => { output += chunk; });
          child.stderr.on("data", chunk => { output += chunk; });
          const timeout = setTimeout(() => child.kill(), 45_000);
          try {
            const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
            assert.equal(code, 0, output);
            assert(output.includes("1/1 passed"), output);
            console.log(output.trim());
          } finally { clearTimeout(timeout); }
        });
      }
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }
} finally {
  await services.close(); await stub.close();
  // Delete only the exact fresh directory created above; never a configured/user path.
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert(path.basename(directory).startsWith("uncensia-library-lifecycle-"));
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length, results }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
