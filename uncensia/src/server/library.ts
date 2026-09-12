/** One ingestion path for browser uploads and files produced in the workspace. */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MAX_UPLOAD_BYTES, paths } from "./env.ts";
import { forgetAssetIndex, writeImageSidecar } from "./images.ts";
import type { Store } from "./store/store.ts";
import { linkConversationFile } from "./projects.ts";

const EXTENSION_MIME: Record<string, string> = {
  ".epub": "application/epub+zip",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
  ".json": "application/json", ".html": "text/html", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const MIME_EXTENSION = Object.fromEntries(Object.entries(EXTENSION_MIME).map(([extension, mime]) => [mime, extension]));
export const mimeForName = (name: string) => EXTENSION_MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";

/** Save complete tool text before its transcript projection is bounded. */
export function preserveToolOutput(store: Store, conversationId: string, text: string) {
  const bytes = Buffer.from(text), sha = createHash("sha256").update(bytes).digest("hex");
  const existing = store.db.get<{id:string}>("SELECT id FROM files WHERE source='tool-output' AND sha256=? AND conversation_id=?",sha,conversationId);
  const id = existing?.id ?? ingestFile(store,{name:"tool-output.txt",bytes,conversationId,source:"tool-output",deduplicate:false}).file.id;
  return `Full original output: [Read or download](file://${id}). file_id=${id}; ${bytes.length} bytes; SHA-256=${sha}. Use read_resource to read any range; do not reconstruct omitted text.`;
}

export function ingestFile(store: Store, input: { name: string; bytes: Buffer; mime?: string; conversationId?: string | null; source?: string; deduplicate?: boolean }) {
  const { name, bytes } = input;
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error(`File exceeds ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
  const extension = path.extname(name).toLowerCase();
  const mime = input.mime && input.mime !== "application/octet-stream" ? input.mime : mimeForName(name);
  const isImage = mime.startsWith("image/"), isVideo = mime.startsWith("video/");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // Documents reuse identical bytes. Visual assets retain independent identities
  // because their provenance and their use as editing sources belong to the ID.
  const duplicate = input.deduplicate !== false && !isImage && !isVideo ? store.documentBySha256(sha256) : undefined;
  if (duplicate) { linkConversationFile(store,input.conversationId,duplicate.id); return { file: duplicate, created: false }; }
  const id = `${isImage ? "img" : isVideo ? "vid" : "file"}_${randomBytes(16).toString("hex")}`;
  // Neither an uploaded filename nor its MIME subtype may become a storage path.
  const storageExtension = MIME_EXTENSION[mime] ?? (EXTENSION_MIME[extension] ? extension : ".bin");
  const dir = isImage || isVideo ? paths.assetFiles : paths.files;
  fs.mkdirSync(dir, { recursive: true });
  const diskPath = path.join(dir, `${id}${storageExtension}`);
  fs.writeFileSync(diskPath, bytes);
  const source = input.source ?? "upload";
  const file = store.addFile({ id, name, mime, bytes: bytes.length, diskPath, sha256, conversationId: input.conversationId, source, deduplicate: input.deduplicate });
  if (isImage) {
    writeImageSidecar(id, { mime, byteLength: bytes.length, sha256, storageFile: path.basename(diskPath), provider: source, origin: source });
    store.registerImageAsset({ image_id: id, mime_type: mime, provider: source });
  } else if (isVideo) {
    store.registerVideoAsset({ videoId: id, mime, provider: source });
  }
  if (isImage || isVideo) forgetAssetIndex();
  return { file: store.getFile(file.id)!, created: true };
}
