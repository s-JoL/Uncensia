import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Store } from "./store/store.ts";
import { ingestFile, mimeForName } from "./library.ts";
import { extract } from "./rag/extract.ts";
import { downloadResource } from "./resource-download.ts";
import type { FileRecord } from "@shared/types.ts";
import type { DeliverableInput, DeliverableRecord } from "@shared/evidence.ts";
import { conversationProject, projectFileFilter } from "./projects.ts";

export interface ResourceRange { file_id?: string; entry_id?: string; quote_id?: string; history_ref?: string; start_line?: number; end_line?: number; start_character?: number; max_characters?: number; encoding?: string; find_text?: string; version?: string; paragraph_count?: number }
export function messageText(message: unknown) {
  const content = (message as { content?: unknown })?.content;
  return typeof content === "string" ? content : Array.isArray(content) ? content.filter(p => p.type === "text").map(p => p.text).join("\n") : "";
}

export interface MessageFeedback {
  entry_id: string;
  text: string;
  created_at: number;
}

export function listFeedback(store: Store, conversationId: string, limit = 50) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Choose a feedback limit of 1–50");
  return store.db.all<MessageFeedback>(
    "SELECT entry_id,text,created_at FROM message_feedback WHERE conversation_id=? ORDER BY created_at DESC LIMIT ?",
    conversationId,
    limit,
  );
}

/** A keyset cursor fixes membership at the first page; later inserts cannot shift it. */
export function listResources(store: Store, input: { query?: string; kind?: string; limit?: number; cursor?: string; projectId?: string | null }) {
  const query = input.query?.trim() ?? "", kind = input.kind ?? "all";
  if (!["all", "docs", "images", "videos"].includes(kind)) throw new Error("Invalid resource kind");
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Choose a page size of 1–100");
  const scope = projectFileFilter(input.projectId), scopeKey = input.projectId ?? (input.projectId === null ? "unassigned" : "personal");
  type Cursor = { query: string; kind: string; scopeKey: string; snapshot: number; at: number; id: string };
  let cursor: Cursor | undefined;
  if (input.cursor) {
    try { cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString()); } catch { throw new Error("Invalid resource cursor"); }
    if (!cursor || cursor.query !== query || cursor.kind !== kind || cursor.scopeKey !== scopeKey || !Number.isSafeInteger(cursor.snapshot) || !Number.isSafeInteger(cursor.at) || typeof cursor.id !== "string") throw new Error("Invalid resource cursor or changed filters");
  }
  const snapshot = cursor?.snapshot ?? store.db.get<{ n: number }>("SELECT COALESCE(MAX(rowid),0) n FROM files")!.n;
  const kindSql = kind === "images" ? "AND mime LIKE 'image/%'" : kind === "videos" ? "AND mime LIKE 'video/%'" : kind === "docs" ? "AND mime NOT LIKE 'image/%' AND mime NOT LIKE 'video/%'" : "";
  const where = `f.rowid <= ? AND name LIKE ? ${kindSql} AND ${scope.sql}`;
  const rows = store.db.all<{ id: string; created_at: number }>(`SELECT id,created_at FROM files f WHERE ${where} ${cursor ? "AND (created_at < ? OR (created_at = ? AND id > ?))" : ""} ORDER BY created_at DESC,id LIMIT ?`,
    snapshot, `%${query}%`, ...scope.args, ...(cursor ? [cursor.at,cursor.at,cursor.id] : []), limit + 1);
  const hasMore = rows.length > limit, selected = rows.slice(0,limit), last = selected.at(-1);
  return {
    items: selected.map(row => { const { diskPath: _path, ...file } = store.getFile(row.id)!; return file; }),
    total: store.db.get<{ n: number }>(`SELECT COUNT(*) n FROM files f WHERE ${where}`, snapshot, `%${query}%`, ...scope.args)!.n,
    next_cursor: hasMore && last ? Buffer.from(JSON.stringify({query,kind,scopeKey,snapshot,at:last.created_at,id:last.id})).toString("base64url") : null,
  };
}

/** Explicit personal scope grants a reference to a search result, never an arbitrary foreign entry ID. */
export function searchHistory(store: Store, conversationId: string, input: { query?: string; scope?: "conversation" | "project" | "personal"; limit?: number; offset?: number }) {
  const scope = input.scope ?? "conversation", limit = input.limit ?? 15, offset = input.offset ?? 0;
  if (!["conversation", "project", "personal"].includes(scope) || !Number.isSafeInteger(limit) || limit < 1 || limit > 30 || !Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid history scope or page");
  const query = input.query?.trim() ?? "", indexed = [...query].length >= 3;
  const filters: string[] = [], args: unknown[] = [];
  if (scope === "conversation") { filters.push("m.conversation_id = ?"); args.push(conversationId); }
  if (scope === "project") {
    const project = conversationProject(store,conversationId);
    if (!project) throw new Error("This conversation has no project; choose conversation or personal scope");
    filters.push("EXISTS (SELECT 1 FROM conversation_projects cp WHERE cp.conversation_id=m.conversation_id AND cp.project_id=?)"); args.push(project.id);
  }
  if (query) { filters.push(indexed ? "messages_fts MATCH ?" : "instr(lower(s.text), lower(?)) > 0"); args.push(indexed ? `"${query.replaceAll('"','""')}"` : query); }
  filters.push("m.entry_id IS NOT NULL");
  const rows = store.db.all<{ conversation_id: string; entry_id: string; content: string; seq: number; role: string; created_at: number }>(
    `SELECT m.* FROM messages m ${query ? "JOIN messages_fts s ON s.rowid=m.rowid" : ""} WHERE ${filters.join(" AND ")} ORDER BY ${query && indexed ? "s.rank," : ""} m.created_at DESC,m.conversation_id,m.seq DESC LIMIT ? OFFSET ?`, ...args, limit + 1, offset);
  const messages = rows.slice(0,limit).map(row => {
    const text = messageText(JSON.parse(row.content));
    const position = query ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : 0;
    const start = Math.max(0,position - 400);
    const ref = `history_${createHash("sha256").update(JSON.stringify([conversationId,row.conversation_id,row.entry_id])).digest("hex").slice(0,32)}`;
    store.db.run("INSERT OR IGNORE INTO resource_history_refs(id,conversation_id,source_conversation_id,entry_id) VALUES(?,?,?,?)",ref,conversationId,row.conversation_id,row.entry_id);
    return { conversationId: row.conversation_id, entry_id: row.entry_id, history_ref: ref, seq: row.seq, role: row.role, createdAt: row.created_at, content: text.slice(start,start + 1500), start_character: start, total_characters: text.length };
  });
  return {
    messages,
    next_offset: rows.length > limit ? offset + limit : null,
    feedback: listFeedback(store, conversationId, 30),
  };
}

export async function acquireResource(store: Store, input: { url: string; name?: string; conversationId?: string }, index?: (file: FileRecord & { diskPath: string }) => Promise<unknown>, signal?: AbortSignal, dnsUrl?: string, authorize?: () => void) {
  const downloaded = await downloadResource(input.url, signal, dnsUrl);
  let name = input.name?.trim() || decodeURIComponent(new URL(downloaded.url).pathname.split("/").pop() || "resource");
  name = path.basename(name).slice(0, 200);
  let mime = downloaded.mime === "application/octet-stream" ? mimeForName(name) : downloaded.mime;
  if (mime.startsWith("image/")) {
    const metadata = await sharp(downloaded.bytes, { limitInputPixels: 80_000_000 }).metadata();
    if (!metadata.width || !metadata.height || !["png", "jpeg", "webp", "gif"].includes(metadata.format ?? "")) throw new Error("Resource is not a supported readable image");
    mime = `image/${metadata.format}`;
  }
  if (mime === "text/html" && /\.(txt|pdf|epub|png|jpe?g|webp)$/i.test(name)) throw new Error("The server returned an HTML page instead of the requested document/image");
  if (mime === "application/pdf" && !downloaded.bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Resource is not a PDF document");
  signal?.throwIfAborted();
  authorize?.();
  const { file } = ingestFile(store, { name, bytes: downloaded.bytes, mime, conversationId: input.conversationId, source: "web" });
  const source = { original_url: input.url, final_url: downloaded.url, fetched_at: new Date().toISOString(), mime, sha256: file.sha256, declared_encoding: /charset\s*=\s*["']?([^;\s"']+)/i.exec(downloaded.contentType)?.[1] ?? null };
  store.db.run("INSERT INTO resource_sources(id,file_id,data,created_at) VALUES(?,?,?,?)", randomUUID(), file.id, JSON.stringify(source), Date.now());
  let indexing = "not_requested";
  if (!mime.startsWith("image/") && !mime.startsWith("video/") && index) {
    try { await index(file); indexing = store.getFile(file.id)?.embeddingStatus ?? "deleted"; }
    catch (error) { indexing = `failed: ${String(error)}`; }
  }
  return { file_id: file.id, name, mime, bytes: file.bytes, source, indexing, index_error: store.getFile(file.id)?.embeddingError ?? null };
}

export async function readResource(store: Store, conversationId: string, range: ResourceRange) {
  if ([range.file_id, range.entry_id, range.quote_id, range.history_ref].filter(Boolean).length !== 1) throw new Error("Specify exactly one file_id, entry_id, quote_id or history_ref");
  let text: string, title: string, version: string;
  if (range.quote_id) {
    const quote = getQuote(store, range.quote_id);
    if (!quote) throw new Error("Excerpt not found; copy the quote_ ID from its excerpt:// link");
    text = quote.text; title = quote.title;
    version = createHash("sha256").update(text).digest("hex");
  } else if (range.file_id) {
    const file = store.getFile(range.file_id);
    if (!file) throw new Error("Resource file not found. Use list_resources for file IDs, or quote_id for an excerpt://quote_ link.");
    title = file.name;
    const bytes = fs.readFileSync(file.diskPath);
    version = createHash("sha256").update(bytes).digest("hex");
    if (range.encoding) {
      if (!file.mime.startsWith("text/") && file.mime !== "application/json") throw new Error("Encoding is only supported for text documents");
      text = new TextDecoder(range.encoding, { fatal: true }).decode(bytes);
    } else if ((file.mime.startsWith("text/") && file.mime !== "text/html") || file.mime === "application/json") {
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new Error("Unsupported text encoding; specify encoding explicitly, for example gb18030"); }
    } else {
      const extraction = await extract(file.diskPath, file.name, file.mime);
      text = extraction.pages.map(p => p.text).join("\n\n");
    }
    if (!text) throw new Error("No readable text. Check the format and encoding; scanned documents need OCR.");
  } else {
    const ref = range.history_ref ? store.db.get<{ source_conversation_id: string; entry_id: string }>("SELECT source_conversation_id,entry_id FROM resource_history_refs WHERE id=? AND conversation_id=?",range.history_ref,conversationId) : undefined;
    if (range.history_ref && !ref) throw new Error("History reference not found in this conversation; search again with the intended scope");
    const row = store.db.get<{ content: string; role: string }>("SELECT content,role FROM messages WHERE conversation_id=? AND entry_id=?", ref?.source_conversation_id ?? conversationId, ref?.entry_id ?? range.entry_id);
    if (!row) throw new Error("Message not found in this conversation. Use search_history for entry IDs; an excerpt://quote_ link is a quote_id, not an entry_id.");
    text = messageText(JSON.parse(row.content)); title = `${row.role} ${ref?.entry_id ?? range.entry_id}`;
    version = createHash("sha256").update(text).digest("hex");
  }
  const lines = text.split(/\r?\n/);
  if (range.version && range.version !== version) throw new Error("Resource changed since it was read; read the current version before quoting");
  const found = range.find_text ? lines.findIndex(line => line.includes(range.find_text!)) : -1;
  if (range.find_text && found < 0) throw new Error("Exact text not found in resource");
  const start = range.start_line ?? (found >= 0 ? found + 1 : 1);
  if (!Number.isSafeInteger(start) || start < 1 || start > lines.length) throw new Error(`Invalid start line; document contains ${lines.length} lines`);
  let end = range.end_line ?? Math.min(lines.length, start + 199);
  if (range.paragraph_count !== undefined) {
    if (range.end_line !== undefined || !Number.isSafeInteger(range.paragraph_count) || range.paragraph_count < 1 || range.paragraph_count > 50) throw new Error("Choose a paragraph count of 1–50 or end_line, not both");
    let remaining = range.paragraph_count, inParagraph = false;
    end = start;
    for (let i = start - 1; i < lines.length; i++) {
      if (lines[i]!.trim()) { inParagraph = true; end = i + 1; }
      else if (inParagraph) { if (--remaining === 0) break; inParagraph = false; }
    }
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > lines.length || end - start >= 2000) throw new Error(`Invalid line range; document contains ${lines.length} lines; maximum 2000 per request`);
  const selected = lines.slice(start - 1, end).join("\n");
  const windowed = range.start_character !== undefined || range.max_characters !== undefined;
  const limit = windowed ? range.max_characters ?? 8000 : 200_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || (windowed && limit > 12000)) throw new Error("Choose max_characters from 1 to 12000");
  if (!windowed && selected.length > limit) throw new Error("Selected text is too large; use max_characters and follow next_character");
  // Character cursors are UTF-16 offsets in this numbered line range, not byte
  // positions. Returning both cursors makes giant single lines readable too.
  let offset = range.start_character ?? (windowed && range.find_text ? Math.max(0, selected.indexOf(range.find_text) - 200) : 0);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > selected.length) throw new Error("Invalid character offset");
  const splitsPair = (at: number) => at > 0 && /[\uD800-\uDBFF]/.test(selected[at - 1]!) && /[\uDC00-\uDFFF]/.test(selected[at] ?? "");
  if (splitsPair(offset)) {
    if (range.start_character !== undefined) throw new Error("Character offset splits a Unicode character");
    offset--;
  }
  let stop = Math.min(selected.length, offset + limit);
  if (splitsPair(stop)) stop--;
  if (stop === offset && offset < selected.length) throw new Error("Character limit is too small for this Unicode character");
  const prefix = selected.slice(0, offset);
  const next = stop < selected.length ? stop : null;
  return { title, version, start_line:start, end_line:end, total_lines:lines.length,
    start_character:offset, next_character:next, total_characters:selected.length,
    text_start_line:start + prefix.split("\n").length - 1, text_start_column:offset - prefix.lastIndexOf("\n"),
    next_line:next === null && end < lines.length ? end + 1 : null, text:selected.slice(offset,stop) };
}

export async function quoteResource(store: Store, conversationId: string, range: ResourceRange) {
  const selected = await readResource(store, conversationId, range);
  const id = `quote_${createHash("sha256").update(JSON.stringify([conversationId, range.file_id ?? range.entry_id ?? range.quote_id ?? range.history_ref, selected])).digest("hex").slice(0, 32)}`;
  let snapshotId = getQuote(store, id)?.file_id;
  if (!snapshotId) {
    // A quote must never make a byte-identical editable original immutable.
    snapshotId = ingestFile(store, { name: `${selected.title.slice(0, 120)}-excerpt.txt`, bytes: Buffer.from(selected.text), conversationId, source: "excerpt", deduplicate: false }).file.id;
    const data = { ...selected, source: range, file_id: snapshotId };
    store.db.run("INSERT INTO resource_quotes(id,conversation_id,file_id,data,created_at) VALUES(?,?,?,?,?)", id, conversationId, snapshotId, JSON.stringify(data), Date.now());
  }
  return { id, file_id: snapshotId, title: selected.title, start_line: selected.start_line, end_line: selected.end_line, characters: selected.text.length, boundary_preview: { start: selected.text.slice(0, 60), end: selected.text.slice(-60) }, link: `[Original text](excerpt://${id})` };
}

export function getQuote(store: Store, id: string) {
  const row = store.db.get<{ data: string }>("SELECT data FROM resource_quotes WHERE id=?", id);
  return row ? JSON.parse(row.data) as { text: string; title: string; version: string; start_line: number; end_line: number; file_id: string } : undefined;
}

export function saveFeedback(store: Store, conversationId: string, entryId: string, text: string) {
  if (!store.db.get("SELECT 1 FROM messages WHERE conversation_id=? AND entry_id=?", conversationId, entryId)) throw new Error("Message not found");
  if (!text.trim() || text.length > 4000) throw new Error("Feedback must contain 1–4000 characters");
  store.db.run("INSERT INTO message_feedback(conversation_id,entry_id,text,created_at) VALUES(?,?,?,?) ON CONFLICT(conversation_id,entry_id) DO UPDATE SET text=excluded.text,created_at=excluded.created_at", conversationId, entryId, text, Date.now());
  return { saved: true };
}

export type Deliverable = DeliverableInput;
export function deliverable(store: Store, conversationId: string, item: Deliverable) {
  if (item.asset_id?.startsWith("quote_")) {
    const quote = getQuote(store, item.asset_id);
    if (!quote) throw new Error("Deliverable excerpt not found");
    item = { ...item, asset_id: quote.file_id };
  }
  if (!item.key || item.key.length > 100 || !item.description || item.description.length > 4000 || !["pending", "produced", "verified"].includes(item.status)) throw new Error("Invalid deliverable");
  if ((item.asset_id && !store.getFile(item.asset_id)) || (item.status !== "pending" && !item.asset_id)) throw new Error("Deliverable asset not found");
  if ((item.evidence?.length ?? 0) > 6000) throw new Error("Inspection evidence exceeds 6000 characters");
  if (item.status === "verified" && !item.evidence?.trim()) throw new Error("Verified deliverables require inspection evidence");
  const row = store.db.get<{data:string}>("SELECT data FROM deliverables WHERE conversation_id=? AND key=?", conversationId, item.key);
  const previous: DeliverableRecord | undefined = row ? JSON.parse(row.data) : undefined;
  const sourceId = item.asset_id === previous?.asset_id ? previous?.source_asset_id ?? item.asset_id : item.asset_id;
  if (sourceId && store.db.get("SELECT 1 FROM deliverables WHERE conversation_id=? AND key<>? AND (json_extract(data,'$.asset_id')=? OR json_extract(data,'$.source_asset_id')=?)", conversationId, item.key, sourceId, sourceId)) throw new Error("This asset already belongs to another deliverable; do not count it twice");
  const file = item.asset_id ? store.getFile(item.asset_id)! : undefined;
  const bytes = file ? fs.readFileSync(file.diskPath) : undefined;
  const version = bytes ? createHash("sha256").update(bytes).digest("hex") : undefined;
  let assetId = item.asset_id;
  // Editable notes become immutable deliverables. Media and existing snapshots
  // already have immutable bytes and keep their identity/provenance.
  if (file && bytes && (file.mime.startsWith("text/") || file.mime === "application/json") && !["excerpt", "tool-output", "deliverable"].includes(file.source)) {
    assetId = previous && previous.source_asset_id === sourceId && previous.asset_version === version
      ? previous.asset_id
      : ingestFile(store, {name:file.name, mime:file.mime, bytes, conversationId, source:"deliverable", deduplicate:false}).file.id;
  }
  // Only these fields come from the model; it cannot supply a user's review.
  const next: DeliverableRecord = {
    key:item.key, description:item.description, status:item.status,
    asset_id:assetId, source_asset_id:sourceId, asset_version:version, evidence:item.evidence,
    revision:previous?.revision ?? 0,
  };
  const comparable = (value: DeliverableRecord) => JSON.stringify({...value, revision:0, review:undefined});
  if (previous && comparable(previous) === comparable(next)) return previous;
  next.revision++;
  store.db.transaction(() => {
    store.db.run("INSERT INTO deliverable_versions(conversation_id,key,revision,data) VALUES(?,?,?,?)", conversationId, next.key, next.revision, JSON.stringify(next));
    store.db.run("INSERT INTO deliverables(conversation_id,key,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(conversation_id,key) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at", conversationId, next.key, JSON.stringify(next), Date.now());
  });
  return next;
}

export function reviewDeliverable(store: Store, conversationId: string, key: string, revision: number, status: "accepted" | "rejected") {
  if (!["accepted", "rejected"].includes(status) || !Number.isSafeInteger(revision)) throw new Error("Invalid review");
  const row = store.db.get<{data:string}>("SELECT data FROM deliverables WHERE conversation_id=? AND key=?", conversationId, key);
  const item: DeliverableRecord | undefined = row ? JSON.parse(row.data) : undefined;
  if (!item || item.revision !== revision) throw new Error("Deliverable changed; refresh before reviewing");
  const file = item.asset_id ? store.getFile(item.asset_id) : undefined;
  if (item.status === "pending" || !file || !fs.existsSync(file.diskPath)) throw new Error("Deliverable asset not available");
  if (createHash("sha256").update(fs.readFileSync(file.diskPath)).digest("hex") !== item.asset_version) throw new Error("Deliverable content changed; produce a new version");
  item.review = {status, at:Date.now()};
  store.db.transaction(() => {
    store.db.run("UPDATE deliverables SET data=?,updated_at=? WHERE conversation_id=? AND key=?",JSON.stringify(item),Date.now(),conversationId,key);
    store.db.run("UPDATE deliverable_versions SET data=? WHERE conversation_id=? AND key=? AND revision=?",JSON.stringify(item),conversationId,key,revision);
  });
  return item;
}
