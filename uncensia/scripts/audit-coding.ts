/** Actual Pi tools and Uncensia's workspace, serialization and recovery contracts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "uncensia-coding-"));
const workspace = path.join(sandbox, "project"), outside = path.join(sandbox, "outside");
fs.mkdirSync(workspace); fs.mkdirSync(outside);
fs.writeFileSync(path.join(outside, "secret.txt"), "outside workspace");
process.env.UNCENSIA_DATA_DIR = path.join(sandbox, "data");
const { codingTools } = await import("../src/server/tools/coding.ts");
const { describeRisk } = await import("../src/server/agent/approvals.ts");
const tools = new Map(codingTools({ workspace, read: true, write: true, shell: true }).map(tool => [tool.name, tool]));
const call = (name: string, args: unknown) => tools.get(name)!.execute("audit", args, undefined);
const text = (result: unknown) => JSON.stringify(result);
let failed = 0;
async function check(name: string, run: () => Promise<void> | void) {
  try { await run(); console.log("PASS " + name); }
  catch (error) { failed++; console.error("FAIL " + name, error); }
}
try {
  await check("one native tool per operation; capability switches control actual availability", () => {
    assert.deepEqual([...tools.keys()].sort(), ["read", "write", "edit", "grep", "find", "ls", "bash", "move_path", "delete_path", "restore_file"].sort());
    assert.equal(codingTools({ workspace, read: false, write: false, shell: false }).length, 0);
    assert.deepEqual(codingTools({ workspace, read: true, write: false, shell: false }).map(tool => tool.name).sort(), ["find", "grep", "ls", "read"]);
  });
  await check("native file tools support editing, line ranges and actual image pixels", async () => {
    await call("write", { path: "chapter.txt", content: "First paragraph.\nSecond paragraph." });
    await call("edit", { path: "chapter.txt", edits: [{ oldText: "First", newText: "Opening" }] });
    assert.equal(fs.readFileSync(path.join(workspace, "chapter.txt"), "utf8"), "Opening paragraph.\nSecond paragraph.");
    assert(text(await call("read", { path: "chapter.txt", offset: 2, limit: 1 })).includes("Second paragraph."));
    await sharp({ create: { width: 20, height: 20, channels: 3, background: "blue" } }).png().toFile(path.join(workspace, "image.png"));
    assert((await call("read", { path: "image.png" })).content.some(part => part.type === "image"));
  });
  await check("path traversal and symlinked reads/writes cannot leave the workspace", async () => {
    await assert.rejects(call("read", { path: "../outside/secret.txt" }), /outside/);
    await assert.rejects(call("read", { path: path.join(outside, "secret.txt") }), /outside/);
    await assert.rejects(call("write", { path: "../escape.txt", content: "blocked" }), /outside/);
    await assert.rejects(call("move_path", { from: "chapter.txt", to: "../escape.txt" }), /outside/);
    const link = path.join(workspace, "link"); fs.symlinkSync(outside, link, "junction");
    try {
      await assert.rejects(call("read", { path: "link/secret.txt" }), /outside/);
      await assert.rejects(call("write", { path: "link/new.txt", content: "blocked" }), /outside/);
    } finally { fs.unlinkSync(link); }
    assert(!fs.existsSync(path.join(outside, "new.txt")));
    fs.symlinkSync(path.join(outside, "missing"), link, "junction");
    try {
      await assert.rejects(call("write", { path: "link/escape.txt", content: "blocked" }));
    } finally { fs.unlinkSync(link); }
    await call("write", { path: "..notes.txt", content: "legal filename" });
    assert.equal(fs.readFileSync(path.join(workspace, "..notes.txt"), "utf8"), "legal filename");
  });
  await check("failed native edit is atomic; ambiguous matches need more context", async () => {
    const content = "same\nsame\nlast\n";
    await call("write", { path: "atomic.txt", content });
    await assert.rejects(call("edit", { path: "atomic.txt", edits: [{ oldText: "last", newText: "changed" }, { oldText: "missing", newText: "new" }] }));
    assert.equal(fs.readFileSync(path.join(workspace, "atomic.txt"), "utf8"), content);
    await assert.rejects(call("edit", { path: "atomic.txt", edits: [{ oldText: "same", newText: "other" }] }));
    assert.equal(fs.readFileSync(path.join(workspace, "atomic.txt"), "utf8"), content);
  });
  await check("overlapping native edits to one file serialize", async () => {
    await call("write", { path: "counter.txt", content: "0" });
    await Promise.all([1, 2, 3, 4, 5].map(value => call("edit", { path: "counter.txt", edits: [{ oldText: String(value - 1), newText: String(value) }] })));
    assert.equal(fs.readFileSync(path.join(workspace, "counter.txt"), "utf8"), "5");
  });
  await check("native search and discovery find current content", async () => {
    assert(text(await call("grep", { pattern: "Opening", path: "." })).includes("chapter.txt"));
    assert(text(await call("find", { pattern: "*.txt", path: "." })).includes("chapter.txt"));
    assert(text(await call("ls", { path: "." })).includes("chapter.txt"));
  });
  await check("move refuses clobber and deletion keeps a restorable copy", async () => {
    await call("write", { path: "doomed.txt", content: "important" });
    await assert.rejects(call("move_path", { from: "doomed.txt", to: "chapter.txt" }), /already exists/);
    await call("move_path", { from: "doomed.txt", to: "renamed.txt" });
    const removed = await call("delete_path", { path: "renamed.txt" });
    const backup = (removed.details as { backup: string }).backup;
    assert(backup && !fs.existsSync(path.join(workspace, "renamed.txt")));
    await call("restore_file", { backup });
    assert.equal(fs.readFileSync(path.join(workspace, "renamed.txt"), "utf8"), "important");
    await assert.rejects(call("delete_path", { path: ".", recursive: true }), /workspace root/);
    await assert.rejects(call("move_path", { from: ".", to: "moved" }), /workspace root/);
  });
  await check("bash keeps bundled Node, failure output and explicit approval classification", async () => {
    assert.match(text(await call("bash", { command: "node --version" })), /v2[4-9]\./);
    await assert.rejects(call("bash", { command: "echo failure-probe >&2; exit 3" }), /failure-probe[\s\S]*exited with code 3/);
    assert(describeRisk("bash", { command: "echo hello" }, workspace));
    assert(describeRisk("write", { path: "chapter.txt", content: "overwrite" }, workspace));
    assert.equal(describeRisk("write", { path: "new-file.txt", content: "new" }, workspace), null);
  });
} finally {
  assert(path.relative(os.tmpdir(), sandbox).startsWith("uncensia-coding-"));
  fs.rmSync(sandbox, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
