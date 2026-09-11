import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { DOMParser } from "@xmldom/xmldom";

/** Read the EPUB package's spine, not ZIP filename order (W3C EPUB §5.7). */
export async function epubChapters(file: string) {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  let total = 0;
  const read = async (name: string) => {
    const entry = zip.file(name);
    if (!entry) throw new Error(`EPUB entry missing: ${name}`);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = entry.nodeStream() as import("node:stream").Readable;
      stream.on("data", data => {
        const chunk = Buffer.from(data); total += chunk.length;
        if (total > 32 * 1024 * 1024) { stream.destroy(); reject(new Error("EPUB extracted text exceeds 32 MB")); return; }
        chunks.push(chunk);
      });
      stream.on("end", resolve); stream.on("error", reject);
    });
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  };
  const xml = (text: string) => {
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error("EPUB XML declarations with entities are unsupported");
    return new DOMParser({ errorHandler: { warning: () => {}, error: message => { throw new Error(message); }, fatalError: message => { throw new Error(message); } } }).parseFromString(text, "application/xml");
  };
  const container = xml(await read("META-INF/container.xml"));
  const opfPath = container.getElementsByTagNameNS("*", "rootfile")[0]?.getAttribute("full-path");
  if (!opfPath) throw new Error("EPUB package not found");
  const opf = xml(await read(opfPath));
  const manifest = new Map(Array.from(opf.getElementsByTagNameNS("*", "item")).map(item => [item.getAttribute("id"), item]));
  const spine = Array.from(opf.getElementsByTagNameNS("*", "itemref"));
  if (!spine.length || spine.length > 2000) throw new Error("EPUB reading order is missing or too large");
  const chapters: string[] = [];
  for (const ref of spine) {
    const item = manifest.get(ref.getAttribute("idref"));
    const href = item?.getAttribute("href");
    if (!href || !["application/xhtml+xml", "text/html"].includes(item?.getAttribute("media-type") ?? "")) throw new Error("EPUB spine contains an unsupported content document");
    const name = path.posix.normalize(path.posix.join(path.posix.dirname(opfPath), decodeURIComponent(href.split("#")[0]!)));
    if (name.startsWith("../") || path.posix.isAbsolute(name)) throw new Error("Invalid EPUB entry path");
    chapters.push(await read(name));
  }
  return chapters;
}
