import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { compareDeliverables } from "../../deliverable-comparison.ts";
import type { Context } from "hono";
import type { FileKind, FileSearchMode, Provenance } from "@shared/types.ts";
import { MAX_UPLOAD_BYTES, paths } from "../../env.ts";
import { opsOf } from "../../generation/index.ts";
import { assetPath } from "../../images.ts";
import { ingestFile, mimeForName } from "../../library.ts";
import type { Services } from "../../services.ts";
import { readJson } from "../body.ts";
import { fail, failFromError } from "../errors.ts";
import { acquireResource, getQuote, listFeedback, readResource, saveFeedback, reviewDeliverable } from "../../resources.ts";

/** `diskPath` and `sha256` are server-side bookkeeping; clients get neither. */
function publicFile<T extends object>(file: T): Omit<T, "diskPath" | "sha256"> {
  const { diskPath: _diskPath, sha256: _sha256, ...rest } = file as T & { diskPath?: string; sha256?: string };
  return rest as Omit<T, "diskPath" | "sha256">;
}

export function fileRoutes(services: Services) {
  const app = new Hono();
  const { store, config, retrieval } = services;
  app.get("/resources/conversations/:id/evidence", context => {
    const id = context.req.param("id");
    if (!store.getConversation(id)) return fail(context, 404, "not_found", "Conversation not found");
    return context.json({
      deliverables: store.db.all<{ data: string }>("SELECT data FROM deliverables WHERE conversation_id=? ORDER BY updated_at,key", id).map(row => JSON.parse(row.data)),
      feedback: listFeedback(store, id),
      contexts: store.db.all<{ seq: number; data: string; run_id: string }>("SELECT seq,data,run_id FROM events e WHERE conversation_id=? AND (type='provider.request' OR (type='context.captured' AND seq=(SELECT MAX(seq) FROM events a WHERE a.run_id=e.run_id AND a.type='context.captured') AND NOT EXISTS (SELECT 1 FROM events p WHERE p.run_id=e.run_id AND p.type='provider.request'))) ORDER BY seq DESC LIMIT 30", id).map(row => ({ id:row.seq, runId: row.run_id, ...JSON.parse(row.data) })),
    });
  });

  app.get("/resources/conversations/:id/deliverables/:key/versions", context => context.json(
    store.db.all<{data:string}>("SELECT data FROM deliverable_versions WHERE conversation_id=? AND key=? ORDER BY revision DESC", context.req.param("id"), context.req.param("key")).map(row => JSON.parse(row.data)),
  ));
  app.get("/resources/conversations/:id/deliverables/:key/compare", context => {
    try { return context.json(compareDeliverables(store,context.req.param("id"),context.req.param("key"),Number(context.req.query("from")),Number(context.req.query("to")))); }
    catch(error) { return fail(context,400,"comparison_failed",String(error)); }
  });
  app.post("/resources/conversations/:id/deliverables/:key/review", async context => {
    try {
      const body = await readJson<{revision:number; status:"accepted"|"rejected"}>(context);
      if (typeof body.revision !== "number" || !body.status) return fail(context, 400, "invalid", "Revision and review status are required");
      return context.json(reviewDeliverable(store, context.req.param("id"), context.req.param("key"), body.revision, body.status));
    } catch (error) { return fail(context, 409, "review_conflict", String(error)); }
  });

  app.post("/resources/acquire", async context => {
    if (!config.capabilities().files.enabled || !config.capabilities().web.enabled) return fail(context, 403, "disabled", "Library and web access must be enabled");
    try {
      const body = await readJson<{ url: string; name?: string }>(context);
      if (typeof body.url !== "string" || (body.name !== undefined && typeof body.name !== "string")) return fail(context, 400, "invalid", "Expected a URL and optional filename");
      return context.json(await acquireResource(store, { url: body.url, name: body.name }, config.capabilities().files.searchEnabled ? file => retrieval.indexFile(file) : undefined, context.req.raw.signal, config.capabilities().web.downloadDnsUrl, () => { if (!config.capabilities().files.enabled || !config.capabilities().web.enabled) throw new Error("Library or web access was disabled during download"); }));
    } catch (error) { return fail(context, 400, "resource_failed", String(error)); }
  });
  app.get("/resources/quotes/:id", context => {
    const quote = getQuote(store, context.req.param("id"));
    return quote ? context.json(quote) : fail(context, 404, "not_found", "Excerpt not found");
  });
  app.get("/resources/files/:id", async context => {
    try {
      const id = context.req.param("id");
      const range = { file_id:id, start_line:Number(context.req.query("start") ?? 1), end_line:context.req.query("end") ? Number(context.req.query("end")) : undefined, start_character:context.req.query("character") ? Number(context.req.query("character")) : undefined, max_characters:12000, version:context.req.query("version"), encoding:context.req.query("encoding") };
      return context.json(await readResource(store, "", range));
    } catch (error) { return fail(context, 400, "resource_failed", String(error)); }
  });
  app.get("/resources/sources/:id", context => context.json(store.db.all<{ data: string }>("SELECT data FROM resource_sources WHERE file_id=? ORDER BY created_at DESC", context.req.param("id")).map(row => JSON.parse(row.data))));
  app.post("/resources/feedback", async context => {
    try {
      const body = await readJson<{ conversationId: string; seq: number; text: string }>(context);
      if (typeof body.conversationId !== "string" || typeof body.seq !== "number" || !Number.isSafeInteger(body.seq) || typeof body.text !== "string") return fail(context, 400, "invalid", "Invalid feedback");
      const entryId = store.messageEntryId(body.conversationId, body.seq);
      if (!entryId) return fail(context, 404, "not_found", "Message not found");
      return context.json(saveFeedback(store, body.conversationId, entryId, body.text));
    } catch (error) { return fail(context, 400, "invalid", String(error)); }
  });

  app.get("/files", (context) => {
    const query = context.req.query();
    const library = store.listFiles({
      kind: (query.kind as FileKind) ?? "all",
      source: query.source ?? "all",
      query: query.q ?? "",
      limit: Number(query.limit ?? 60),
      offset: Number(query.offset ?? 0),
    });
    return context.json({ ...library, items: library.items.map(publicFile) });
  });

  /**
   * A note is a file the user writes here rather than uploads, so it lands in
   * the same library and the same index as everything else and `file_search`
   * can reach it immediately.
   */
  app.post("/files/notes", async (context) => {
    const body = await readJson<{ name: string; text: string }>(context);
    if ((body.name !== undefined && typeof body.name !== "string") || (body.text !== undefined && typeof body.text !== "string")) {
      return fail(context, 400, "invalid", "name and text must be strings");
    }
    const name = (body.name ?? "").trim() || "未命名文档";
    const file = await writeNote(services, name.endsWith(".md") ? name : `${name}.md`, body.text ?? "");
    return context.json(publicFile(file), 201);
  });

  app.get("/files/:id/text", (context) => {
    const file = store.getFile(context.req.param("id"));
    if (!file || !fs.existsSync(file.diskPath)) return fail(context, 404, "not_found", "File not found");
    if (!isTextual(file.mime)) return fail(context, 400, "invalid", "This file is not editable text");
    return context.json({ id: file.id, name: file.name, text: fs.readFileSync(file.diskPath, "utf8") });
  });

  app.put("/files/:id/text", async (context) => {
    const file = store.getFile(context.req.param("id"));
    if (file && (["tool-output", "deliverable"].includes(file.source) || store.db.get("SELECT 1 FROM resource_quotes WHERE file_id=?", file.id))) return fail(context, 409, "immutable", "Original snapshots are immutable; create a new document to edit this text");
    if (!file) return fail(context, 404, "not_found", "File not found");
    if (!isTextual(file.mime)) return fail(context, 400, "invalid", "This file is not editable text");
    const body = await readJson<{ name: string; text: string }>(context);
    if ((body.name !== undefined && typeof body.name !== "string") || typeof body.text !== "string") {
      return fail(context, 400, "invalid", "text is required and name and text must be strings");
    }
    const updated = await writeNote(services, (body.name ?? file.name).trim() || file.name, body.text, file.id);
    return context.json(publicFile(updated));
  });

  app.post("/files", async (context) => {
    const form = await context.req.formData().catch(() => null);
    const upload = form?.get("file");
    if (!(upload instanceof File)) return fail(context, 400, "invalid", "file is required");
    if (upload.size > MAX_UPLOAD_BYTES) {
      return fail(context, 413, "too_large", `File exceeds ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
    }
    const { file, created } = ingestFile(store, {
      name: upload.name, mime: upload.type, bytes: Buffer.from(await upload.arrayBuffer()),
      conversationId: String(form?.get("conversationId") ?? "") || null,
    });
    const capability = config.capabilities().files;
    if (created && !file.mime.startsWith("image/") && !file.mime.startsWith("video/") && capability.enabled && capability.searchEnabled) {
      void retrieval.indexFile(file).catch((error: unknown) => console.error(`[rag] ${file.id}:`, error));
    }
    return context.json(publicFile(file), created ? 201 : 200);
  });

  app.get("/files/:id", (context) => {
    const file = store.getFile(context.req.param("id"));
    if (!file) return fail(context, 404, "not_found", "File not found");
    return context.json(publicFile(file));
  });

  app.get("/files/:id/content", (context) => {
    const file = store.getFile(context.req.param("id"));
    if (!file || !fs.existsSync(file.diskPath)) return fail(context, 404, "not_found", "File not found");
    return new Response(new Uint8Array(fs.readFileSync(file.diskPath)), {
      headers: {
        "content-type": file.mime,
        // Notes are edited in place; the same URL can now contain new bytes.
        "cache-control": "private, no-cache",
        "content-disposition": `${context.req.query("download") === "1" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "content-security-policy": "sandbox",
        "x-content-type-options": "nosniff",
      },
    });
  });

  app.delete("/files/:id", (context) => {
    const file = store.deleteFile(context.req.param("id"));
    if (file && fs.existsSync(file.diskPath)) fs.rmSync(file.diskPath, { force: true });
    return context.body(null, 204);
  });

  app.post("/files/:id/reindex", async (context) => {
    const file = store.getFile(context.req.param("id"));
    if (!file) return fail(context, 404, "not_found", "File not found");
    try {
      const result = await retrieval.indexFile(file);
      return context.json({ ...publicFile(store.getFile(file.id)!), ...result });
    } catch (error) {
      return failFromError(context, error);
    }
  });

  app.post("/files/search", async (context) => {
    const body = await readJson<{ query: string; mode: FileSearchMode; limit: number; fileIds?: string[] }>(context);
    if (typeof body.query !== "string") return fail(context, 400, "invalid", "query must be a string");
    const query = body.query.trim();
    if (!query) return fail(context, 400, "invalid", "query is required");
    if (body.mode !== undefined && body.mode !== "keyword" && body.mode !== "semantic" && body.mode !== "hybrid") {
      return fail(context, 400, "invalid", "mode must be keyword, semantic or hybrid");
    }
    if (body.limit !== undefined && (typeof body.limit !== "number" || !Number.isInteger(body.limit) || body.limit < 1 || body.limit > 50)) {
      return fail(context, 400, "invalid", "limit must be an integer from 1 to 50");
    }
    try {
      const mode = body.mode ?? config.capabilities().files.mode;
      if (body.fileIds !== undefined && (!Array.isArray(body.fileIds) || body.fileIds.some((id) => typeof id !== "string"))) return fail(context, 400, "invalid", "fileIds must be an array of file IDs");
      // An explicitly empty selection must not broaden into the entire library.
      if (body.fileIds?.length === 0) return context.json({ mode, results: [], index: store.fileIndexSummary() });
      return context.json(await retrieval.searchFiles(query, mode, body.limit ?? 10, body.fileIds));
    } catch (error) {
      return failFromError(context, error);
    }
  });

  /**
   * Serves generated images by their `img_<hex>` id. Generated files are not
   * rows in `files`, so fall back to the asset directory.
   */
  app.get("/images/:imageId", async (context) => {
    const imageId = context.req.param("imageId");
    if (!/^img_[0-9a-f]{32}$/i.test(imageId)) return fail(context, 400, "invalid", "Malformed image id");
    const record = store.getFile(imageId);
    const diskPath = record?.diskPath ?? assetPath(imageId);
    if (!diskPath || !fs.existsSync(diskPath)) return fail(context, 404, "not_found", "Image not found");
    const mime = record?.mime ?? mimeForName(diskPath);

    const width = THUMBNAIL_WIDTHS.find((size) => size === Number(context.req.query("w")));
    if (width && mime !== "image/gif") {
      const thumb = await thumbnail(diskPath, imageId, width).catch(() => "");
      if (thumb) {
        return new Response(new Uint8Array(fs.readFileSync(thumb)), {
          headers: { "content-type": "image/webp", "cache-control": "private, max-age=31536000, immutable" },
        });
      }
    }

    return new Response(new Uint8Array(fs.readFileSync(diskPath)), {
      headers: { "content-type": mime, "cache-control": "private, max-age=31536000, immutable" },
    });
  });

  /**
   * Serves generated video by its `vid_<hex>` id, honouring `Range`. A browser
   * seeking in a video sends one, and a server that ignores it makes every
   * scrub download the whole file again.
   */
  app.get("/videos/:videoId", (context) => {
    const videoId = context.req.param("videoId");
    if (!/^vid_[0-9a-f]{32}$/i.test(videoId)) return fail(context, 400, "invalid", "Malformed video id");
    const record = store.getFile(videoId);
    const diskPath = record?.diskPath ?? assetPath(videoId);
    if (!diskPath || !fs.existsSync(diskPath)) return fail(context, 404, "not_found", "Video not found");
    const mime = record?.mime ?? store.getVideoAsset(videoId)?.mime ?? "video/mp4";
    const total = fs.statSync(diskPath).size;
    const common = {
      "content-type": mime,
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=31536000, immutable",
    };

    const range = /^bytes=(\d*)-(\d*)$/.exec(context.req.header("range") ?? "");
    if (!range) {
      return new Response(new Uint8Array(fs.readFileSync(diskPath)), {
        headers: { ...common, "content-length": String(total) },
      });
    }
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
    if (!Number.isFinite(start) || start > end || start >= total) {
      return new Response(null, { status: 416, headers: { ...common, "content-range": `bytes */${total}` } });
    }
    const handle = fs.openSync(diskPath, "r");
    try {
      const chunk = Buffer.alloc(end - start + 1);
      fs.readSync(handle, chunk, 0, chunk.byteLength, start);
      return new Response(new Uint8Array(chunk), {
        status: 206,
        headers: {
          ...common,
          "content-length": String(chunk.byteLength),
          "content-range": `bytes ${start}-${end}/${total}`,
        },
      });
    } finally {
      fs.closeSync(handle);
    }
  });

  /**
   * Where one asset came from. Two rows answer it — the asset knows its backend
   * and its parents, the job knows the prompt and the parameters — and neither is
   * asked to keep the other's copy, so the two can never disagree.
   *
   * Both media get the same route because the question is the same one, and a
   * client that has an id already knows which kind it holds from its prefix.
   */
  const provenance = (context: Context, assetId: string, kind: "image" | "video") => {
    const asset = kind === "image" ? store.getImageAsset(assetId) : undefined;
    const video = kind === "video" ? store.getVideoAsset(assetId) : undefined;
    const file = store.getFile(assetId);
    // Neither an asset row nor a library row means nothing here made this and
    // nothing here has it, which is a 404 rather than an empty answer.
    if (!asset && !video && !file) return fail(context, 404, "not_found", "Asset not found");

    const job = store.jobForAsset(assetId);
    const produced = job?.assets.find(item => item.assetId === assetId);
    const model = job ? store.getModel(job.modelId) : undefined;
    const record: Provenance = {
      assetId,
      kind,
      mime: asset?.mime ?? video?.mime ?? file?.mime ?? (kind === "image" ? "image/png" : "video/mp4"),
      width: asset?.width ?? video?.width ?? file?.width ?? null,
      height: asset?.height ?? video?.height ?? file?.height ?? null,
      durationMs: video?.durationMs ?? null,
      provider: asset?.provider ?? video?.provider ?? produced?.provider ?? file?.source ?? null,
      model: asset?.model ?? video?.model ?? produced?.model ?? null,
      parents: asset?.parentImageIds.length ? asset.parentImageIds : video?.parentImageIds.length ? video.parentImageIds : job?.sources ?? [],
      createdAt: asset?.createdAt ?? video?.createdAt ?? file?.createdAt ?? 0,
      job: job
        ? {
            id: job.id,
            op: job.op,
            modelId: job.modelId,
            modelName: job.modelName,
            repeatable: Boolean(model?.enabled && opsOf(model).includes(job.op)),
            params: job.params,
            sources: job.sources,
            elapsedMs: job.finishedAt && job.startedAt ? job.finishedAt - job.startedAt : null,
          }
        : undefined,
    };
    return context.json(record);
  };

  app.get("/images/:imageId/provenance", (context) => {
    const imageId = context.req.param("imageId");
    if (!/^img_[0-9a-f]{32}$/i.test(imageId)) return fail(context, 400, "invalid", "Malformed image id");
    return provenance(context, imageId.toLowerCase(), "image");
  });

  app.get("/videos/:videoId/provenance", (context) => {
    const videoId = context.req.param("videoId");
    if (!/^vid_[0-9a-f]{32}$/i.test(videoId)) return fail(context, 400, "invalid", "Malformed video id");
    return provenance(context, videoId.toLowerCase(), "video");
  });

  return app;
}

const TEXT_MIMES = new Set(["text/markdown", "text/plain", "text/csv", "application/json", "text/html"]);
const isTextual = (mime: string) => TEXT_MIMES.has(mime) || mime.startsWith("text/");

/**
 * Creates or rewrites a user-authored document. Await indexing so an acknowledged
 * edit is searchable, and invalidate old chunks even when indexing is disabled.
 */
async function writeNote(services: Services, name: string, text: string, existingId?: string) {
  const { store, config, retrieval } = services;
  const id = existingId ?? `file_${randomBytes(16).toString("hex")}`;
  fs.mkdirSync(paths.files, { recursive: true });
  const diskPath = store.getFile(id)?.diskPath ?? path.join(paths.files, `${id}.md`);
  const bytes = Buffer.from(text, "utf8");
  fs.writeFileSync(diskPath, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const file = existingId
    ? store.updateFileContent(id, { name, bytes: bytes.byteLength, sha256 })
    : store.addFile({
        id,
        name,
        mime: "text/markdown",
        bytes: bytes.byteLength,
        diskPath,
        sha256,
        source: "note",
      });

  // A brand-new note whose text already exists byte for byte folds into the
  // entry that holds it, so the file just written here has nothing pointing at
  // it. Index against the row that survived rather than the id minted above.
  if (file.id !== id) fs.rmSync(diskPath, { force: true });

  if (existingId) {
    retrieval.invalidateFile(file.id);
    store.replaceChunks(file.id, []);
    store.setFileEmbeddingStatus(file.id, "none");
  }
  const capability = config.capabilities().files;
  if (capability.enabled && capability.searchEnabled) {
    await retrieval
      .indexFile({ id: file.id, name: file.name, mime: file.mime, diskPath: file.diskPath })
      .catch((error: unknown) => console.error(`[rag] ${file.id}:`, error));
  }
  // Indexing can fail after the bytes were saved. Return the persisted outcome
  // (including embeddingStatus/embeddingError), never the pre-index snapshot.
  return store.getFile(file.id) ?? file;
}

/** Fixed rungs keep the on-disk cache bounded and the URLs cacheable. */
const THUMBNAIL_WIDTHS = [320, 640, 1280];

async function thumbnail(source: string, imageId: string, width: number) {
  const target = path.join(paths.thumbs, `${imageId}_${width}.webp`);
  if (fs.existsSync(target)) return target;
  const { default: sharp } = await import("sharp");
  fs.mkdirSync(paths.thumbs, { recursive: true });
  await sharp(source, { animated: false })
    .rotate()
    .resize({ width, withoutEnlargement: true })
    .webp({ quality: 80 })
    .toFile(target);
  return target;
}
