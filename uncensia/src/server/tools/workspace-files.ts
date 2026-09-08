import fs from "node:fs";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { CodingCapability, FileRecord } from "@shared/types.ts";
import { MAX_UPLOAD_BYTES } from "../env.ts";
import { ingestFile } from "../library.ts";
import type { Store } from "../store/store.ts";
import { safePath } from "./coding.ts";

/** Copy bytes across the library/workspace boundary only through explicit IDs and paths. */
export function workspaceFileTools(store: Store, config: CodingCapability, conversationId: string, index?: (file: FileRecord & { diskPath: string }) => Promise<unknown>): AgentTool[] {
  const tools: AgentTool[] = [];
  if (config.write) tools.push({
    name: "import_file", label: "Copy file to workspace",
    description: "Copy an existing library document, image or video into the coding workspace for local processing. Use the exact file_, img_ or vid_ ID from the conversation. Preserves original bytes; refuses to overwrite an existing path. The copied file can be read and processed with the ordinary file and bash tools.",
    parameters: Type.Object({ file_id: Type.String(), path: Type.String({ description: "New destination path inside the coding workspace." }) }),
    execute: async (_id, args) => {
      const { file_id, path: requested } = args as { file_id: string; path: string };
      const file = store.getFile(file_id);
      if (!file) throw new Error(`Unknown library file ${file_id}`);
      const target = safePath(config.workspace, requested);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file.diskPath, target, fs.constants.COPYFILE_EXCL);
      return { content: [{ type: "text", text: `Copied ${file_id} to ${requested} (${file.mime}, ${fs.statSync(target).size} bytes).` }], details: { file_id, path: requested } };
    },
  });
  if (config.read) tools.push({
    name: "publish_file", label: "Save workspace result to library",
    description: "Copy a finished file from the coding workspace into the user's Uncensia library and this conversation, so the user can open or download it. This is local file delivery. Returns a Markdown link; images also have an image:// preview. Original bytes remain unchanged.",
    parameters: Type.Object({ path: Type.String({ description: "Existing file inside the coding workspace." }) }),
    execute: async (_id, args) => {
      const source = safePath(config.workspace, (args as { path: string }).path);
      const stat = fs.statSync(source);
      if (!stat.isFile() || stat.size > MAX_UPLOAD_BYTES) throw new Error(`Expected a file of at most ${MAX_UPLOAD_BYTES} bytes`);
      const { file, created } = ingestFile(store, { name: path.basename(source), bytes: fs.readFileSync(source), conversationId, source: "workspace" });
      let indexError = "";
      if (created && !file.mime.startsWith("image/") && !file.mime.startsWith("video/")) {
        try { await index?.(file); } catch (error) { indexError = error instanceof Error ? error.message : String(error); }
      }
      const preview = file.mime.startsWith("image/") ? `\nPreview: ![Image](image://${file.id})` : "";
      const warning = indexError ? `\nThe file is saved, but search indexing failed: ${indexError}` : "";
      return { content: [{ type: "text", text: `Saved ${JSON.stringify(file.name)} (${file.bytes} bytes).\nDownload: [Download file](file://${file.id})${preview}${warning}` }], details: { file_id: file.id, name: file.name, mime: file.mime, ...(indexError ? { indexError } : {}) } };
    },
  });
  return tools;
}
