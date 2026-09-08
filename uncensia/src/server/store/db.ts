import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type StatementSync } from "node:sqlite";

const SCHEMA = path.join(path.dirname(fileURLToPath(import.meta.url)), "schema.sql");

export type Row = Record<string, unknown>;

/**
 * Thin prepared-statement cache over node:sqlite. Every repository in the
 * server shares one instance; SQLite's own locking plus WAL is enough for the
 * single-process design.
 */
export class Db {
  readonly handle: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.handle = new DatabaseSync(file);
    const conversationColumns = this.handle.prepare("PRAGMA table_info(conversations)").all().map(column => column.name);
    if (conversationColumns.length && ["roleplay", "visual_continuity"].some(column => !conversationColumns.includes(column))) {
      this.handle.close();
      throw new Error("This database needs an offline upgrade from main. Back up the database and session history, then follow docs/12-operations.md before starting this version.");
    }
    const hadMessageIndex = this.handle.prepare("SELECT 1 FROM sqlite_master WHERE name = 'messages_fts'").get();
    this.handle.exec(fs.readFileSync(SCHEMA, "utf8"));
    // Additive task upgrade: existing one-shot tasks and run histories retain
    // their identity and defaults. Reopening an upgraded DB is a no-op.
    for (const [table, column, definition] of [
      ["background_tasks", "state", "TEXT NOT NULL DEFAULT '{}'"],
      ["runs", "task_id", "TEXT"],
    ]) {
      if (!this.handle.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column)) {
        this.handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    }
    this.handle.exec("CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id, created_at DESC)");
    // Triggers cover future writes; build the derived index for existing rows once.
    if (!hadMessageIndex) this.handle.exec("INSERT INTO messages_fts(rowid, text) SELECT rowid, text FROM message_text");
  }

  /**
   * Returns pages that streaming deltas left behind. SQLite hands a deleted
   * page to the freelist but never shrinks the file on its own, so a busy
   * install grows without bound — a real one reached 254 MB of file for 0.6 MB
   * of events. `auto_vacuum` cannot be switched on in place, so a database
   * created before it was set is converted by a full VACUUM the first time;
   * after that the incremental pass is cheap enough to run on every prune.
   *
   * Both statements are no-ops inside a transaction, so this must only be
   * called from an idle path.
   */
  reclaim() {
    const mode = Number(Object.values(this.get<Row>("PRAGMA auto_vacuum") ?? {})[0] ?? 0);
    const free = Number(Object.values(this.get<Row>("PRAGMA freelist_count") ?? {})[0] ?? 0);
    if (mode === 0) {
      // Only worth the rewrite once the dead space is material — 4 MB of pages.
      if (free < 1_000) return 0;
      this.exec("PRAGMA auto_vacuum = INCREMENTAL");
      this.exec("VACUUM");
      return free;
    }
    if (free < 256) return 0;
    this.exec("PRAGMA incremental_vacuum");
    return free;
  }

  private prepare(sql: string) {
    let statement = this.cache.get(sql);
    if (!statement) {
      statement = this.handle.prepare(sql);
      this.cache.set(sql, statement);
    }
    return statement;
  }

  all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.prepare(sql).all(...(params as never[])) as T[];
  }

  get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  run(sql: string, ...params: unknown[]) {
    return this.prepare(sql).run(...(params as never[]));
  }

  exec(sql: string) {
    this.handle.exec(sql);
  }

  /**
   * `IMMEDIATE`, not the default deferred `BEGIN`: a deferred transaction takes
   * its write lock at the first write, and an upgrade from a read lock is the one
   * case SQLite refuses to wait out — `busy_timeout` does not cover it, so a
   * concurrent writer surfaces as an immediate SQLITE_BUSY. Taking the lock up
   * front makes the wait the timeout's business. Nothing nests these, and no
   * caller uses savepoints, so there is no inner BEGIN to fail on.
   */
  transaction<T>(fn: () => T): T {
    this.handle.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.handle.exec("COMMIT");
      return result;
    } catch (error) {
      this.handle.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.cache.clear();
    this.handle.close();
  }
}

export function json<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export const bool = (value: unknown) => value === 1 || value === true || value === "1";
