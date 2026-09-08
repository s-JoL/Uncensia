/** Real HTTP/SQLite regressions for overlapping memory writers and file indexing. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

process.env.UNCENSIA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "uncensia-concurrent-state-"));
process.env.UNCENSIA_ACCESS_CODE = "CONCURRENT-STATE-TEST";
const { createServices } = await import("../src/server/services.ts");
const { createApp } = await import("../src/server/http/app.ts");
const { memoryTools } = await import("../src/server/tools/memory.ts");
const { countTokens } = await import("../src/server/prompts/context.ts");
const { SECRET } = await import("../src/server/config.ts");
const services = createServices();
const app = createApp(services);
const { store, config } = services;
let token = "";
async function call(method: string, url: string, body?: unknown, expected = 200) {
  const response = await app.request(`/v1${url}`, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, expected, `${method} ${url}`);
  return response;
}
const deferred = () => {
  let resolve!: () => void;
  return { promise: new Promise<void>(r => { resolve = r; }), resolve: () => resolve() };
};
let entered = deferred(), release = deferred(), failOld = false;
async function waitForEmbedding() {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([entered.promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Embedding request did not arrive")), 10_000);
    })]);
  } finally { clearTimeout(timer!); }
}
const embeddings = http.createServer(async (req, res) => {
  const buffers: Buffer[] = [];
  for await (const part of req) buffers.push(Buffer.from(part));
  const body = JSON.parse(Buffer.concat(buffers).toString()) as { input: string[] };
  const old = body.input.some(text => text.includes("OLD"));
  if (old) { entered.resolve(); await release.promise; }
  if (old && failOld) { res.writeHead(503); res.end("old request failed"); return; }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: old ? [1, 0] : [0, 1] })) }));
});
await new Promise<void>(resolve => embeddings.listen(0, "127.0.0.1", resolve));
try {
  token = (await (await call("POST", "/auth/token", { accessCode: process.env.UNCENSIA_ACCESS_CODE })).json() as { token: string }).token;
  await call("PATCH", "/capabilities", { memory: { enabled: true, writeEnabled: true, tokenLimit: 256 } });
  const value = "remember ".repeat(180);
  const capability = config.capabilities().memory;
  assert(countTokens(value) < capability.tokenLimit && 2 * countTokens(value) > capability.tokenLimit);
  const a = memoryTools(store, capability), b = memoryTools(store, capability);
  const save = (tools: typeof a, key: string, text = value) => tools[0]!.execute("audit", { intent: "Explicit save", key, value: text });
  await save(a, "alpha");
  await save(b, "beta");
  assert(!store.getMemory("beta"), "a second run exceeded the global budget");
  await call("PUT", "/memory/beta", { value }, 400);
  await call("DELETE", "/memory/alpha");
  await call("PUT", "/memory/beta", { value });
  await save(a, "gamma");
  assert(!store.getMemory("gamma"), "an existing run ignored the UI writer");
  await call("PUT", "/memory/beta", { value: "short" });
  await save(b, "gamma");
  assert.equal(store.getMemory("gamma")?.value, value, "replacement did not free capacity for an existing tool");
  assert(store.listMemories().reduce((sum, row) => sum + row.tokens, 0) <= capability.tokenLimit);
  console.log("PASS concurrent tool instances and HTTP share the live memory budget; replacement frees capacity");

  const port = (embeddings.address() as { port: number }).port;
  services.vault.set(SECRET.embedding, "fixture");
  await call("PATCH", "/capabilities", { files: { enabled: true, searchEnabled: true }, embedding: { enabled: true, baseUrl: `http://127.0.0.1:${port}`, model: "fixture", chunkSize: 512, chunkOverlap: 0 } });
  for (const fail of [false, true]) {
    entered = deferred(); release = deferred(); failOld = fail;
    const note = await (await call("POST", "/files/notes", { name: "race.md", text: "NEW initial" }, 201)).json() as { id: string };
    const old = call("PUT", `/files/${note.id}/text`, { text: "OLD apples" });
    await waitForEmbedding();
    await call("PUT", `/files/${note.id}/text`, { text: "NEW bicycles" });
    release.resolve(); await old;
    assert.equal(store.chunks(note.id)[0]?.text, "NEW bicycles");
    const row = store.db.get<{ vector: Uint8Array }>("SELECT vector FROM embeddings WHERE file_id = ?", note.id)!;
    const vector = Buffer.from(row.vector);
    assert.deepEqual([vector.readFloatLE(0), vector.readFloatLE(4)], [0, 1]);
    assert.equal(store.getFile(note.id)?.embeddingStatus, "ready");
    console.log(`PASS late old indexing ${fail ? "failure" : "success"} cannot change a newer document's vectors or status`);
  }

  entered = deferred(); release = deferred(); failOld = false;
  const note = await (await call("POST", "/files/notes", { name: "cache.md", text: "NEW original" }, 201)).json() as { id: string };
  const before = await call("GET", `/files/${note.id}/content`);
  assert.equal(before.headers.get("cache-control"), "private, no-cache");
  assert.equal(await before.text(), "NEW original");
  const old = call("PUT", `/files/${note.id}/text`, { text: "OLD identical bytes" });
  await waitForEmbedding();
  await call("PATCH", "/capabilities", { files: { searchEnabled: false } });
  await call("PUT", `/files/${note.id}/text`, { text: "OLD identical bytes" });
  release.resolve(); await old;
  assert.equal(store.getFile(note.id)?.embeddingStatus, "none");
  assert.equal(store.chunks(note.id).length, 0);
  assert.equal(await (await call("GET", `/files/${note.id}/content`)).text(), "OLD identical bytes");
  console.log("PASS same-byte edits with indexing disabled invalidate pending work; content requires cache revalidation");
} finally {
  release.resolve();
  await services.close();
  await new Promise<void>(resolve => embeddings.close(() => resolve()));
}
