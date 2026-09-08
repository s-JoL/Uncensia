/** One ingestion path for browser uploads and files produced in the workspace. */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MAX_UPLOAD_BYTES, paths } from "./env.ts";
import { forgetAssetIndex, writeImageSidecar } from "./images.ts";
import type { Store } from "./store/store.ts";

const EXTENSION_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
  ".json": "application/json", ".html": "text/html", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const MIME_EXTENSION = Object.fromEntries(Object.entries(EXTENSION_MIME).map(([extension, mime]) => [mime, extension]));
export const mimeForName = (name: string) => EXTENSION_MIME[path.extname(name).toLowerCase()] ?? "application/octet-stream";

export function ingestFile(store: Store, input: { name: string; bytes: Buffer; mime?: string; conversationId?: string | null; source?: string }) {
  const { name, bytes } = input;
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error(`File exceeds ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`);
  const extension = path.extname(name).toLowerCase();
  const mime = input.mime && input.mime !== "application/octet-stream" ? input.mime : mimeForName(name);
  const isImage = mime.startsWith("image/"), isVideo = mime.startsWith("video/");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // Documents reuse identical bytes. Visual assets retain independent identities
  // because their provenance and their use as editing sources belong to the ID.
  const duplicate = !isImage && !isVideo ? store.documentBySha256(sha256) : undefined;
  if (duplicate) return { file: duplicate, created: false };
  const id = `${isImage ? "img" : isVideo ? "vid" : "file"}_${randomBytes(16).toString("hex")}`;
  // Neither an uploaded filename nor its MIME subtype may become a storage path.
  const storageExtension = MIME_EXTENSION[mime] ?? (EXTENSION_MIME[extension] ? extension : ".bin");
  const dir = isImage || isVideo ? paths.assetFiles : paths.files;
  fs.mkdirSync(dir, { recursive: true });
  const diskPath = path.join(dir, `${id}${storageExtension}`);
  fs.writeFileSync(diskPath, bytes);
  const source = input.source ?? "upload";
  const file = store.addFile({ id, name, mime, bytes: bytes.length, diskPath, sha256, conversationId: input.conversationId, source });
  if (isImage) {
    writeImageSidecar(id, { mime, byteLength: bytes.length, sha256, storageFile: path.basename(diskPath), provider: source, origin: source });
    store.registerImageAsset({ image_id: id, mime_type: mime, provider: source });
  } else if (isVideo) {
    store.registerVideoAsset({ videoId: id, mime, provider: source });
  }
  if (isImage || isVideo) forgetAssetIndex();
  return { file: store.getFile(file.id)!, created: true };
}
