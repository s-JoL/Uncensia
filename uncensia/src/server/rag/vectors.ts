import { connect, type Table } from "@lancedb/lancedb";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { Store } from "../store/store.ts";

export interface ScoredVector { chunkId: string; fileId: string; similarity: number }

/** Rebuildable local LanceDB index; SQLite retains source vectors and documents. */
export class VectorIndex {
  private readonly directory: string;
  private readonly tables = new Map<string, { revision: number; table: Table }>();
  private work: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: Store) {
    const file = store.db.get<{ file: string }>("PRAGMA database_list")?.file;
    this.directory = file ? path.join(path.dirname(file), "search-index") : fs.mkdtempSync(path.join(os.tmpdir(), "uncensia-index-"));
  }
  async search(model: string, probe: Float32Array, limit: number, fileIds?: string[]): Promise<ScoredVector[]> {
    const task = this.work.then(async () => {
      const { rows, dim, revision } = this.store.embeddingSummary(model);
      if (!rows || !dim) return [];
      if (probe.length !== dim) throw new Error(`Embedding dimension changed: stored ${dim}, query ${probe.length}. Reindex the affected documents.`);
      let cached = this.tables.get(model);
      if (!cached || cached.revision !== revision) {
        const db = await connect(this.directory);
        const name = `vectors_${createHash("sha256").update(model).digest("hex").slice(0, 24)}`;
        let table: Table | undefined;
        for (const page of this.store.embeddingPages(model, dim, 512)) {
          const data = page.chunkIds.map((chunkId, index) => ({ chunkId, fileId: page.fileIds[index]!, vector: Array.from(page.data.subarray(index * dim, (index + 1) * dim)) }));
          if (!table) table = await db.createTable(name, data, { mode: "overwrite" });
          else await table.add(data);
        }
        if (!table) return [];
        cached = { revision, table };
        this.tables.set(model, cached);
      }
      const query = cached.table.vectorSearch(probe).distanceType("cosine").limit(limit);
      if (fileIds?.length) query.where(`fileId IN (${fileIds.map((id) => `'${id.replaceAll("'", "''")}'`).join(",")})`);
      const found = await query.toArray();
      return found.map((row) => ({ chunkId: String(row.chunkId), fileId: String(row.fileId), similarity: 1 - Number(row._distance) }));
    });
    this.work = task.catch(() => undefined);
    return task;
  }
}
