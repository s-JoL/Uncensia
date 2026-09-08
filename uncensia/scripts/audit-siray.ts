/** Siray wire contracts: no external calls or credentials. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "uncensia-siray-"));
process.env.UNCENSIA_DATA_DIR = root;
const { ensureDirectories } = await import("../src/server/env.ts");
const { Db } = await import("../src/server/store/db.ts");
const { Store } = await import("../src/server/store/store.ts");
const { sirayModels } = await import("../src/server/models/siray.ts");
const { discoverModels } = await import("../src/server/models/catalogue.ts");
const { sirayAdapter } = await import("../src/server/generation/siray.ts");
const { opsOf, schemaOf, validateParams } = await import("../src/server/generation/index.ts");
import type { GenerationContext, GenerationRequest } from "../src/server/generation/types.ts";
ensureDirectories();
const db = new Db(":memory:"), store = new Store(db);
const provider = store.upsertProvider({ id: "siray", name: "Siray", baseUrl: "https://api.siray.ai/v1" });
const models = sirayModels.map(m => store.upsertModel(m));
const png = await (await import("sharp")).default({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).png().toBuffer();
const originalFetch = globalThis.fetch;
const keepAlive = setInterval(() => {}, 1_000);
let posts = 0, adopted = "", body: Record<string, any> = {}, failure = false, missingId = false;
let nested = false, image = true, catalogue = false;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://output.example/")) {
    assert.equal(new Headers(init?.headers).get("authorization"), null, "output download must not leak key");
    return new Response(image ? png : Buffer.from("video fixture"), { headers: { "content-type": image ? "image/png" : "video/mp4" } });
  }
  assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only");
  if (catalogue) {
    assert.match(String(url), /^https:\/\/api\.siray\.ai\/v1\/models/);
    return Response.json({ data: [...sirayModels.map(spec => ({ id: spec.model })), { id: "bytedance/seedream-5.0-pro-t2i-spicy" }, { id: "alibaba/wan-3.0-i2v-prime-spicy" }] });
  }
  if (init?.method === "POST") {
    posts++; body = JSON.parse(String(init.body));
    assert.equal(String(url), `https://api.siray.ai/v1/${image ? "images/generations/async" : "video/generations"}`);
    return Response.json(missingId ? { message: "accepted" } : nested ? { code: "success", data: { task_id: "task-1" } } : { code: 0, id: "task-1" });
  }
  assert.equal(adopted, "task-1", "persist task before first poll");
  return Response.json({ code: "success", data: { task_id: "task-1", status: failure ? "FAILURE" : "success", fail_reason: "provider rejected parameters", outputs: ["https://output.example/result"] } });
};
const ctx: GenerationContext = { store, apiKey: "test-only", signal: new AbortController().signal, progress() {}, adopt(id) { adopted = id; } };
const source = { imageId: "fixture", bytes: png, mime: "image/png", width: 8, height: 8 };
try {
  catalogue = true;
  const discovered = await discoverModels(provider, "test-only", new Set());
  assert.deepEqual(discovered.map(item => item.model).sort(), sirayModels.map(spec => spec.model).sort());
  assert(discovered.every(item => item.suggestion.apiMode === "siray-media" && item.suggestion.kindSource === "catalogue"));
  console.log("PASS Siray discovery exposes only explicitly supported siray-media profiles");
  catalogue = false;
  for (const spec of models) {
    image = spec.kind === "image";
    for (const op of opsOf(spec)) {
      const schema = schemaOf(spec, op), params: Record<string, unknown> = { prompt: "Change the door or animate the scene" };
      for (const key of schema.required ?? []) if (!(key in params) && key !== "source_image_id") params[key] = schema.properties![key]!.enum![0];
      const sources = op.startsWith("image_") ? [source, source] : [];
      validateParams(schema, { ...params, ...(sources.length ? { source_image_id: "fixture", additional_source_image_ids: ["fixture"] } : {}) });
      const request: GenerationRequest = { spec, provider, op, prompt: String(params.prompt), params, sources };
      nested = !nested;
      const result = await sirayAdapter.run(request, ctx);
      assert.equal(result.assets.length, 1); assert.equal(body.model, spec.model);
      if (sources.length) {
        if (spec.model.includes("-i2v-")) { assert.ok(body.image); assert.ok(body.end_image); assert.equal(body.images, undefined); }
        else assert.equal(body.images.length, 2);
      } else assert.equal(body.images, undefined);
      if (spec.model.includes("seedance")) { assert.equal(body.seed, undefined); assert.equal(body.prompt_expansion_enable, undefined); }
      const before = posts;
      await sirayAdapter.resume!(request, ctx, "task-1"); assert.equal(posts, before, "resume must never resubmit");
      console.log(`PASS ${spec.model} ${op}: submit, adopt, poll, persist, resume`);
    }
    if (image) assert.deepEqual(opsOf(spec), ["image_to_image"]);
  }
  image = true;
  const request: GenerationRequest = { spec: models[0]!, provider, op: "image_to_image", prompt: "Edit", params: { size: "1024x1024" }, sources: [source] };
  failure = true;
  await assert.rejects(sirayAdapter.run(request, ctx), /provider rejected parameters/);
  failure = false; missingId = true;
  const before = posts;
  await assert.rejects(sirayAdapter.run(request, ctx), (e: any) => e.code === "delivery_unknown");
  assert.equal(posts, before + 1, "uncertain submit must not retry");
  await assert.rejects(sirayAdapter.run({ ...request, sources: Array(11).fill(source) }, ctx), /source count/);
  console.log("PASS failure, uncertain delivery, source limits, edit-only capabilities and no credential forwarding");
  missingId = false;
  const { Jobs } = await import("../src/server/generation/jobs.ts");
  const { SecretVault } = await import("../src/server/crypto/secrets.ts");
  const { saveImageBytes } = await import("../src/server/images.ts");
  const vault = new SecretVault(store, Buffer.alloc(32, 7)); vault.set("provider:siray", "test-only");
  const asset = await saveImageBytes(store, png, { mime: "image/png", provider: "fixture" });
  const owned = store.createJob({ kind: "image", op: "image_to_image", modelId: models[0]!.id, modelName: models[0]!.name, params: { prompt: "Edit", size: "1024x1024" }, sources: [asset] });
  store.markJobRunning(owned.id); store.setJobProviderId(owned.id, "task-1");
  const queue = new Jobs(store, vault), postCount = posts;
  assert.equal(queue.recover().rejoined, 1);
  const completed = await queue.await(owned.id);
  assert.equal(completed.status, "succeeded", completed.error ?? ""); assert.equal(posts, postCount);
  await queue.close();
  console.log("PASS actual job queue recovers asynchronous image without another POST");
} finally {
  clearInterval(keepAlive); globalThis.fetch = originalFetch; db.close(); fs.rmSync(root, { recursive: true, force: true });
}
