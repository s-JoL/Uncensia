import type { FileSearchMode } from "@shared/types.ts";
import { SECRET, type Config } from "../config.ts";
import type { SecretVault } from "../crypto/secrets.ts";
import type { Store } from "../store/store.ts";
import { chunkPages } from "./chunk.ts";
import { createEmbeddingClient, normalizeVector } from "./embed.ts";
import { extract, isExtractable } from "./extract.ts";
import { VectorIndex } from "./vectors.ts";

/** Reciprocal-rank-fusion constant, matching the previous hybrid ranker. */
const RRF_K = 60;

export interface SearchHit {
  chunkId: string;
  id: string;
  name: string;
  excerpt: string;
  page: number | null;
  chunk: number;
  semanticScore: number | null;
  matchType: "keyword" | "semantic" | "hybrid";
  retrievalScore: number;
}

export interface SearchResult {
  mode: FileSearchMode;
  results: SearchHit[];
  index: { total: number; ready: number };
}

/**
 * In-process retrieval. SQLite owns chunks and embedding source data;
 * LanceDB builds the local vector search index without another service.
 */
export class Retrieval {
  private readonly vectors: VectorIndex;
  private readonly indexing = new Map<string, symbol>();

  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly vault: SecretVault,
  ) {
    this.vectors = new VectorIndex(store);
  }

  private client() {
    return createEmbeddingClient(this.config.capabilities().embedding, this.vault.get(SECRET.embedding));
  }

  embeddingAvailable() {
    return Boolean(this.client());
  }

  /** Content edits invalidate work even when indexing is disabled or bytes are unchanged. */
  invalidateFile(id: string) {
    this.indexing.delete(id);
  }

  async indexFile(input: { id: string; name: string; mime: string; diskPath: string }) {
    // A deduplicated upload hands the caller back the row that already held those
    // bytes, so the id this was called with can belong to no row at all — and
    // chunks written against it would fail their foreign key.
    const file = this.store.getFile(input.id);
    if (!file) return { chunks: 0, embedded: 0 };
    const generation = Symbol();
    this.indexing.set(file.id, generation);
    const current = () => this.indexing.get(file.id) === generation && this.store.getFile(file.id)?.sha256 === file.sha256;
    if (!isExtractable(file.name, file.mime)) {
      this.store.setFileEmbeddingStatus(file.id, "none");
      this.indexing.delete(file.id);
      return { chunks: 0, embedded: 0 };
    }
    this.store.setFileEmbeddingStatus(file.id, "pending");
    try {
      const capability = this.config.capabilities().embedding;
      const extraction = await extract(file.diskPath, file.name, file.mime);
      if (!current()) return { chunks: 0, embedded: 0 };
      const chunks = chunkPages(extraction.pages, capability.chunkSize, capability.chunkOverlap);
      if (!this.store.replaceChunks(file.id, chunks)) return { chunks: 0, embedded: 0 };
      if (extraction.pageCount != null) {
        this.store.db.run("UPDATE files SET page_count = ? WHERE id = ?", extraction.pageCount, file.id);
      }
      if (!chunks.length) {
        this.store.setFileEmbeddingStatus(file.id, "failed", "No extractable text");
        return { chunks: 0, embedded: 0 };
      }
      const client = this.client();
      if (!client) {
        // Keyword search still works, so a missing embedding key degrades the
        // feature instead of rejecting the upload. `indexed` is that state:
        // chunks exist, vectors do not, and the library page must not call it a
        // failure.
        this.store.setFileEmbeddingStatus(file.id, "indexed");
        return { chunks: chunks.length, embedded: 0 };
      }
      const vectors = await client.embed(chunks.map((chunk) => chunk.text));
      if (!current()) return { chunks: 0, embedded: 0 };
      const stored = this.store.replaceEmbeddings(
        file.id,
        client.model,
        vectors.map((vector, index) => ({ chunkId: `${file.id}:chunk:${chunks[index]!.idx}`, vector })),
      );
      if (!stored) return { chunks: 0, embedded: 0 };
      this.store.setFileEmbeddingStatus(file.id, "ready");
      return { chunks: chunks.length, embedded: vectors.length };
    } catch (error) {
      // File deletion deliberately cancels background indexing. Its row is
      // already gone, so there is neither an error state to persist nor an
      // operator-facing failure to log.
      if (!current()) return { chunks: 0, embedded: 0 };
      const message = error instanceof Error ? error.message : String(error);
      this.store.setFileEmbeddingStatus(file.id, "failed", message);
      throw error;
    } finally {
      if (this.indexing.get(file.id) === generation) this.indexing.delete(file.id);
    }
  }

  /**
   * The ceiling is 50 rather than the default 10 so that an HTTP caller asking
   * for 30 gets 30: a limit that is silently clamped to a third of what was
   * asked for is worse than one that is not offered. The tool's own default
   * stays at 10 — LibreChat asks for 4 and Open WebUI 3–5, but they are feeding
   * far smaller windows than the 256k–1M ones here.
   */
  /**
   * `fileIds` narrows the search to named documents.
   *
   * Both keyword and vector rankers apply this scope before their limits so
   * relevant passages cannot be crowded out by unrelated library documents.
   */
  async searchFiles(
    query: string,
    mode: FileSearchMode,
    limit = 10,
    fileIds?: string[],
  ): Promise<SearchResult> {
    const normalized = query.trim();
    const resultLimit = Math.min(50, Math.max(1, limit));
    const index = this.store.fileIndexSummary();
    if (!normalized) return { mode, results: [], index };

    const reach = resultLimit * 3;
    const keyword = mode === "semantic" ? [] : this.keywordSearch(normalized, reach, fileIds);
    const semantic = mode === "keyword" ? [] : await this.semanticSearch(normalized, reach, fileIds);

    const merged = new Map<string, SearchHit>();
    keyword.forEach((hit, rank) => {
      merged.set(hit.chunkId, { ...hit, matchType: "keyword", retrievalScore: 1 / (RRF_K + rank + 1) });
    });
    semantic.forEach((hit, rank) => {
      const previous = merged.get(hit.chunkId);
      merged.set(hit.chunkId, {
        ...previous,
        ...hit,
        matchType: previous ? "hybrid" : "semantic",
        retrievalScore: (previous?.retrievalScore ?? 0) + 1 / (RRF_K + rank + 1),
      });
    });

    // Identical text, not an identical chunk id, is what costs the agent its
    // context: a library that predates content-addressed uploads holds documents
    // stored twice, and their chunks are different rows saying the same thing.
    const ordered = [...merged.values()].sort((left, right) => right.retrievalScore - left.retrievalScore);
    const seen = new Set<string>();
    const results: SearchHit[] = [];
    for (const hit of ordered) {
      if (seen.has(hit.excerpt)) continue;
      seen.add(hit.excerpt);
      results.push(hit);
      if (results.length === resultLimit) break;
    }
    return { mode, results, index };
  }

  private keywordSearch(query: string, limit: number, fileIds?: string[]): SearchHit[] {
    const rows = this.store.keywordChunks(query, limit, fileIds);
    const names = new Map(
      this.store.fileSummaries([...new Set(rows.map((row) => row.fileId))]).map((file) => [file.id, file.name]),
    );
    return rows
      .filter((row) => names.has(row.fileId))
      .map((row) => ({
        chunkId: row.id,
        id: row.fileId,
        name: names.get(row.fileId)!,
        excerpt: row.text,
        page: row.page,
        chunk: row.idx,
        semanticScore: null,
        matchType: "keyword" as const,
        retrievalScore: 0,
      }));
  }

  private async semanticSearch(query: string, limit: number, fileIds?: string[]): Promise<SearchHit[]> {
    const client = this.client();
    if (!client) return [];
    const [queryVector] = await client.embed([query]);
    if (!queryVector) return [];
    const scored = await this.vectors.search(client.model, normalizeVector(queryVector), limit, fileIds);
    if (!scored.length) return [];
    const chunks = new Map(this.store.chunksByIds(scored.map((row) => row.chunkId)).map((row) => [row.id, row]));
    const names = new Map(
      this.store.fileSummaries([...new Set(scored.map((row) => row.fileId))]).map((file) => [file.id, file.name]),
    );
    return scored.flatMap((row) => {
      const chunk = chunks.get(row.chunkId);
      const name = names.get(row.fileId);
      if (!chunk || !name) return [];
      return [
        {
          chunkId: row.chunkId,
          id: row.fileId,
          name,
          excerpt: chunk.text,
          page: chunk.page,
          chunk: chunk.idx,
          // Distance, so callers compute relevance the same way they did
          // against pgvector: relevance = 1 - semanticScore.
          semanticScore: 1 - row.similarity,
          matchType: "semantic" as const,
          retrievalScore: 0,
        } satisfies SearchHit,
      ];
    });
  }
}
