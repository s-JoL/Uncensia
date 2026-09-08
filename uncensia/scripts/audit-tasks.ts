import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startOpenAiStub } from "./stub-openai.ts";
import { taskSchedule } from "../src/shared/tasks.ts";
import type { BackgroundTask } from "../src/shared/types.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uncensia-tasks-"));
process.env.UNCENSIA_DATA_DIR = dir;
process.env.UNCENSIA_ACCESS_CODE = "TASKAUDITCODE";
const { Db } = await import("../src/server/store/db.ts");
// A real legacy schema must upgrade without losing its existing task.
const legacyPath = path.join(dir, "legacy.sqlite");
const legacy = new DatabaseSync(legacyPath);
legacy.exec(fs.readFileSync("src/server/store/schema.sql", "utf8").replace("  task_id         TEXT,\n", "").replace("  state           TEXT NOT NULL DEFAULT '{}',\n", ""));
legacy.exec("INSERT INTO conversations(id,model_id,created_at,updated_at) VALUES('old-conv','fixture',1,1); INSERT INTO background_tasks(id,conversation_id,prompt,model_id,run_at,created_at,updated_at) VALUES('old-task','old-conv','keep me','fixture',9,1,1)");
legacy.close();
for (let i = 0; i < 2; i++) { const db = new Db(legacyPath); assert.equal(db.get("SELECT prompt FROM background_tasks WHERE id='old-task'")?.prompt, "keep me"); assert.ok(db.all("PRAGMA table_info(runs)").some(row => row.name === "task_id")); db.close(); }

let createdTaskId = "";
const stub = await startOpenAiStub(0, body => {
  const messages = body.messages ?? [];
  const lastUser = messages.findLastIndex(m => m.role === "user");
  const text = JSON.stringify(messages[lastUser]?.content ?? "");
  const after = messages.slice(lastUser + 1);
  if (text.includes("CREATE_TASK_FIXTURE") && !after.some(m => m.role === "tool")) {
    return { kind: "tool", name: "create_task", args: { intent: "User requested sustained work", prompt: "TWO_RUNS_FIXTURE", mode: "continuous", maxRuns: 3 } };
  }
  if (text.includes("TWO_RUNS_FIXTURE") && text.includes("后台任务") && !after.some(m => m.role === "tool")) {
    const second = text.includes("已完成 1 轮");
    return { kind: "tool", name: "report_task_progress", args: { intent: "Save completed work", summary: second ? "Finished both parts; results are in this conversation." : "Finished part one; part two remains.", outcome: second ? "complete" : "continue", completed: second ? 2 : 1, total: 2 } };
  }
  return { kind: "text", text: "Fixture result" };
});
const { createServices } = await import("../src/server/services.ts");
const { createApp } = await import("../src/server/http/app.ts");
const services = createServices();
const app = createApp(services);
let token = "";
const call = (method: string, route: string, body?: unknown) => app.request(`/v1${route}`, {
  method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body),
});
async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 15000;
  while (!check()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 40)); }
}
try {
  token = (await (await call("POST", "/auth/token", { accessCode: "TASKAUDITCODE", deviceName: "task-audit" })).json() as { token: string }).token;
  services.store.upsertProvider({ id: "fixture", name: "fixture", baseUrl: stub.url + "/v1", auth: { style: "none" }, enabled: true });
  services.store.upsertModel({ id: "fixture", providerId: "fixture", model: "fixture", name: "fixture", apiMode: "openai-chat", kind: "chat", enabled: true, reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000, thinkingLevel: "off" });
  services.reload();
  const conv = services.store.createConversation("fixture", "Task audit");
  for (const invalid of [{ mode: "forever" }, { mode: "interval", intervalMs: 1 }, { mode: "once", maxRuns: null }, { runAt: "tomorrow" }, { maxRuns: 0 }, { prompt: 44 }]) {
    assert.equal((await call("POST", `/conversations/${conv.id}/background-tasks`, { prompt: "unused", ...invalid })).status, 400);
  }
  const scheduled = await (await call("POST", `/conversations/${conv.id}/background-tasks`, { prompt: "future", runAt: Date.now() + 3600000 })).json() as BackgroundTask;
  assert.equal(scheduled.status, "pending");
  assert.equal(scheduled.state.mode, "once");
  assert.equal((await call("PATCH", `/background-tasks/${scheduled.id}`, { action: "pause" })).status, 200);
  assert.equal(services.store.dueBackgroundTasks(Date.now() + 7200000).length, 0);
  assert.equal((await call("PATCH", `/background-tasks/${scheduled.id}`, { action: "resume" })).status, 200);
  assert.equal((await call("DELETE", `/background-tasks/${scheduled.id}`)).status, 200);

  const run = services.store.createRun(conv.id, "fixture");
  await services.runtime.start(run.id, conv.id, { message: "CREATE_TASK_FIXTURE", modelId: "fixture" });
  createdTaskId = services.store.listBackgroundTasks(conv.id).find(task => task.prompt === "TWO_RUNS_FIXTURE")!.id;
  services.background.wake();
  await until(() => services.store.getBackgroundTask(createdTaskId)?.status === "completed", "two autonomous turns");
  const completed = services.store.getBackgroundTask(createdTaskId)!;
  assert.equal(completed.state.completedRuns, 2);
  services.store.settleBackgroundTask(completed.id, completed.runId!);
  assert.equal(services.store.getBackgroundTask(completed.id)!.state.completedRuns, 2, "settlement is idempotent");
  assert.equal(completed.state.progress?.completed, 2);
  assert.equal(services.store.taskRuns(createdTaskId).length, 2);
  assert.equal(stub.requests.filter(request => {
    const ms = request.messages ?? [];
    const lastUser = ms.findLastIndex(m => m.role === "user");
    return JSON.stringify(ms[lastUser]?.content).includes("后台任务") && ms.slice(lastUser + 1).some(m => m.role === "tool");
  }).length, 0, "native terminate hands control back without another model call in the same run");
  assert.equal((await (await call("GET", `/background-tasks/${createdTaskId}/runs`)).json() as { items: unknown[] }).items.length, 2);
  console.log("PASS real Pi SDK tool scheduling, durable two-turn continuation, progress and completion");

  const noReport = services.store.createBackgroundTask({ conversationId: conv.id, modelId: "fixture", prompt: "NO_REPORT", runAt: Date.now(), schedule: taskSchedule({ mode: "continuous", maxRuns: 2 }) });
  services.background.wake();
  await until(() => services.store.getBackgroundTask(noReport.id)?.status === "paused", "missing progress pauses");
  assert.match(services.store.getBackgroundTask(noReport.id)!.error!, /未报告进度/);
  await call("DELETE", `/background-tasks/${noReport.id}`);

  // Scheduling policies are exercised against stored real runs, without a
  // minute-long wall-clock wait for each interval edge case.
  const interval = services.store.createBackgroundTask({ conversationId: conv.id, modelId: "fixture", prompt: "repeat", runAt: Date.now() + 3600000, schedule: taskSchedule({ mode: "interval", intervalMs: 60000, maxRuns: null }) });
  const ir = services.store.claimBackgroundTask(interval.id)!;
  services.store.setRunStatus(ir.id, "completed");
  services.store.settleBackgroundTask(interval.id, ir.id, interval.runAt + 125000);
  assert.equal(services.store.getBackgroundTask(interval.id)!.runAt, interval.runAt + 180000);
  const ir2 = services.store.claimBackgroundTask(interval.id)!;
  services.store.controlBackgroundTask(interval.id, "pause");
  assert.throws(() => services.store.controlBackgroundTask(interval.id, "resume"), /等待/);
  services.store.setRunStatus(ir2.id, "completed");
  services.store.settleBackgroundTask(interval.id, ir2.id);
  assert.equal(services.store.getBackgroundTask(interval.id)!.status, "paused");
  services.store.controlBackgroundTask(interval.id, "resume");
  assert.equal(services.store.getBackgroundTask(interval.id)!.runAt, interval.runAt + 240000, "resume preserves the interval phase");
  const ir3 = services.store.claimBackgroundTask(interval.id)!;
  services.store.cancelBackgroundTask(interval.id);
  services.store.setRunStatus(ir3.id, "completed");
  services.store.settleBackgroundTask(interval.id, ir3.id);
  assert.equal(services.store.getBackgroundTask(interval.id)!.status, "cancelled");
  assert.throws(() => services.store.reportTaskProgress(interval.id, { runId: ir3.id, summary: "late", outcome: "continue" }));

  const cap = services.store.createBackgroundTask({ conversationId: conv.id, modelId: "fixture", prompt: "cap", runAt: Date.now() + 3600000, schedule: taskSchedule({ mode: "continuous", maxRuns: 1 }) });
  const cr = services.store.claimBackgroundTask(cap.id)!;
  services.store.reportTaskProgress(cap.id, { runId: cr.id, summary: "Still unfinished", outcome: "continue" });
  services.store.setRunStatus(cr.id, "completed"); services.store.settleBackgroundTask(cap.id, cr.id);
  assert.equal(services.store.getBackgroundTask(cap.id)!.status, "paused");
  assert.throws(() => services.store.controlBackgroundTask(cap.id, "resume"), /轮数/);
  const restart = services.store.createBackgroundTask({ conversationId: conv.id, modelId: "fixture", prompt: "interrupted", runAt: Date.now() + 3600000 });
  services.store.claimBackgroundTask(restart.id);
  services.store.failStaleRuns(); services.store.failInterruptedBackgroundTasks();
  assert.equal(services.store.getBackgroundTask(restart.id)!.status, "failed");
  assert.ok(!services.store.dueBackgroundTasks(Date.now() + 7200000).some(task => task.id === restart.id));
  console.log("PASS additive migration, API validation, schedule pause/resume, missed interval skipping, cancel wins, run limits and restart without replay");

  // The scheduler must start unrelated conversations while a long one waits,
  // and scanning several busy conversations must not starve a ready one.
  await services.background.close();
  const { BackgroundTasks } = await import("../src/server/agent/background.ts");
  const { taskTools } = await import("../src/server/tools/tasks.ts");
  const busy = new Set<string>();
  const releases: Array<() => void> = [];
  for (let i = 0; i < 5; i++) {
    const c = services.store.createConversation("fixture", "Busy"); busy.add(c.id);
    services.store.createBackgroundTask({ conversationId: c.id, modelId: "fixture", prompt: "wait", runAt: Date.now() });
  }
  const ready = [services.store.createConversation("fixture", "Ready A"), services.store.createConversation("fixture", "Ready B")];
  for (const c of ready) services.store.createBackgroundTask({ conversationId: c.id, modelId: "fixture", prompt: "ready", runAt: Date.now() });
  const scheduler = new BackgroundTasks(services.store, {
    isActive: (id: string) => busy.has(id),
    start: (id: string, conversationId: string) => {
      busy.add(conversationId);
      services.store.setRunStatus(id, "running");
      return new Promise<void>(resolve => releases.push(() => {
        services.store.setRunStatus(id, "completed"); busy.delete(conversationId); resolve();
      }));
    },
  } as any);
  assert.equal(releases.length, 2, "both ready conversations start despite five older busy tasks");
  scheduler.wake(); assert.equal(releases.length, 2, "waking twice cannot double-claim");
  for (const release of releases) release();
  await scheduler.close();
  const tools = taskTools(services.store, conv.id, "fixture", "same-run");
  const creator = tools.find(t => t.name === "create_task")!;
  const args = { prompt: "idempotent", mode: "once", runAt: Date.now() + 3600000 };
  const firstCall = await creator.execute("same-call", args);
  const retriedCall = await creator.execute("same-call", args);
  assert.deepEqual(firstCall, retriedCall);
  const foreign = services.store.listBackgroundTasks(ready[0]!.id)[0]!;
  await assert.rejects(tools.find(t => t.name === "control_task")!.execute("control", { task_id: foreign.id, action: "cancel" }), /this conversation/);
  console.log("PASS independent task concurrency, busy-conversation fairness, duplicate call protection and tool scope");
} finally {
  await services.close(); await stub.close();
  assert.equal(path.dirname(dir), os.tmpdir()); assert.ok(path.basename(dir).startsWith("uncensia-tasks-"));
  fs.rmSync(dir, { recursive: true, force: true });
}
