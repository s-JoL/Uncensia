import fs from "node:fs";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createBashTool, createReadTool, createWriteTool, createEditTool, createGrepTool, createFindTool, createLsTool, detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { CodingCapability } from "@shared/types.ts";
import { paths } from "../env.ts";
import { INTENT_DESCRIPTION } from "./descriptions.ts";

/** Named once, because the approval gate has to hold exactly this tool. */
export const SHELL_TOOL = "bash";


/** Guards against a model deleting or rewriting a tree by accident. */
const MAX_DELETE_ENTRIES = 200;

/** Resolve links before checking containment, including a not-yet-created file. */
function canonicalPath(target: string) {
  let probe = target;
  while (!fs.lstatSync(probe, { throwIfNoEntry: false }) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  return path.join(fs.realpathSync(probe), path.relative(probe, target));
}

export function safePath(workspace: string, requested = ".") {
  const resolved = canonicalPath(path.resolve(workspace, requested));
  const root = canonicalPath(workspace);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path is outside the configured coding workspace: ${requested}`);
  }
  return resolved;
}

const result = (text: string, details: Record<string, unknown> = {}) => ({
  content: [{ type: "text" as const, text }],
  details,
});

const intent = { intent: { type: "string", description: INTENT_DESCRIPTION } };

/**
 * Serialises writes per file. Two tool calls in one batch can target the same
 * path, and a half-applied pair of edits is far worse than a slow one.
 */
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(keys)].sort();
  const previous = Promise.all(ordered.map((key) => locks.get(key) ?? Promise.resolve()));
  const next = previous.then(fn);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  for (const key of ordered) locks.set(key, settled);
  void settled.then(() => {
    for (const key of ordered) if (locks.get(key) === settled) locks.delete(key);
  });
  return next;
}

/**
 * Every destructive change copies the previous bytes here first, so a wrong
 * edit is recoverable inside the same conversation instead of being final.
 * It lives beside the database rather than in the workspace, where it would
 * show up in the model's own searches and in the user's version control.
 */
function trashDir() {
  const dir = path.join(paths.data, "coding-trash");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function archive(workspace: string, file: string, reason: string) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  const relative = path.relative(workspace, file);
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const target = path.join(trashDir(), `${stamp}__${relative.replace(/[\\/]/g, "~")}`);
  fs.copyFileSync(file, target);
  fs.appendFileSync(
    path.join(trashDir(), "journal.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), reason, path: relative, backup: path.basename(target) })}\n`,
    "utf8",
  );
  return path.basename(target);
}

/**
 * Filesystem and shell access for the coding agent. Every tool is off by
 * default and every path is confined to the configured workspace.
 */
export function codingTools(config: CodingCapability): AgentTool[] {
  const tools: AgentTool[] = [];
  const workspace = canonicalPath(path.resolve(config.workspace));
  const show = (file: string) => path.relative(workspace, file) || ".";

  if (config.write) {
    tools.push({
      name: "move_path",
      label: "Rename or move",
      description:
        "Rename or move a file or directory inside the coding workspace. Refuses to clobber an existing " +
        "destination unless overwrite is set.",
      executionMode: "sequential",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          ...intent,
          from: { type: "string" },
          to: { type: "string" },
          overwrite: { type: "boolean" },
        },
        required: ["from", "to"],
      }),
      execute: async (_callId, params) => {
        const args = params as { from: string; to: string; overwrite?: boolean };
        const from = safePath(workspace, args.from);
        const to = safePath(workspace, args.to);
        if (from === workspace) throw new Error("Refusing to move the workspace root");
        return withLock([from, to], async () => {
          if (!fs.existsSync(from)) throw new Error(`${show(from)} does not exist`);
          if (from === to) throw new Error("Source and destination are the same path");
          if (fs.existsSync(to)) {
            if (!args.overwrite) throw new Error(`${show(to)} already exists; pass overwrite to replace it`);
            archive(workspace, to, "move_path overwrite");
          }
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.renameSync(from, to);
          return result(`Moved ${show(from)} → ${show(to)}`, { from: show(from), to: show(to) });
        });
      },
    });

    tools.push({
      name: "delete_path",
      label: "Delete",
      description:
        "Delete a file, or a directory with recursive set. A person is asked to approve the deletion before " +
        "it runs, and deleted files are copied aside first and can be restored with restore_file.",
      executionMode: "sequential",
      parameters: Type.Unsafe({
        type: "object",
        properties: {
          ...intent,
          path: { type: "string" },
          recursive: { type: "boolean" },
        },
        required: ["path"],
      }),
      execute: async (_callId, params) => {
        const args = params as { path: string; recursive?: boolean };
        const target = safePath(workspace, args.path);
        if (target === path.resolve(workspace)) throw new Error("Refusing to delete the workspace root");
        if (!fs.existsSync(target)) throw new Error(`${show(target)} does not exist`);

        return withLock([target], async () => {
          const stat = fs.statSync(target);
          if (!stat.isDirectory()) {
            const backup = archive(workspace, target, "delete_path");
            fs.rmSync(target);
            // The id goes in the text, not only in the details: the model reads
            // the text, and without it undoing this needs a listing call first.
            return result(
              `Deleted ${show(target)}${backup ? `. Restore it with restore_file backup=${backup}` : ""}`,
              { backup, entries: 1 },
            );
          }

          if (!args.recursive) throw new Error(`${show(target)} is a directory; pass recursive to delete it`);
          const files: string[] = [];
          const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
              const full = path.join(dir, entry.name);
              safePath(workspace, full);
              if (entry.isDirectory()) walk(full);
              else files.push(full);
            }
          };
          walk(target);
          if (files.length > MAX_DELETE_ENTRIES) {
            throw new Error(
              `${show(target)} holds ${files.length} files, over the ${MAX_DELETE_ENTRIES} limit for one delete. Remove it in smaller pieces.`,
            );
          }
          for (const file of files) archive(workspace, file, "delete_path recursive");
          fs.rmSync(target, { recursive: true });
          return result(
            `Deleted ${show(target)} and ${files.length} file(s). Call restore_file with no backup id to list them.`,
            { entries: files.length },
          );
        });
      },
    });

    tools.push({
      name: "restore_file",
      label: "Restore",
      description:
        "Undo a delete or overwrite. With no arguments it lists what can be restored; pass a backup id to " +
        "put those bytes back at their original path.",
      executionMode: "sequential",
      parameters: Type.Unsafe({
        type: "object",
        properties: { ...intent, backup: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 100 } },
        required: [],
      }),
      execute: async (_callId, params) => {
        const args = params as { backup?: string; limit?: number };
        const journalPath = path.join(trashDir(), "journal.jsonl");
        const entries = fs.existsSync(journalPath)
          ? fs
              .readFileSync(journalPath, "utf8")
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line) as { at: string; reason: string; path: string; backup: string })
          : [];

        if (!args.backup) {
          const recent = entries.slice(-(args.limit ?? 20)).reverse();
          const listing = recent.map((entry) => `${entry.backup}  ${entry.at}  ${entry.reason}  ${entry.path}`);
          return result(listing.join("\n") || "Nothing to restore", { count: recent.length });
        }

        const entry = entries.findLast((item) => item.backup === args.backup);
        if (!entry) throw new Error(`Unknown backup id ${args.backup}`);
        const source = path.join(trashDir(), entry.backup);
        if (!fs.existsSync(source)) throw new Error(`Backup ${args.backup} is no longer on disk`);
        const target = safePath(workspace, entry.path);
        return withLock([target], async () => {
          archive(workspace, target, "restore_file overwrite");
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(source, target);
          return result(`Restored ${entry.path}`, { path: entry.path });
        });
      },
    });
  }


  // Standard Pi names and schemas remain available to community skills.
  // The storage operations preserve Uncensia's workspace and recovery contract.
  const readFile = async (file: string) => fs.promises.readFile(safePath(workspace, file));
  const access = async (file: string) => fs.promises.access(safePath(workspace, file));
  const writeFile = async (file: string, content: string) => {
    const target = safePath(workspace, file);
    if (fs.existsSync(target)) archive(workspace, target, "pi write");
    await fs.promises.writeFile(target, content);
  };
  if (config.read) {
    tools.push(createReadTool(workspace, { operations: { readFile, access, detectImageMimeType: async (file) => detectSupportedImageMimeTypeFromFile(safePath(workspace, file)) } }));
    for (const original of [createGrepTool(workspace), createFindTool(workspace), createLsTool(workspace)]) {
      const sdk = original as AgentTool;
      tools.push({ ...sdk, execute: async (id, args, signal, update) => {
        safePath(workspace, String((args as { path?: string }).path ?? "."));
        return sdk.execute(id, args, signal, update);
      } });
    }
  }
  if (config.write) {
    const writers: AgentTool[] = [
      createEditTool(workspace, { operations: { readFile, access, writeFile } }),
      createWriteTool(workspace, { operations: { writeFile, mkdir: async (dir) => { await fs.promises.mkdir(safePath(workspace, dir), { recursive: true }); } } }),
    ];
    for (const writer of writers) tools.push({ ...writer, execute: async (id, args, signal, update) => withLock([safePath(workspace, String((args as { path: string }).path))], () => writer.execute(id, args, signal, update)) });
  }
  if (config.shell) tools.push(shellTool(workspace));

  return tools;
}

/**
 * The shell, borrowed from Pi coding-agent.
 *
 * Uncensia used to spawn PowerShell on Windows and `/bin/sh` elsewhere, which made
 * the language the model had to write a property of the host it happened to run
 * on. The harness resolves one bash everywhere and brings streaming output,
 * truncation with an overflow file, and process-tree kills — all of which the
 * hand-written version either lacked or got subtly wrong.
 *
 * `createBashTool` also offers a `prepare` hook for exactly this kind of
 * preflight, but the approval gate stays one level up in `beforeToolCall`,
 * where a refusal becomes a tool result the model can read instead of an error
 * it is likely to retry.
 */
function shellTool(workspace: string): AgentTool {
  // Git Bash rebuilds PATH from the Windows process environment. Production
  // starts Uncensia with its bundled Node at the front, but other launchers (and
  // the audit server) need the same guarantee here: coding commands are part of
  // Uncensia, so they must not depend on a system-wide Node installation.
  const nodeDir = path.dirname(process.execPath);
  const shellPath = [nodeDir, process.env.PATH].filter(Boolean).join(path.delimiter);
  const bash = createBashTool(workspace, { spawnHook: (context) => ({ ...context, env: { ...context.env, PATH: shellPath } }) });
  return {
    ...bash,
    name: SHELL_TOOL,
    label: "Run command",
    description: `${bash.description} Runs in ${workspace}. Node.js ${process.version} is available as node. Every command is shown to the user for approval before it runs.`,
  } as AgentTool;
}
