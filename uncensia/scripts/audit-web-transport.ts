import assert from "node:assert/strict";
import { ApiError, followRun, watchJob } from "../src/web/api.ts";

const originalFetch = globalThis.fetch;
const originals = new Map(["document", "localStorage"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
} });
Object.defineProperty(globalThis, "document", { configurable: true, value: Object.assign(new EventTarget(), { visibilityState: "visible" }) });
const frame = (type: string, seq: number) => `event: ${type}\ndata: ${JSON.stringify({ seq, data: {} })}\n\n`;
try {
  let streams = 0, polls = 0;
  const seen: number[] = [];
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes("mode=poll")) {
      polls += 1;
      assert(url.includes("after=1"), "poll lost the last delivered cursor");
      return Response.json({ events: [{ seq: 1, type: "message.delta", data: {} }, { seq: 2, type: "run.completed", data: {} }], done: true });
    }
    if (url.includes("/events")) { streams += 1; return new Response(frame("message.delta", 1)); }
    return Response.json({ status: "running" });
  };
  await followRun("fixture", 0, (_type, _data, seq) => seen.push(seq), new AbortController().signal);
  assert.equal(streams, 2);
  assert.equal(polls, 1);
  assert.deepEqual(seen, [1, 2]);
  console.log("PASS non-terminal SSE EOF switches to polling after two drops, preserving the cursor and suppressing replay duplicates");

  for (const status of [401, 403, 404]) {
    let requests = 0;
    globalThis.fetch = async () => { requests += 1; return new Response("", { status }); };
    await assert.rejects(followRun("gone", 0, () => {}, new AbortController().signal), error => error instanceof ApiError && error.status === status);
    assert.equal(requests, 1);
    await assert.rejects(watchJob("gone", () => {}, new AbortController().signal), error => error instanceof ApiError && error.status === status);
    assert.equal(requests, 2);
  }
  console.log("PASS revoked access and deleted runs/jobs fail visibly instead of retrying forever");

  for (const status of [401, 403, 404]) {
    globalThis.fetch = async input => String(input).includes("/events")
      ? new Response("")
      : Response.json({ error: { code: "gone", message: "Unavailable" } }, { status });
    await assert.rejects(followRun("gone", 0, () => {}, new AbortController().signal), error => error instanceof ApiError && error.status === status);
    await assert.rejects(watchJob("gone", () => {}, new AbortController().signal), error => error instanceof ApiError && error.status === status);
  }
  console.log("PASS permanent status-query failures after a dropped stream remain visible");

  let replayAttempts = 0, completed = false;
  globalThis.fetch = async input => {
    const url = String(input);
    if (url.includes("mode=poll")) {
      replayAttempts += 1;
      return replayAttempts === 1 ? new Response("", { status: 503 })
        : Response.json({ events: [{ seq: 1, type: "run.completed", data: {} }], done: true });
    }
    if (url.includes("/events")) return new Response("");
    return Response.json({ status: "completed" });
  };
  await followRun("settled", 0, type => { completed = type === "run.completed"; }, new AbortController().signal);
  assert.equal(replayAttempts, 2);
  assert(completed, "a failed final replay must not silently finish following the run");
  console.log("PASS a temporary final-replay failure retries until the terminal event is delivered");

  for (const status of [408, 429, 503]) {
    let requests = 0;
    globalThis.fetch = async input => {
      if (!String(input).includes("/events")) return Response.json({ status: "running" });
      requests += 1;
      return requests === 1 ? new Response("", { status }) : new Response(frame("run.completed", 1));
    };
    await followRun("retryable", 0, () => {}, new AbortController().signal);
    assert.equal(requests, 2);
  }
  console.log("PASS transient timeouts, rate limits and server outages remain retryable");
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
}
