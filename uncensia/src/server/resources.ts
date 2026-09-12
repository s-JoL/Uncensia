import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import type { Store } from "./store/store.ts";
import { ingestFile, mimeForName } from "./library.ts";
import { extract } from "./rag/extract.ts";
import { downloadResource } from "./resource-download.ts";
import type { FileRecord } from "@shared/types.ts";

export interface ResourceRange { file_id?: string; entry_id?: string; quote_id?: string; start_line?: number; end_line?: number; encoding?: string; find_text?: string; version?: string; paragraph_count?: number }
export function messageText(message: unknown) {
  const content = (message as { content?: unknown })?.content;
  return typeof content === "string" ? content : Array.isArray(content) ? content.filter(p => p.type === "text").map(p => p.text).join("\n") : "";
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
  if ([range.file_id, range.entry_id, range.quote_id].filter(Boolean).length !== 1) throw new Error("Specify exactly one file_id, entry_id or quote_id");
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
    const row = store.db.get<{ content: string; role: string }>("SELECT content,role FROM messages WHERE conversation_id=? AND entry_id=?", conversationId, range.entry_id);
    if (!row) throw new Error("Message not found in this conversation. Use search_history for entry IDs; an excerpt://quote_ link is a quote_id, not an entry_id.");
    text = messageText(JSON.parse(row.content)); title = `${row.role} ${range.entry_id}`;
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
  if (selected.length > 200_000) throw new Error("Selected text is too large; choose a smaller line range");
  return { title, version, start_line: start, end_line: end, total_lines: lines.length, next_line: end < lines.length ? end + 1 : null, text: selected };
}

export async function quoteResource(store: Store, conversationId: string, range: ResourceRange) {
  const selected = await readResource(store, conversationId, range);
  const id = `quote_${createHash("sha256").update(JSON.stringify([conversationId, range.file_id ?? range.entry_id ?? range.quote_id, selected])).digest("hex").slice(0, 32)}`;
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

export interface Deliverable { key: string; description: string; status: "pending" | "produced" | "verified"; asset_id?: string; evidence?: string }
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
  if (item.asset_id && store.db.get("SELECT 1 FROM deliverables WHERE conversation_id=? AND key<>? AND json_extract(data,'$.asset_id')=?", conversationId, item.key, item.asset_id)) throw new Error("This asset already belongs to another deliverable; do not count it twice");
  store.db.run("INSERT INTO deliverables(conversation_id,key,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(conversation_id,key) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at", conversationId, item.key, JSON.stringify(item), Date.now());
  return item;
}
