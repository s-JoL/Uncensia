/** SDK session acceptance: durable first turns, branches, compaction,
 * projections and exact references. Runs only against temporary data. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type { UserMessage, AssistantMessage } from "@earendil-works/pi-ai";
import { Sessions } from "../src/server/agent/sessions.ts";
import { projectTranscript, rewindConversation } from "../src/server/agent/projection.ts";
import { searchConversations } from "../src/server/agent/search.ts";
import { Db } from "../src/server/store/db.ts";
import { Store } from "../src/server/store/store.ts";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "uncensia-sdk-sessions-"));
const file = path.join(sandbox, "sessions");
let sessions = new Sessions(file, sandbox);
const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: Date.now() });
const assistant = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "test", model: "test", stopReason: "stop", timestamp: Date.now(), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } } });
const text = (messages: unknown) => JSON.stringify(messages);
let failures = 0;
async function check(name: string, test: () => unknown | Promise<unknown>) {
  try { await test(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}`, error); }
}

await check("a fresh session has no messages", async () => assert.equal((await sessions.context("fresh")).messages.length, 0));
await check("a first user message survives restart before any assistant exists", async () => {
  (await sessions.session("first")).appendMessage(user("不能丢失的第一句话"));
  await sessions.close(); sessions = new Sessions(file, sandbox);
  assert.match(text((await sessions.context("first")).messages), /不能丢失的第一句话/);
});
await check("rewind persists the selected branch and retains abandoned messages", async () => {
  const s = await sessions.session("branch"); const keep = s.appendMessage(user("保留"));
  const abandoned = s.appendMessage(assistant("旧版本"));
  await sessions.rewind("branch", keep);
  await sessions.close(); sessions = new Sessions(file, sandbox);
  const reopened = await sessions.session("branch");
  assert(reopened.getEntry(abandoned)); assert.doesNotMatch(text(reopened.buildSessionContext()), /旧版本/);
  reopened.appendMessage(assistant("新版本"));
  assert.match(text(reopened.buildSessionContext()), /新版本/);
  assert.equal((await sessions.stats("branch")).totalTokens, 30);
});
await check("rewinding the first turn survives restart without resurrecting it", async () => {
  await sessions.rewind("first", null);
  await sessions.close(); sessions = new Sessions(file, sandbox);
  assert.equal((await sessions.context("first")).messages.length, 0);
  assert((await sessions.session("first")).getEntries().some((e) => e.type === "message"));
});
await check("Pi compaction preserves the original transcript and a retained tail", async () => {
  const s = await sessions.session("compact");
  s.appendMessage(user("早期问题")); s.appendMessage(assistant("早期回答"));
  const tail = s.appendMessage(user("最近问题"));
  s.appendCompaction("以前讨论过细节", tail, 5000);
  s.appendMessage(assistant("最新回答"));
  const context = text(convertToLlm(s.buildSessionContext().messages));
  assert.match(context, /以前讨论过细节/); assert.match(context, /最近问题/);
  assert.doesNotMatch(context, /早期回答/);
  assert(s.getBranch().some((e) => e.type === "message" && text(e.message).includes("早期回答")));
});
await check("fork copies only the selected branch and keeps independent future turns", async () => {
  const fork = await sessions.fork("branch", "fork");
  fork.appendMessage(user("只在分支里"));
  assert.doesNotMatch(text((await sessions.context("branch")).messages), /只在分支里/);
  assert.doesNotMatch(text(fork.buildSessionContext()), /旧版本/);
});
await check("forgetting a conversation removes its tree and reopening stays empty", async () => {
  const forgotten = await sessions.session("forgotten");
  forgotten.appendMessage(user("Delete only this conversation"));
  await sessions.forget("forgotten");
  await sessions.close(); sessions = new Sessions(file, sandbox);
  assert.equal((await sessions.context("forgotten")).messages.length, 0);
});
await check("conversation IDs cannot escape the session directory", async () => {
  await assert.rejects(sessions.session("../escape"), /Invalid conversation id/);
});
const db = new Db(path.join(sandbox, "app.sqlite")); const store = new Store(db);
await check("projection, editing and Chinese search share the same session IDs", async () => {
  const c = store.createConversation("test", "资料问答");
  const session = await sessions.session(c.id);
  session.appendMessage(user("独角鲸和海豚有什么区别"));
  session.appendMessage(assistant("不同的动物"));
  await projectTranscript(store, sessions, c.id);
  const hits = await searchConversations(store, "独角鲸", 10);
  assert.equal(hits[0]?.conversationId, c.id);
  const rows = store.storedMessages(c.id); await rewindConversation(store, sessions, c.id, rows[1]!.seq);
  assert.equal(store.storedMessages(c.id).length, 1);
  await sessions.close(); sessions = new Sessions(file, sandbox);
  assert.equal((await sessions.context(c.id)).messages.length, 1);
});
await check("search honours cancellation", async () => {
  const abort = new AbortController(); abort.abort();
  assert.deepEqual(await searchConversations(store, "保留", 10, abort.signal), []);
});
await check("indexed search ignores tool and metadata noise, keeps literal text and follows branch changes", async () => {
  const c = store.createConversation("test", "Search regression");
  const s = await sessions.session(c.id);
  const first = s.appendMessage(user('海风吹过码头，独角鲸游过来。 literal "quoted" OR text\nnext line'));
  const omitted = s.appendMessage(assistant("Abandoned lighthouse scene"));
  await projectTranscript(store, sessions, c.id);
  db.transaction(() => {
    for (let i = 0; i < 2100; i++) {
      store.addMessage(c.id, { role: "toolResult", content: [{ type: "text", text: "独角鲸" }], toolCallId: `noise-${i}` });
      store.addMessage(c.id, { ...assistant("Unrelated answer"), model: "独角鲸", content: [{ type: "thinking", thinking: "独角鲸" }, { type: "text", text: "Unrelated answer" }] });
    }
  });
  for (const query of ["海风", '"quoted" OR', "text\nnext line"]) {
    const hits = await searchConversations(store, query, 1);
    assert.equal(hits.length, 1); assert.equal(hits[0]!.conversationId, c.id); assert.equal(hits[0]!.seq, 0);
  }
  assert((await searchConversations(store, "独角鲸", 50)).every(hit => !hit.snippet.includes("Unrelated")));
  const fork = store.createConversation("test", "Fork search");
  await sessions.fork(c.id, fork.id, first); await projectTranscript(store, sessions, fork.id);
  assert.deepEqual(new Set((await searchConversations(store, "海风", 10)).map(hit => hit.conversationId)), new Set([c.id, fork.id]));
  await sessions.rewind(c.id, first); await projectTranscript(store, sessions, c.id);
  assert.deepEqual(await searchConversations(store, "lighthouse", 10), []);
  assert(s.getEntry(omitted), "search must not delete abandoned history");
  store.deleteConversation(fork.id);
  assert.equal((await searchConversations(store, "海风", 10)).length, 1);
  db.run("UPDATE messages SET content = ? WHERE conversation_id = ? AND seq = 0", JSON.stringify(user("更正后的珊瑚湾")), c.id);
  assert.deepEqual(await searchConversations(store, "海风", 10), []);
  assert.equal((await searchConversations(store, "珊瑚湾", 10))[0]?.conversationId, c.id);
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES ('integrity-check')");
});
await check("custom branch projection preserves display, metadata, entry IDs and order across compaction/reopen/rewind", async () => {
  const c = store.createConversation("test", "Custom messages");
  const s = await sessions.session(c.id);
  const first = s.appendCustomMessageEntry("fixture.banner", [{ type: "text", text: "Visible startup" }], true, { key: "banner" });
  const question = s.appendMessage(user("Question"));
  const hidden = s.appendCustomMessageEntry("fixture.internal", "Hidden context", false, { exactId: "asset-fixture" });
  const answer = s.appendMessage(assistant("Answer"));
  s.appendCustomEntry("fixture.state", { mustNotRender: true });
  s.appendCompaction("Summary must not replace the displayed transcript", question, 5000);
  const last = s.appendCustomMessageEntry("fixture.footer", "Visible footer", true);
  const original = text(s.getEntries());

  await projectTranscript(store, sessions, c.id);
  const rows = store.storedMessages(c.id);
  assert.deepEqual(rows.map(row => row.role), ["custom", "user", "custom", "assistant", "custom"]);
  assert.deepEqual(rows.map(row => store.messageEntryId(c.id, row.seq)), [first, question, hidden, answer, last]);
  assert.deepEqual(rows[0]!.content, { role: "custom", customType: "fixture.banner", content: [{ type: "text", text: "Visible startup" }], display: true, details: { key: "banner" }, timestamp: new Date(s.getEntry(first)!.timestamp).getTime() });
  assert.deepEqual(rows[2]!.content, { role: "custom", customType: "fixture.internal", content: "Hidden context", display: false, details: { exactId: "asset-fixture" }, timestamp: new Date(s.getEntry(hidden)!.timestamp).getTime() });
  assert.doesNotMatch(text(rows), /mustNotRender|Summary must not replace/);
  assert.equal(text(s.getEntries()), original, "projection must not rewrite SDK entries");
  assert.equal((await searchConversations(store, "Visible startup", 10))[0]?.conversationId, c.id);
  assert.deepEqual(await searchConversations(store, "Hidden context", 10), []);

  await sessions.close(); sessions = new Sessions(file, sandbox);
  await projectTranscript(store, sessions, c.id);
  assert.deepEqual(store.storedMessages(c.id).map(row => row.content), rows.map(row => row.content));
  await rewindConversation(store, sessions, c.id, store.storedMessages(c.id)[2]!.seq);
  assert.deepEqual(store.storedMessages(c.id).map(row => row.role), ["custom", "user"]);
  assert((await sessions.session(c.id)).getEntry(hidden), "rewind must retain the abandoned custom entry");
});
await check("missing derived search index rebuilds from existing projection on reopen", async () => {
  const existingFile = path.join(sandbox, "search-rebuild.sqlite");
  let existingDb = new Db(existingFile); let existingStore = new Store(existingDb);
  const c = existingStore.createConversation("test", "Rebuild");
  existingStore.addMessage(c.id, user("重建索引不丢历史"));
  existingDb.exec("DROP TABLE messages_fts"); existingDb.close();
  existingDb = new Db(existingFile); existingStore = new Store(existingDb);
  assert.equal((await searchConversations(existingStore, "不丢历史", 10))[0]?.conversationId, c.id);
  existingStore.deleteConversation(c.id);
  assert.deepEqual(await searchConversations(existingStore, "不丢历史", 10), []);
  existingDb.close();
});
await check("legacy main database is refused before schema or history changes", () => {
  const legacyFile = path.join(sandbox, "legacy-main.sqlite");
  const legacy = new DatabaseSync(legacyFile);
  legacy.exec("CREATE TABLE conversations(id TEXT PRIMARY KEY, title TEXT, model_id TEXT, archived INTEGER, created_at INTEGER, updated_at INTEGER); INSERT INTO conversations VALUES('keep', 'Original history', 'test', 0, 1, 1)");
  legacy.close();
  const before = fs.readFileSync(legacyFile);
  assert.throws(() => new Db(legacyFile), /offline upgrade from main/);
  assert.deepEqual(fs.readFileSync(legacyFile), before, "rejected startup must not mutate old data");
});
db.close(); await sessions.close();
console.log(`Session acceptance: ${failures ? "FAIL" : "PASS"}; artifacts: ${sandbox}`);
if (failures) process.exitCode = 1;
