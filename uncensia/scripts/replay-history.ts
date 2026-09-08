/** Real HTTP turn replay, with no intercepted tools or prewritten assistant history.
 * Set UNCENSIA_EVAL_URL, UNCENSIA_EVAL_ACCESS_CODE, UNCENSIA_EVAL_MODEL explicitly.
 * node --import tsx scripts/replay-history.ts <case> <1-based-turn> <evidence-directory>
 * Turn 1 creates a conversation; subsequent turns reuse that directory's state.json.
 * Repeat the same command after an observation timeout to collect the submitted run.
 * Optional bindings.json maps attachment names to actual instance asset IDs.
 * Calls real configured services. Shell/overwrite approvals remain in the app UI.
 * Stores public text/tool evidence, omitting reasoning and inline image payloads.
 */
import fs from "node:fs";
import path from "node:path";
import cases from "./fixtures/product-history.json" with { type: "json" };

const [caseId, ordinalText, directory] = process.argv.slice(2);
const selected = cases[caseId as keyof typeof cases];
const ordinal = Number(ordinalText);
if (!selected || !Number.isInteger(ordinal) || ordinal < 1 || ordinal > selected.turns.length || !directory) {
  throw new Error("Use <case> <1-based-turn> <evidence-directory>. Cases: " + Object.keys(cases).join(", "));
}
const base = process.env.UNCENSIA_EVAL_URL?.replace(/\/$/, "");
const accessCode = process.env.UNCENSIA_EVAL_ACCESS_CODE, modelId = process.env.UNCENSIA_EVAL_MODEL;
if (!base || !accessCode || !modelId) throw new Error("Set the three explicit UNCENSIA_EVAL_* connection/model variables");
const timeout = Number(process.env.UNCENSIA_EVAL_TIMEOUT_MS ?? 2400000);
if (!Number.isFinite(timeout) || timeout < 1) throw new Error("UNCENSIA_EVAL_TIMEOUT_MS must be positive");
const output = path.resolve(directory), stateFile = path.join(output, "state.json");
const resultFile = path.join(output, `turn-${ordinal}.json`);
if (fs.existsSync(resultFile)) throw new Error("This turn already has evidence; use a new replay directory");
let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : null;
if (state?.active && (state.caseId !== caseId || !state.active.runId || state.active.ordinal !== ordinal || state.active.base !== base || state.active.modelId !== modelId)) {
  throw new Error("Uncertain submission or different active turn/instance/model. Inspect the recorded conversation; do not submit a duplicate.");
}
if (!state?.active && ((ordinal === 1 && state) || (ordinal > 1 && (!state || state.caseId !== caseId || state.completedTurn !== ordinal - 1)))) {
  throw new Error("Replay turns in order in the same evidence directory");
}
const turn = selected.turns[ordinal - 1]!;
const bindingsFile = path.join(output, "bindings.json");
const bindings = fs.existsSync(bindingsFile) ? JSON.parse(fs.readFileSync(bindingsFile, "utf8")) : {};
const attachments = (state?.active ? [] : "attachments" in turn ? turn.attachments ?? [] : []).map(name => {
  const id = bindings[name];
  if (typeof id !== "string" || !/^img_[a-f0-9]{32}$/.test(id)) throw new Error(`Missing actual image binding: ${name}`);
  return id;
});
let token = "";
async function api(route: string, body?: unknown): Promise<any> {
  const response = await fetch(`${base}/v1${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}
token = (await api("/auth/token", { accessCode, deviceName: "history-replay" })).token;
fs.mkdirSync(output, { recursive: true });
const conversationId = state?.conversationId ?? (await api("/conversations", { modelId, title: `Replay ${caseId}` })).id;
async function listJobs() {
  const jobs: Array<{ id: string }> = [];
  let cursor: string | null = null;
  do {
    const page = await api(`/jobs?conversationId=${conversationId}&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    jobs.push(...page.items); cursor = page.nextCursor;
  } while (cursor);
  return jobs;
}
const saveState = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
if (!state?.active) {
  const oldMessages = (await api(`/conversations/${conversationId}/messages`)).items;
  const beforeSeq = Math.max(-1, ...oldMessages.map((m: { seq: number }) => m.seq));
  state = { caseId, conversationId, completedTurn: ordinal - 1, active: {
    ordinal, base, modelId, beforeSeq, oldJobIds: (await listJobs()).map(job => job.id), began: Date.now(), runId: null,
  } };
  // A lost POST response must leave evidence of an uncertain submission, not
  // an apparently unused directory that invites another paid turn.
  saveState();
  const submitted = await api(`/conversations/${conversationId}/runs`, { text: turn.text, attachments, modelId });
  state.active.runId = submitted.runId; saveState();
}
const run = { runId: state.active.runId as string };
const { beforeSeq, began } = state.active;
const oldJobs = new Set(state.active.oldJobIds);
console.log(JSON.stringify({ conversationId, runId: run.runId, criteria: turn.criteria }));
let status;
const observed = Date.now();
do {
  status = await api(`/runs/${run.runId}`);
  if (["completed", "failed", "cancelled"].includes(status.status)) break;
  await new Promise(resolve => setTimeout(resolve, 2000));
} while (Date.now() - observed < timeout);
if (!["completed", "failed", "cancelled"].includes(status.status)) {
  // Preserve the active job; a harness timeout is not a user cancellation.
  throw new Error(`Observation timed out; run ${run.runId} continues. Repeat this command to observe the same run without resubmitting.`);
}
const messages = (await api(`/conversations/${conversationId}/messages`)).items.filter((m: { seq: number }) => m.seq > beforeSeq);
const jobs = (await listJobs()).filter(j => !oldJobs.has(j.id));
const evidence = JSON.stringify({ caseId, ordinal, source: selected.source, adaptation: "adaptation" in selected ? selected.adaptation : undefined, turn, conversationId, run: status, milliseconds: Date.now() - began, messages, jobs }, (key, value) => {
  if (["thinking", "thinkingSignature", "reasoning", "reasoning_content", "reasoningSignature"].includes(key)) return undefined;
  if (value?.type === "thinking" || value?.type === "reasoning") return undefined;
  if (value?.type === "image" && value.data) return { type: "image", mimeType: value.mimeType, pixelsOmitted: true };
  return value;
}, 2);
fs.writeFileSync(resultFile, evidence);
fs.writeFileSync(stateFile, JSON.stringify({ caseId, conversationId, completedTurn: ordinal }, null, 2));
console.log(JSON.stringify({ status: status.status, jobs: jobs.length, evidence: resultFile, semanticAndVisualReview: "PENDING" }));
process.exitCode = status.status === "completed" ? 0 : 1;
