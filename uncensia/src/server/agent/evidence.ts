import { createHash } from "node:crypto";

export const contentHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");

/** Inspect the adapter's final body without retaining prompts, credentials or pixels. */
export function requestEvidence(payload: unknown) {
  const root = (payload ?? {}) as Record<string, unknown>;
  const config = root.config as Record<string, unknown> | undefined;
  const schemas = root.tools ?? config?.tools ?? [];
  const tools: string[] = [];
  const names = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(names); return; }
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    if (typeof row.name === "string") tools.push(row.name);
    else if (row.function) names(row.function);
    else if (row.functionDeclarations) names(row.functionDeclarations);
  };
  names(schemas);
  let embeddedImages = 0, remoteImages = 0, textCharacters = 0;
  const inspect = (value: unknown): void => {
    if (typeof value === "string") { textCharacters += value.length; return; }
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    if (!value || typeof value !== "object") return;
    const part = value as Record<string, any>;
    if (part.type === "image_url" || part.type === "input_image") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (typeof url === "string" && url.startsWith("data:image/") && url.includes("base64,")) embeddedImages++;
      else remoteImages++;
      return;
    }
    if (part.type === "image" && part.source) {
      if (part.source.type === "base64" && part.source.data) embeddedImages++;
      else remoteImages++;
      return;
    }
    if (part.inlineData?.mimeType?.startsWith("image/") && part.inlineData.data) { embeddedImages++; return; }
    if (part.fileData?.mimeType?.startsWith("image/")) { remoteImages++; return; }
    for (const [key, item] of Object.entries(part)) {
      if (["content", "parts", "text", "input", "messages", "contents", "system", "systemInstruction"].includes(key)) inspect(item);
    }
  };
  const messages = root.messages ?? root.input ?? root.contents ?? [];
  inspect(messages);
  inspect(root.system ?? config?.systemInstruction);
  return {
    phase: "prepared" as const,
    payloadHash: contentHash(payload),
    tools: [...new Set(tools)], schemaHash: contentHash(schemas),
    messageCount: Array.isArray(messages) ? messages.length : 1,
    textCharacters, embeddedImages, remoteImages,
  };
}
