/** Real Pi extension + Runtime + HTTP acceptance. Temporary state and local
 * model only; never opens the deployment's data, extensions or credentials. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { startOpenAiStub } from "./stub-openai.ts";
import type { AgentLoop, LoopEvent } from "../src/server/agent/loop.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "uncensia-harness-host-"));
process.env.UNCENSIA_DATA_DIR = sandbox;
process.env.UNCENSIA_ACCESS_CODE = "HARNESSFIXTURECODE";
const extensionDir = path.join(sandbox, "agent", "extensions");
fs.mkdirSync(extensionDir, { recursive: true });
const journal = path.join(sandbox, "fixture-events.jsonl");
const modesFile = path.join(sandbox, "fixture-modes.json");
const releaseFile = path.join(sandbox, "release-startup");
const queueReleaseFile = path.join(sandbox, "release-queue");
const lifecycleReleaseFile = path.join(sandbox, "release-lifecycle");
const modes: Record<string, string> = {};
const pixelBytes = await sharp({ create: { width: 32, height: 32, channels: 3, background: "red" } }).png().toBuffer();
const pixelBase64 = pixelBytes.toString("base64");
function fixtureSkill(directory: string, name: string, body: string, userOnly = false) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "SKILL.md");
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: Harness fixture skill.\ncontexts: [roleplay, visual-continuity]\n${userOnly ? "disable-model-invocation: true\n" : ""}---\n${body}\n`);
  return file;
}
const projectSkill = fixtureSkill(path.join(sandbox, ".pi", "skills", "fixture-project"), "fixture-project", "PROJECT_SKILL_PROCEDURE");
fixtureSkill(path.join(sandbox, "skills", "fixture-uncensia"), "fixture-uncensia", "UNCENSIA_SKILL_PROCEDURE");
fixtureSkill(path.join(sandbox, "skills", "fixture-user"), "fixture-user", "USER_ONLY_PROCEDURE", true);
const extensionSkill = fixtureSkill(path.join(sandbox, "extension-resources", "fixture-extension"), "fixture-extension", "EXTENSION_SKILL_PROCEDURE");
fs.writeFileSync(modesFile, "{}");
fs.writeFileSync(path.join(extensionDir, "host-fixture.ts"), `
import fs from 'node:fs';
const journal = ${JSON.stringify(journal)};
const modesFile = ${JSON.stringify(modesFile)};
const releaseFile = ${JSON.stringify(releaseFile)};
const queueReleaseFile = ${JSON.stringify(queueReleaseFile)};
const lifecycleReleaseFile = ${JSON.stringify(lifecycleReleaseFile)};
const record = (event, ctx) => fs.appendFileSync(journal, JSON.stringify({event, id: ctx.sessionManager.getSessionId()}) + '\\n');
const text = value => ({content:[{type:'text',text:value}],details:{}});
export default function(pi) {
  let mode = '';
  pi.on('resources_discover', () => ({skillPaths:[${JSON.stringify(path.dirname(extensionSkill))}]}));
  pi.on('session_start', async (_event, ctx) => {
    mode = JSON.parse(fs.readFileSync(modesFile, 'utf8'))[ctx.sessionManager.getSessionId()] || '';
    record('startup', ctx);
    if (mode === 'startup-custom') {
      pi.sendMessage({customType:'fixture.startup',content:'fixture visible startup',display:true}, {triggerTurn:false});
      pi.sendMessage({customType:'fixture.hidden',content:'fixture hidden startup',display:false}, {triggerTurn:false});
    }
    if (mode === 'startup-error') throw new Error('fixture startup failure');
    if (mode === 'slow-start' || mode === 'lifecycle-start') {
      record('preparing', ctx);
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(mode === 'lifecycle-start' ? lifecycleReleaseFile : releaseFile)) {
        if (Date.now() > deadline) throw new Error('fixture startup gate timed out');
        await new Promise(r => setTimeout(r, 10));
      }
    }
  });
  pi.on('session_shutdown', async (event, ctx) => {
    record('cleanup-start', ctx);
    await new Promise(r => setTimeout(r, 20));
    pi.appendEntry('fixture.cleanup', {reason:event.reason});
    record('cleanup-end', ctx);
    if (mode === 'cleanup-error') throw new Error('fixture cleanup failure');
  });
  pi.registerCommand('host-error', {description:'Fixture exception', handler: async () => { throw new Error('fixture command exploded'); }});
  pi.registerCommand('host-ui', {description:'Exercise the limited RPC UI', handler: async (_args, ctx) => {
    if (!ctx.hasUI || ctx.mode !== 'rpc') throw new Error('fixture requires RPC UI binding');
    ctx.ui.notify('fixture notification', 'warning');
    ctx.ui.setStatus('fixture-status', 'fixture working');
    ctx.ui.setStatus('fixture-status', undefined);
  }});
  pi.registerCommand('host-action', {description:'Exercise host bindings', handler: async (action, ctx) => {
    if (action.startsWith('ui.')) await ctx.ui[action.slice(3)]('fixture', []);
    else await ctx[action]('fixture');
  }});
  pi.registerTool({name:'fixture_hold',label:'Fixture hold',description:'Wait for cancellation',parameters:{type:'object',properties:{}},
    execute: async (_id, _args, signal, _update, ctx) => {
      record('tool-start', ctx);
      await new Promise(resolve => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener('abort', () => resolve(), {once:true});
      });
      record('tool-stopped', ctx);
      return text('Fixture stopped');
    }
  });
  pi.registerTool({name:'fixture_progress',label:'Fixture progress',description:'Emit partial output',parameters:{type:'object',properties:{}},
    execute: async (_id, _args, _signal, update) => {
      const image = {type:'image',mimeType:'image/png',data:${JSON.stringify(pixelBase64)}};
      update({content:[{type:'text',text:'fixture partial output'},image],details:{preview:image,step:1}});
      return text('Fixture progress complete');
    }
  });
  pi.registerTool({name:'fixture_queue',label:'Fixture queue',description:'Wait for queued messages',parameters:{type:'object',properties:{}},
    execute: async (_id, _args, _signal, _update, ctx) => {
      record('queue-wait', ctx);
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(queueReleaseFile)) {
        if (Date.now() > deadline) throw new Error('fixture queue gate timed out');
        await new Promise(r => setTimeout(r, 10));
      }
      return text('Queue released');
    }
  });
}
`);

let imageId = "";
const stub = await startOpenAiStub(0, (body) => {
  const content = JSON.stringify(body.messages);
  if (content.includes("QUEUE_SKILL_FIXTURE") && !body.messages?.some(message => message.role === "tool")) return { kind: "tool", name: "fixture_queue", args: {} };
  if (content.includes("HOLD_FIXTURE")) return { kind: "tool", name: "fixture_hold", args: {} };
  if (content.includes("APPROVAL_FIXTURE")) return { kind: "tool", name: "bash", args: { command: "echo fixture-must-not-execute" } };
  if (content.includes("PROGRESS_FIXTURE") && !body.messages?.some(message => message.role === "tool")) return { kind: "tool", name: "fixture_progress", args: {} };
  if (content.includes("READ_PROJECT_SKILL") && !body.messages?.some(message => message.role === "tool")) return { kind: "tool", name: "read", args: { path: projectSkill } };
  if (content.includes("READ_EXTENSION_SKILL") && !body.messages?.some(message => message.role === "tool")) return { kind: "tool", name: "read", args: { path: extensionSkill } };
  if (content.includes("INSPECT_SAVED_IMAGE") && !body.messages?.some(message => message.role === "tool")) {
    return { kind: "tool", name: "view_image", args: { intent: "Inspect saved image", image_id: imageId } };
  }
  return { kind: "text", text: "Fixture answer" };
});
const { createServices } = await import("../src/server/services.ts");
const { createApp } = await import("../src/server/http/app.ts");
const { saveImageBytes } = await import("../src/server/images.ts");
const { createPiLoop } = await import("../src/server/agent/loop.ts");
const directLoops = new Set<AgentLoop>();
const services = createServices();
const app = createApp(services);
let closed = false;
let auth = "";
const events: Array<{ runId: string; type: string; data: unknown }> = [];
const observerFailures: string[] = [];
const records = () => fs.existsSync(journal)
  ? fs.readFileSync(journal, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { id: string; event: string })
  : [];
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function call(method: string, url: string, body?: unknown) {
  return app.request(`/v1${url}`, {
    method, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function conversation(mode = "", modelId = "fixture-chat") {
  const item = services.store.createConversation(modelId, "Harness fixture");
  modes[item.id] = mode;
  fs.writeFileSync(modesFile, JSON.stringify(modes));
  services.bus.subscribe(item.id, event => {
    if (["run.completed", "run.failed", "run.cancelled"].includes(event.type)) {
      // The terminal event must follow awaited extension cleanup.
      const entry = records().filter(record => record.id === item.id);
      if (entry.some(record => record.event === "startup")) {
        if (entry.at(-1)?.event !== "cleanup-end") observerFailures.push(`Terminal before cleanup: ${event.runId}`);
      }
    }
    events.push(event);
  });
  return item;
}
async function run(text: string, mode = "", modelId = "fixture-chat", existing?: ReturnType<typeof conversation>) {
  const item = existing ?? conversation(mode, modelId);
  const response = await call("POST", `/conversations/${item.id}/runs`, { text });
  assert.equal(response.status, 202);
  const { runId } = await response.json() as { runId: string };
  await until(() => !services.runtime.isActive(item.id), `run ${text}`);
  const result = services.store.getRun(runId)!;
  const terminal = services.store.eventsSince(runId, -1).filter(event => event.type.startsWith("run.") && event.type !== "run.started");
  assert.equal(terminal.length, 1, "exactly one durable terminal event");
  assert.equal(events.filter(event => event.runId === runId && event.type === terminal[0]!.type).length, 1, "terminal event reached clients after cleanup");
  assert.deepEqual(observerFailures, []);
  return { item, result, terminal };
}
try {
  const login = await call("POST", "/auth/token", { accessCode: "HARNESSFIXTURECODE", deviceName: "harness-audit" });
  assert.equal(login.status, 200);
  auth = (await login.json() as { token: string }).token;
  services.store.upsertProvider({ id: "fixture", name: "fixture", baseUrl: stub.url + "/v1", auth: { style: "none" }, enabled: true });
  for (const [id, input] of [["fixture-chat", ["text", "image"]], ["fixture-text", ["text"]]] as const) {
    services.store.upsertModel({ id, providerId: "fixture", model: id, name: id, apiMode: "openai-chat", kind: "chat", enabled: true, pinned: false, reasoning: false, input: [...input], contextWindow: 32000, maxTokens: 2000, thinkingLevel: "off" });
  }
  services.config.saveCapabilities({ coding: { read: false, write: false, shell: true, workspace: sandbox } });
  services.config.savePrompts({ titleEnabled: false });
  services.reload();

  async function directLoop(mode = "") {
    const item = conversation(mode);
    const { model } = services.registry.resolve("fixture-chat");
    const loop = await createPiLoop({
      manager: await services.sessions.session(item.id), workspace: sandbox,
      providers: services.registry.runtime.getProviders(), model,
      systemPrompt: "Isolated host lifecycle fixture", thinkingLevel: "off", tools: [],
      persist: message => message, onExtensionEvent: () => undefined,
      transformContext: async messages => messages, onPayload: payload => payload,
      beforeToolCall: async () => undefined,
    });
    directLoops.add(loop);
    return { loop, item };
  }
  for (const mode of ["startup-custom", "cleanup-error"]) {
    const { loop, item } = await directLoop(mode);
    // Instrument only the public subscription API. Pi dispose disconnects its
    // own listener, so the host must explicitly remove its raw-Agent listeners.
    let rawSubscriptions = 0;
    const subscribe = loop.sdk!.agent.subscribe.bind(loop.sdk!.agent);
    loop.sdk!.agent.subscribe = listener => {
      rawSubscriptions++;
      const remove = subscribe(listener);
      let active = true;
      return () => { if (active) { active = false; rawSubscriptions--; remove(); } };
    };
    const received: LoopEvent[] = [];
    const listener = (event: LoopEvent) => { received.push(event); };
    const remove = loop.subscribe(listener);
    assert.equal(loop.subscribe(listener), remove, "same listener must not create duplicate subscriptions");
    assert.equal(rawSubscriptions, 1);
    await loop.initialize!();
    if (mode === "startup-custom") assert.equal(received.filter(event => event.type === "message_end").length, 2);
    if (typeof remove === "function") { remove(); remove(); }
    assert.equal(rawSubscriptions, 0);
    const detachedCount = received.length;
    await loop.prompt("Unsubscribed fixture", []);
    assert.equal(received.length, detachedCount, "removed run listener cannot observe later messages");
    loop.subscribe(listener);
    const cleanup = loop.dispose!();
    assert.equal(loop.dispose!(), cleanup, "dispose returns the same drain promise");
    for (const action of [() => loop.initialize!(), () => loop.prompt("CLOSED_MUST_NOT_REACH_MODEL", []), () => loop.continue(), () => loop.steer("closed"), () => loop.followUp("closed"), () => loop.subscribe(listener)]) {
      assert.throws(action, /closing or disposed/);
    }
    if (mode === "cleanup-error") await assert.rejects(Promise.resolve(cleanup), /fixture cleanup failure/);
    else await cleanup;
    assert.equal(rawSubscriptions, 0, "cleanup must detach even when shutdown throws");
    assert.equal(records().filter(row => row.id === item.id && row.event === "cleanup-end").length, 1);
    directLoops.delete(loop);
  }
  const preparingHost = await directLoop("lifecycle-start");
  const waitingPrompt = preparingHost.loop.prompt("DISPOSING_STARTUP_MUST_NOT_REACH_MODEL", []);
  const promptOutcome = Promise.allSettled([waitingPrompt]);
  await until(() => records().some(row => row.id === preparingHost.item.id && row.event === "preparing"), "direct host startup gate");
  let hostDrained = false;
  const drainHost = Promise.resolve(preparingHost.loop.dispose!()).then(() => { hostDrained = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(hostDrained, false, "dispose must await admitted startup work");
  fs.writeFileSync(lifecycleReleaseFile, "release lifecycle fixture");
  await drainHost;
  assert.equal((await promptOutcome)[0]!.status, "rejected", "prompt admitted before close cannot start after initialization finishes");
  assert(!JSON.stringify(stub.requests).includes("DISPOSING_STARTUP_MUST_NOT_REACH_MODEL"));
  assert(!JSON.stringify(stub.requests).includes("CLOSED_MUST_NOT_REACH_MODEL"));
  directLoops.delete(preparingHost.loop);
  stub.requests.length = 0;
  console.log("PASS lifecycle prerequisite: sealed admission, awaited startup, idempotent cleanup, deduplicated subscriptions and explicit detach on shutdown failure");

  const failed = await run("/host-error");
  assert.equal(failed.result.status, "failed");
  assert.match(failed.result.error!, /Extension command failed.*fixture command exploded/);
  assert.match(JSON.stringify(failed.terminal), /fixture command exploded/);
  const failedReplay = await (await call("GET", `/runs/${failed.result.id}/events`)).text();
  assert.match(failedReplay, /event: run.failed/);
  assert.match(failedReplay, /fixture command exploded/);
  assert(!failedReplay.includes("event: run.completed"));
  assert.equal(stub.requests.length, 0, "commands must not fall through to the model");
  console.log("PASS real extension command errors persist and stream run.failed");

  const unsupported = ["newSession", "fork", "navigateTree", "switchSession", "reload", "shutdown",
    ...["select", "confirm", "input", "editor", "custom", "onTerminalInput", "setWorkingMessage", "setWorkingVisible", "setWorkingIndicator", "setHiddenThinkingLabel", "setWidget", "setFooter", "setHeader", "setTitle", "pasteToEditor", "setEditorText", "getEditorText", "addAutocompleteProvider", "setEditorComponent", "getEditorComponent", "getAllThemes", "getTheme", "setTheme", "getToolsExpanded", "setToolsExpanded"].map(name => `ui.${name}`)];
  for (const action of unsupported) {
    const { item, result } = await run(`/host-action ${action}`);
    assert.equal(result.status, "failed", action);
    assert.match(result.error!, /Uncensia harness does not support/);
    assert(result.error!.includes(action), result.error!);
    assert.equal(services.store.pendingApprovals(item.id).length, 0, "arbitrary UI must not become tool approval");
  }
  assert.equal((await run("/host-action waitForIdle")).result.status, "completed");
  assert.equal((await run("/host-action abort")).result.status, "cancelled");
  console.log(`PASS ${unsupported.length} unsupported host actions fail explicitly; waitForIdle and host abort work`);
  const uiRun = await run("/host-ui");
  assert.equal(uiRun.result.status, "completed");
  const uiEvents = services.store.eventsSince(uiRun.result.id, -1);
  assert.deepEqual(uiEvents.find(event => event.type === "agent.extension_notify")?.data, { message: "fixture notification", level: "warning" });
  assert.deepEqual(uiEvents.filter(event => event.type === "agent.extension_status").map(event => event.data), [{ key: "fixture-status", text: "fixture working" }, { key: "fixture-status" }]);
  assert(events.some(event => event.runId === uiRun.result.id && event.type === "agent.extension_notify"));
  const uiReplay = await (await call("GET", `/runs/${uiRun.result.id}/events`)).text();
  assert.match(uiReplay, /event: agent.extension_notify/);
  assert.match(uiReplay, /event: agent.extension_status/);
  console.log("PASS ctx.hasUI denotes actual RPC notification/status delivery, including status clearing");

  const startupCustom = await run("/host-action waitForIdle", "startup-custom");
  assert.equal(startupCustom.result.status, "completed");
  const customRows = services.store.storedMessages(startupCustom.item.id);
  assert.equal(customRows.length, 2, "startup custom messages must project exactly once");
  const customEvents = services.store.eventsSince(startupCustom.result.id, -1).filter(event => event.type === "message.end");
  assert.equal(customEvents.length, 2, "startup custom messages must emit exactly once");
  assert(customRows.some(row => JSON.stringify(row.content).includes('"display":false')), "hidden messages retain their display flag");
  const customReplay = await (await call("GET", `/runs/${startupCustom.result.id}/events`)).text();
  assert.match(customReplay, /fixture visible startup/);
  assert.match(customReplay, /fixture hidden startup/);
  assert.equal(customReplay.split("event: message.end").length - 1, 2);
  console.log("PASS startup SDK custom messages project and replay exactly once, preserving display flags");

  for (const mode of ["startup-error", "cleanup-error"]) {
    const { item, result } = await run("/host-action waitForIdle", mode);
    assert.equal(result.status, "failed", mode);
    assert.match(result.error!, /fixture (startup|cleanup) failure/);
    assert.equal(records().filter(record => record.id === item.id && record.event === "cleanup-end").length, 1);
  }
  const dualFailure = await run("/host-error", "cleanup-error");
  assert.match(dualFailure.result.error!, /fixture command exploded/);
  assert.match(dualFailure.result.error!, /fixture cleanup failure/);
  const healthy = await run("Ordinary fixture prompt");
  assert.equal(healthy.result.status, "completed");
  const second = services.store.createRun(healthy.item.id, "fixture-chat");
  await services.runtime.start(second.id, healthy.item.id, { message: "/host-action waitForIdle" });
  assert.equal(services.store.getRun(second.id)?.status, "completed");
  assert.equal(records().filter(record => record.id === healthy.item.id && record.event === "cleanup-end").length, 2);
  assert.equal((await services.sessions.session(healthy.item.id)).getEntries().filter(entry => entry.type === "custom" && entry.customType === "fixture.cleanup").length, 2);
  console.log("PASS startup/cleanup errors fail visibly; two runs await and persist one cleanup each");

  const brokenExtension = path.join(extensionDir, "broken.ts");
  fs.writeFileSync(brokenExtension, "export default function() { throw new Error('fixture extension load failure'); }");
  const broken = await run("must not reach model");
  assert.equal(broken.result.status, "failed");
  assert.match(broken.result.error!, /Extension loading failed.*fixture extension load failure/);
  fs.unlinkSync(brokenExtension);
  console.log("PASS extension load failures cannot produce a successful run");

  const progress = await run("PROGRESS_FIXTURE");
  assert.equal(progress.result.status, "completed");
  const progressEvents = services.store.eventsSince(progress.result.id, -1);
  const update = progressEvents.find(event => event.type === "tool.execution.update");
  assert(update, "partial output must be persisted for replay");
  const updateData = update.data as { toolCallId: string; toolCallIndex: number; partialResult: { content: Array<{ type: string; text?: string }>; details: { preview: { type: string }; step: number } } };
  assert.equal(updateData.partialResult.content[0]?.text, "fixture partial output");
  assert.equal(updateData.partialResult.content[1]?.type, "image_omitted");
  assert.equal(updateData.partialResult.details.preview.type, "image_omitted");
  assert.equal(updateData.partialResult.details.step, 1);
  const startData = progressEvents.find(event => event.type === "tool.execution.start")!.data as { toolCallId: string; toolCallIndex: number };
  assert.equal(updateData.toolCallId, startData.toolCallId);
  assert.equal(updateData.toolCallIndex, startData.toolCallIndex);
  assert(events.some(event => event.runId === progress.result.id && event.type === "tool.execution.update"), "live clients must receive the partial update");
  assert(!JSON.stringify(progressEvents).includes(pixelBase64), "event persistence must never retain raw pixels");
  assert(!JSON.stringify(events).includes(pixelBase64), "live event transport must never expose raw pixels");
  const progressReplay = await (await call("GET", `/runs/${progress.result.id}/events`)).text();
  assert.match(progressReplay, /event: tool.execution.update/);
  assert.match(progressReplay, /fixture partial output/);
  assert(!progressReplay.includes(pixelBase64), "HTTP SSE replay must never expose raw pixels");
  console.log("PASS partial tool output reaches live events and replay with stable IDs; nested raw pixels are stripped");

  imageId = await saveImageBytes(services.store, pixelBytes, { mime: "image/png", provider: "fixture", model: "fixture" });
  services.store.upsertMemory("saved_image", `Saved image ID: ${imageId}`, 30);
  stub.requests.length = 0;
  const vision = await run("INSPECT_SAVED_IMAGE");
  assert.equal(vision.result.status, "completed");
  assert(stub.requests[0]?.tools?.some(tool => tool.function?.name === "view_image"), "fresh conversation must offer view_image");
  assert(JSON.stringify(stub.requests[0]?.messages).includes(imageId), "saved memory must supply the exact image ID to the model");
  assert(stub.requests.some(request => request.messages?.some(message => message.role === "tool") && JSON.stringify(request.messages).includes("data:image/")), "saved image pixels must reach provider on tool round trip");
  assert(!JSON.stringify(services.store.storedMessages(vision.item.id)).includes("base64,"), "persist refs, not pixels");
  const repeatedImage = conversation();
  const attachedImageResponse = await call("POST", `/conversations/${repeatedImage.id}/runs`, { text: "Keep this reference", attachments: [imageId] });
  assert.equal(attachedImageResponse.status, 202);
  await until(() => !services.runtime.isActive(repeatedImage.id), "attached image turn");
  stub.requests.length = 0;
  assert.equal((await run("INSPECT_SAVED_IMAGE", "", "fixture-chat", repeatedImage)).result.status, "completed");
  const pixelRequest = stub.requests.at(-1)!;
  assert.equal((JSON.stringify(pixelRequest.messages).match(/data:image\//g) ?? []).length, 1, "inspecting an earlier attachment must not also hydrate every historical copy");
  assert(JSON.stringify(services.store.storedMessages(repeatedImage.id)).split(imageId).length > 2, "pixel deduplication must preserve historical image references");
  stub.requests.length = 0;
  assert.equal((await run("Text fixture", "", "fixture-text")).result.status, "completed");
  assert(!stub.requests[0]?.tools?.some(tool => tool.function?.name === "view_image"));
  console.log("PASS fresh vision conversation inspects exact image ID from memory; text model has no view_image");

  function skillConversation() {
    const item = conversation();
    services.store.setConversationRoleplay(item.id, { enabled: true, character: "HOST_RP_CONTEXT", persona: "", world: "", scene: "", style: "" });
    services.store.setConversationVisualContinuity(item.id, { enabled: true, description: "HOST_VISUAL_CONTEXT", references: [{ imageId, role: "subject", label: "fixture subject" }], lastImageId: null, lastPrompt: "" });
    return item;
  }
  for (const [message, marker] of [["READ_PROJECT_SKILL", "PROJECT_SKILL_PROCEDURE"], ["READ_EXTENSION_SKILL", "EXTENSION_SKILL_PROCEDURE"]]) {
    const item = skillConversation();
    stub.requests.length = 0;
    assert.equal((await run(message!, "", "fixture-chat", item)).result.status, "completed");
    const system = JSON.stringify(stub.requests[0]?.messages?.filter(row => row.role === "system"));
    for (const name of ["fixture-project", "fixture-uncensia", "fixture-extension"]) assert(system.includes(name), `effective catalog missing ${name}`);
    assert.equal(system.split("<available_skills>").length - 1, 1);
    assert(!system.includes("fixture-user"), "user-only skill must remain hidden from model catalog");
    assert(!system.includes("HOST_RP_CONTEXT") && !system.includes("HOST_VISUAL_CONTEXT"), "saved state must not be preloaded");
    const toolRequest = stub.requests.find(request => request.messages?.some(row => row.role === "tool"));
    assert(JSON.stringify(toolRequest?.messages).includes(marker!));
    assert(JSON.stringify(toolRequest?.messages).includes("HOST_RP_CONTEXT"));
    assert(JSON.stringify(toolRequest?.messages).includes("HOST_VISUAL_CONTEXT"));
    stub.requests.length = 0;
    await run("PLAIN_AFTER_SKILL", "", "fixture-chat", item);
    const next = JSON.stringify(stub.requests[0]?.messages);
    assert(next.includes(marker!) && next.includes("HOST_RP_CONTEXT"), "a new HTTP run must not discard a loaded procedure and its snapshot");
  }
  console.log("PASS SDK discovery drives one catalog, native read, preserving loaded procedures across turns");

  const explicit = skillConversation();
  stub.requests.length = 0;
  assert.equal((await run("/skill:fixture-user EXPLICIT_USER_TASK", "", "fixture-chat", explicit)).result.status, "completed");
  const firstExplicit = JSON.stringify(stub.requests[0]?.messages);
  assert(firstExplicit.includes("USER_ONLY_PROCEDURE") && firstExplicit.includes("HOST_RP_CONTEXT") && firstExplicit.includes("HOST_VISUAL_CONTEXT"));
  const durableExplicit = JSON.stringify(services.store.storedMessages(explicit.id));
  assert(durableExplicit.includes("USER_ONLY_PROCEDURE"), "SDK expansion must remain durable");
  assert(!durableExplicit.includes("HOST_RP_CONTEXT") && !durableExplicit.includes("HOST_VISUAL_CONTEXT"), "dynamic context must be model-facing only");
  const explicitUser = services.store.storedMessages(explicit.id).find(row => row.role === "user")!.content as { content: unknown; uncensiaSkillInvocation?: unknown };
  assert.deepEqual(explicitUser.uncensiaSkillInvocation, { name: "fixture-user", userMessage: "EXPLICIT_USER_TASK" });
  const explicitTree = await services.sessions.session(explicit.id);
  assert(JSON.stringify(explicitTree.getEntries()).includes('"uncensiaSkillInvocation"'), "presentation metadata must survive JSONL reprojection");
  assert(events.some(event => event.type === "message.end" && JSON.stringify(event.data).includes('"uncensiaSkillInvocation"')), "metadata reaches live user message events");
  stub.requests.length = 0;
  await run("Plain subsequent task", "", "fixture-chat", explicit);
  const expiredExplicit = JSON.stringify(stub.requests[0]?.messages);
  assert(expiredExplicit.includes("EXPLICIT_USER_TASK") && expiredExplicit.includes("USER_ONLY_PROCEDURE") && !expiredExplicit.includes("HOST_RP_CONTEXT"));
  assert.equal(JSON.stringify(services.store.storedMessages(explicit.id).slice(0, 2)), durableExplicit, "expiry must not rewrite the original transcript");

  const manager = await services.sessions.session(explicit.id);
  manager.appendMessage({ role: "user", content: "Old filler for compaction. ".repeat(12000), timestamp: Date.now() });
  const compactRun = services.store.createRun(explicit.id, "fixture-chat");
  stub.requests.length = 0;
  await services.runtime.start(compactRun.id, explicit.id, { message: "compact fixture", compact: true });
  assert.equal(services.store.getRun(compactRun.id)?.status, "completed");
  const compactInput = JSON.stringify(stub.requests.map(request => request.messages));
  assert(compactInput.includes("EXPLICIT_USER_TASK"));
  assert(!compactInput.includes("USER_ONLY_PROCEDURE") && !compactInput.includes("HOST_RP_CONTEXT"), "summaries must not bake expired skill procedures into later runs");
  stub.requests.length = 0;
  await run("/skill:fixture-user AFTER_COMPACTION_TASK", "", "fixture-chat", explicit);
  assert(JSON.stringify(stub.requests.at(-1)?.messages).includes("HOST_RP_CONTEXT"), "compaction must not expire the current explicit invocation");
  console.log("PASS explicit user-only /skill context, loaded history and compaction-boundary recovery");

  const queued = skillConversation();
  const queueRun = services.store.createRun(queued.id, "fixture-chat");
  const queueWork = services.runtime.start(queueRun.id, queued.id, { message: "QUEUE_SKILL_FIXTURE" });
  await until(() => records().some(row => row.id === queued.id && row.event === "queue-wait"), "queue fixture tool");
  await services.runtime.steer(queued.id, "/skill:fixture-user STEER_TASK");
  await services.runtime.followUp(queued.id, "/skill:fixture-project FOLLOWUP_TASK");
  fs.writeFileSync(queueReleaseFile, "release queued fixture");
  await queueWork;
  assert.equal(services.store.getRun(queueRun.id)?.status, "completed");
  const queuedUsers = services.store.storedMessages(queued.id).filter(row => row.role === "user").map(row => row.content) as Array<{ content: unknown; uncensiaSkillInvocation?: unknown }>;
  assert.deepEqual(queuedUsers.map(row => row.uncensiaSkillInvocation), [undefined,
    { name: "fixture-user", userMessage: "STEER_TASK" }, { name: "fixture-project", userMessage: "FOLLOWUP_TASK" }]);
  assert(JSON.stringify(queuedUsers[1]!.content).includes("USER_ONLY_PROCEDURE"));
  assert(JSON.stringify(queuedUsers[2]!.content).includes("PROJECT_SKILL_PROCEDURE"));
  const queueReplay = await (await call("GET", `/runs/${queueRun.id}/events`)).text();
  assert(queueReplay.includes('"uncensiaSkillInvocation"') && queueReplay.includes('"userMessage":"FOLLOWUP_TASK"'));

  const expanded = typeof explicitUser.content === "string" ? explicitUser.content : (explicitUser.content as Array<{ text?: string }>).find(part => part.text)?.text!;
  for (const [text, expected] of [
    [expanded, { name: "fixture-user", userMessage: "EXPLICIT_USER_TASK" }],
    [expanded.replace('name="fixture-user"', 'name="unknown-skill"'), undefined],
    [expanded.replace('location="', 'location="unknown/'), undefined],
    ["/skill:fixture-user", { name: "fixture-user", userMessage: "" }],
  ] as const) {
    const result = await run(text);
    const user = services.store.storedMessages(result.item.id).find(row => row.role === "user")!.content as { uncensiaSkillInvocation?: unknown };
    assert.deepEqual(user.uncensiaSkillInvocation, expected);
  }
  const attached = skillConversation();
  const attachedResponse = await call("POST", `/conversations/${attached.id}/runs`, { text: "/skill:fixture-user ATTACHED_TASK", attachments: [imageId] });
  assert.equal(attachedResponse.status, 202);
  await until(() => !services.runtime.isActive(attached.id), "attached skill invocation");
  const attachedUser = services.store.storedMessages(attached.id).find(row => row.role === "user")!.content as { content: unknown; uncensiaSkillInvocation?: unknown };
  assert.deepEqual(attachedUser.uncensiaSkillInvocation, { name: "fixture-user", userMessage: "ATTACHED_TASK" });
  assert(JSON.stringify(attachedUser.content).includes(imageId), "compact presentation must preserve attachment refs");
  assert(JSON.stringify(attachedUser.content).includes("USER_ONLY_PROCEDURE"));
  console.log("PASS skill display metadata: exact effective name/path, pasted wrapper, empty arguments, steering/follow-up and SSE; durable procedures unchanged");

  // These are the freshness invariants a future conversation cache must keep.
  // They deliberately verify the current rebuild policy, not instance reuse.
  const fresh = conversation();
  const originalModel = services.store.getModel("fixture-chat")!;
  const before = await run("BRANCH_BASE_FRESHNESS", "", "fixture-chat", fresh);
  const savedLeaf = (await services.sessions.session(fresh.id)).getLeafId();
  const originalEvents = JSON.stringify(services.store.eventsSince(before.result.id, -1));
  services.store.upsertModel({ ...originalModel, temperature: 0.17, topP: 0.41 });
  services.config.saveCapabilities({ coding: { read: false, write: false, shell: false, workspace: sandbox } });
  services.reload();
  stub.requests.length = 0;
  const after = await run("BRANCH_TAIL_FRESHNESS", "", "fixture-chat", fresh);
  assert.equal(after.result.status, "completed");
  const changedPayload = stub.requests[0] as unknown as Record<string, unknown>;
  assert.equal(changedPayload.model, "fixture-chat");
  assert.equal(changedPayload.temperature, 0.17);
  assert.equal(changedPayload.top_p, 0.41);
  assert(!stub.requests[0]!.tools?.some(tool => tool.function?.name === "bash"), "revoked shell permission cannot survive into the next run");
  assert.equal(JSON.stringify(services.store.eventsSince(before.result.id, -1)), originalEvents, "new run cannot append events to its predecessor");
  stub.requests.length = 0;
  const changedModel = await call("POST", `/conversations/${fresh.id}/runs`, { text: "MODEL_CHANGE_FRESHNESS", modelId: "fixture-text" });
  assert.equal(changedModel.status, 202);
  await until(() => !services.runtime.isActive(fresh.id), "model change freshness");
  assert.equal((stub.requests[0] as unknown as Record<string, unknown>).model, "fixture-text");
  assert(!stub.requests[0]!.tools?.some(tool => tool.function?.name === "view_image"), "model change must refresh image capability");
  const forkResponse = await call("POST", `/conversations/${fresh.id}/fork`, { entryId: savedLeaf });
  assert.equal(forkResponse.status, 201);
  const forked = await forkResponse.json() as ReturnType<typeof conversation>;
  services.bus.subscribe(forked.id, event => { events.push(event); });
  stub.requests.length = 0;
  await run("FORK_FRESHNESS", "", "fixture-chat", forked);
  const branchPayload = JSON.stringify(stub.requests[0]?.messages);
  assert(branchPayload.includes("BRANCH_BASE_FRESHNESS"));
  assert(!branchPayload.includes("BRANCH_TAIL_FRESHNESS") && !branchPayload.includes("MODEL_CHANGE_FRESHNESS"), "fork must use selected tree context, not cached future history");
  const tail = services.store.storedMessages(fresh.id).find(row => row.role === "user" && JSON.stringify(row.content).includes("BRANCH_TAIL_FRESHNESS"))!;
  const treeBeforeRewind = (await services.sessions.session(fresh.id)).getEntries().map(entry => entry.id);
  stub.requests.length = 0;
  const rewindResponse = await call("POST", `/conversations/${fresh.id}/runs`, { text: "REWIND_FRESHNESS", fromSeq: tail.seq, modelId: "fixture-chat" });
  assert.equal(rewindResponse.status, 202);
  const rewindRun = await rewindResponse.json() as { runId: string };
  await until(() => !services.runtime.isActive(fresh.id), "same-conversation rewind freshness");
  assert.equal(services.store.getRun(rewindRun.runId)?.status, "completed");
  const rewindPayload = JSON.stringify(stub.requests[0]?.messages);
  assert(rewindPayload.includes("BRANCH_BASE_FRESHNESS") && rewindPayload.includes("REWIND_FRESHNESS"));
  assert(!rewindPayload.includes("BRANCH_TAIL_FRESHNESS") && !rewindPayload.includes("MODEL_CHANGE_FRESHNESS"), "same conversation must not replay the abandoned branch after rewind");
  const treeAfterRewind = new Set((await services.sessions.session(fresh.id)).getEntries().map(entry => entry.id));
  assert(treeBeforeRewind.every(id => treeAfterRewind.has(id)), "rewind must retain every original tree entry");
  assert.equal((stub.requests[0] as unknown as Record<string, unknown>).temperature, 0.17);
  assert(!stub.requests[0]!.tools?.some(tool => tool.function?.name === "bash"), "rewind cannot restore revoked permissions");
  services.store.upsertModel(originalModel);
  services.config.saveCapabilities({ coding: { read: false, write: false, shell: true, workspace: sandbox } });
  services.reload();
  console.log("PASS cross-run rebuild freshness: exact model parameters, revoked tools, model input capability, event ownership, HTTP fork and same-conversation rewind context");

  const holding = conversation();
  const approval = conversation();
  const preparing = conversation("slow-start");
  const background = conversation();
  const pendingRuns: Promise<void>[] = [];
  for (const [item, message] of [[holding, "HOLD_FIXTURE"], [approval, "APPROVAL_FIXTURE"], [preparing, "unused preparation prompt"]] as const) {
    const record = services.store.createRun(item.id, "fixture-chat");
    pendingRuns.push(services.runtime.start(record.id, item.id, { message }));
  }
  const task = services.store.createBackgroundTask({ conversationId: background.id, modelId: "fixture-chat", prompt: "HOLD_FIXTURE", runAt: Date.now() });
  services.background.wake();
  await until(() => records().some(record => record.id === holding.id && record.event === "tool-start") && records().some(record => record.id === background.id && record.event === "tool-start") && records().some(record => record.id === preparing.id && record.event === "preparing") && services.store.pendingApprovals(approval.id).length === 1, "tool, background, startup and approval waiting");
  // Also stop a run in pre-SDK preparation, immediately after admission.
  const admitted = conversation();
  const admittedRun = services.store.createRun(admitted.id, "fixture-chat");
  pendingRuns.push(services.runtime.start(admittedRun.id, admitted.id, { message: "PREPARATION_MUST_NOT_REACH_MODEL" }));
  const closing = services.close();
  assert.strictEqual(services.close(), closing, "service close must be idempotent");
  let drained = false;
  void closing.then(() => { drained = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(drained, false, "shutdown must wait for an unfinished startup hook");
  fs.writeFileSync(releaseFile, "release fixture startup");
  await Promise.race([closing, new Promise<never>((_resolve, reject) => { const timer = setTimeout(() => reject(new Error("shutdown did not drain")), 10_000); timer.unref(); })]);
  closed = true;
  await Promise.all(pendingRuns);
  assert.equal(services.runtime.activeCount(), 0);
  assert.deepEqual(observerFailures, []);
  assert(!JSON.stringify(stub.requests).includes("PREPARATION_MUST_NOT_REACH_MODEL"));
  await assert.rejects(services.runtime.start("rejected", holding.id, { message: "must not start" }), /shutting down/);
  for (const item of [holding, approval, preparing, background]) {
    assert.equal(records().filter(record => record.id === item.id && record.event === "cleanup-end").length, 1);
  }
  const db = new DatabaseSync(path.join(sandbox, "uncensia.sqlite"), { readOnly: true });
  try {
    for (const item of [holding, approval, preparing, admitted, background]) assert.equal(db.prepare("SELECT status FROM runs WHERE conversation_id=?").get(item.id)?.status, "cancelled");
    assert.equal(db.prepare("SELECT status FROM background_tasks WHERE id=?").get(task.id)?.status, "paused");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status='pending'").get()?.n, 0);
  } finally { db.close(); }
  console.log("PASS service shutdown drains tools, preparation, approval and background run before closing storage; admission stays closed");
  console.log("Harness host acceptance PASS");
} finally {
  fs.writeFileSync(releaseFile, "release fixture startup during teardown");
  fs.writeFileSync(lifecycleReleaseFile, "release lifecycle during teardown");
  await Promise.allSettled([...directLoops].map(loop => loop.dispose?.()));
  if (!closed) await services.close();
  await stub.close();
  // Only this generated fixture directory is eligible for cleanup.
  assert(path.dirname(sandbox) === fs.realpathSync(os.tmpdir()) || path.dirname(sandbox) === os.tmpdir());
  assert(path.basename(sandbox).startsWith("uncensia-harness-host-"));
  fs.rmSync(sandbox, { recursive: true, force: true });
}
