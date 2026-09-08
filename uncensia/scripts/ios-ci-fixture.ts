/**
 * Hermetic live server for native iOS acceptance.
 *
 * It deliberately requires an empty, explicit fixture directory. The server,
 * vault, SQLite files, skills and uploaded document all stay under that path;
 * a developer's real `data/` directory is never opened. The process remains
 * alive after setup so an iOS Simulator can exercise the actual HTTP API,
 * streaming Runtime and persisted transcript.
 *
 *   UNCENSIA_IOS_FIXTURE_DIR=/tmp/uncensia-ios-fixture \
 *   node --import tsx scripts/ios-ci-fixture.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IOS_CI_VIDEO_BASE64 } from "./fixtures/ios-ci-video.ts";
import { startOpenAiStub } from "./stub-openai.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fixtureInput = process.env.UNCENSIA_IOS_FIXTURE_DIR?.trim();

if (!fixtureInput) {
  throw new Error("Set UNCENSIA_IOS_FIXTURE_DIR to a new empty directory. Refusing to use the real Uncensia data directory.");
}

const fixtureRoot = path.resolve(fixtureInput);
const realData = path.resolve(root, "data");
if (fixtureRoot === root || fixtureRoot === realData || realData.startsWith(`${fixtureRoot}${path.sep}`)) {
  throw new Error(`Unsafe UNCENSIA_IOS_FIXTURE_DIR: ${fixtureRoot}`);
}
if (fs.existsSync(fixtureRoot) && fs.readdirSync(fixtureRoot).length) {
  throw new Error(`Fixture directory must be empty: ${fixtureRoot}`);
}
fs.mkdirSync(fixtureRoot, { recursive: true });

const port = Number(process.env.UNCENSIA_IOS_FIXTURE_PORT ?? 18090);
if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error(`Invalid fixture port: ${port}`);

const accessCode = process.env.UNCENSIA_IOS_FIXTURE_CODE?.trim() || "IOS-CI-ACCEPTANCE";
const base = `http://127.0.0.1:${port}/v1`;
const conversationTitle = process.env.UNCENSIA_IOS_FIXTURE_CONVERSATION?.trim() || "流式测试";
const performanceTitle = process.env.UNCENSIA_IOS_FIXTURE_PERFORMANCE_CONVERSATION?.trim() || "性能基准长对话";
const readyFile = path.join(fixtureRoot, "ready.json");

process.env.UNCENSIA_ROOT = root;
process.env.UNCENSIA_DATA_DIR = path.join(fixtureRoot, "data");
process.env.UNCENSIA_HOST = "127.0.0.1";
process.env.UNCENSIA_PORT = String(port);
process.env.UNCENSIA_ACCESS_CODE = accessCode;

interface Reply<T> {
  status: number;
  body: T;
}

let token = "";

async function call<T = Record<string, unknown>>(method: string, endpoint: string, body?: unknown): Promise<Reply<T>> {
  const response = await fetch(`${base}${endpoint}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as T) : ({} as T);
  return { status: response.status, body: parsed };
}

function expectStatus(reply: Reply<unknown>, expected: number, operation: string) {
  if (reply.status !== expected) {
    throw new Error(`${operation} returned ${reply.status}: ${JSON.stringify(reply.body)}`);
  }
}

async function waitForHealth() {
  let last = "no response";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Uncensia fixture did not become healthy: ${last}`);
}

async function waitForRun(runId: string) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const run = await call<{ status: string; error?: string | null }>("GET", `/runs/${runId}`);
    expectStatus(run, 200, `read run ${runId}`);
    if (run.body.status === "completed") return;
    if (["failed", "cancelled"].includes(run.body.status)) {
      throw new Error(`Fixture run ${runId} ${run.body.status}: ${run.body.error ?? "no error"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Fixture run ${runId} did not finish within 60 seconds`);
}

async function uploadVideoFixture() {
  const form = new FormData();
  form.set(
    "file",
    new File([new Uint8Array(Buffer.from(IOS_CI_VIDEO_BASE64, "base64"))], "ios-ci-playback.mp4", {
      type: "video/mp4",
    }),
  );
  const response = await fetch(`${base}/files`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as { id?: string }) : {};
  if (response.status !== 201 || !body.id?.startsWith("vid_")) {
    throw new Error(`upload video fixture returned ${response.status}: ${text}`);
  }
  return body.id;
}

async function createSettledConversation(title: string, prompt: string, attachments: string[] = []) {
  const created = await call<{ id: string }>("POST", "/conversations", {
    modelId: "ios-ci-stub-chat",
    title,
  });
  expectStatus(created, 201, `create conversation ${title}`);
  const started = await call<{ runId: string }>("POST", `/conversations/${created.body.id}/runs`, {
    text: prompt,
    attachments,
  });
  expectStatus(started, 202, `start conversation ${title}`);
  await waitForRun(started.body.runId);
  // First-turn title generation runs in parallel and intentionally renames a
  // conversation. Restore the stable fixture title only after it settles.
  const renamed = await call("PATCH", `/conversations/${created.body.id}`, { title });
  expectStatus(renamed, 200, `restore conversation title ${title}`);
  return created.body.id;
}

const stub = await startOpenAiStub(0);
try {
  // Environment variables above must be set before this import: env.ts reads
  // them once at module initialization.
  await import("../src/server/main.ts");
  await waitForHealth();

  const login = await call<{ token: string }>("POST", "/auth/token", {
    accessCode,
    deviceName: "iOS CI fixture",
  });
  expectStatus(login, 200, "fixture login");
  token = login.body.token;
  if (!token) throw new Error("Fixture login returned no token");

  const provider = await call("POST", "/providers", {
    id: "ios-ci-stub",
    name: "iOS CI stub",
    baseUrl: `${stub.url}/v1`,
    auth: { style: "none" },
    enabled: true,
  });
  expectStatus(provider, 201, "create fixture provider");

  const model = await call("POST", "/models", {
    id: "ios-ci-stub-chat",
    providerId: "ios-ci-stub",
    name: "iOS CI stub chat",
    model: "stub-chat",
    enabled: true,
    apiMode: "openai-chat",
    kind: "chat",
    input: ["text"],
  });
  expectStatus(model, 201, "create fixture model");
  expectStatus(await call("PUT", "/models/default", { modelId: "ios-ci-stub-chat" }), 200, "set fixture default model");

  const catalogue = await call<{ items: Array<{ id: string; kind?: string; enabled: boolean }> }>("GET", "/models");
  expectStatus(catalogue, 200, "list fixture models");
  for (const entry of catalogue.body.items) {
    if ((entry.kind ?? "chat") === "chat" && entry.id !== "ios-ci-stub-chat" && entry.enabled) {
      expectStatus(await call("PATCH", `/models/${entry.id}`, { enabled: false }), 200, `disable ${entry.id}`);
    }
  }

  const note = await call<{ id: string }>("POST", "/files/notes", {
    name: "ios-ui-fixture.md",
    text: "# iOS UI fixture\n\nThis document proves that attachment bytes, metadata and authorization survive a settled turn.",
  });
  expectStatus(note, 201, "create attachment fixture");

  const conversationId = await createSettledConversation(
    conversationTitle,
    "请确认附件已收到，并用一句话说明它是 iOS UI 验收夹具。",
    [note.body.id],
  );
  const performanceConversationId = await createSettledConversation(
    performanceTitle,
    "写一篇 2000 字的关于分布式系统一致性的长文。",
  );
  const videoId = await uploadVideoFixture();

  const ready = {
    host: `http://127.0.0.1:${port}`,
    code: accessCode,
    conversation: conversationTitle,
    performanceConversation: performanceTitle,
    conversationId,
    performanceConversationId,
    videoId,
    dataDir: process.env.UNCENSIA_DATA_DIR,
    stub: stub.url,
  };
  fs.writeFileSync(readyFile, `${JSON.stringify(ready, null, 2)}\n`, "utf8");
  console.log(`IOS_FIXTURE_READY ${readyFile}`);
  await new Promise<never>(() => undefined);
} catch (error) {
  await stub.close();
  throw error;
}
