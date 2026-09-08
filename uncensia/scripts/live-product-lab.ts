import { databaseFile } from "../src/server/legacy.ts";
/** Isolated, real-provider product lab. Production configuration is read-only;
 * transcripts and renders belong only to the selected directory under run/.
 * node --import tsx scripts/live-product-lab.ts
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { serve } from "@hono/node-server";

const lab = path.resolve(process.env.UNCENSIA_LAB_DIR ?? "run/history-live-20260906");
const relative = path.relative(path.resolve("run"), lab);
if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Product lab must use its own directory under run/");
const port = Number(process.env.UNCENSIA_LAB_PORT ?? 8096);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 8090) throw new Error("Choose a non-production lab port");
process.env.UNCENSIA_DATA_DIR = path.join(lab, "data");
process.env.UNCENSIA_ACCESS_CODE = "PRODUCTLAB2026";
/** Prove which text and pixels reached the request without retaining their contents. */
function messageFingerprints(messages: Array<{ role?: string; content?: unknown }>) {
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  return messages.filter(message => !["system", "developer"].includes(message.role ?? "")).map(message => {
    const text: string[] = [], images: string[] = [];
    for (const part of Array.isArray(message.content) ? message.content : [message.content]) {
      if (typeof part === "string") text.push(part);
      else if (part?.type === "text" && typeof part.text === "string") text.push(part.text);
      else if (part?.type === "image_url" && typeof part.image_url?.url === "string") {
        const url: string = part.image_url.url;
        const comma = url.indexOf(",");
        if (url.startsWith("data:") && comma >= 0) images.push(createHash("sha256").update(Buffer.from(url.slice(comma + 1), "base64")).digest("hex"));
      }
    }
    return { role: message.role, text: text.map(value => ({ sha256: digest(value), characters: value.length })), joinedTextSha256: digest(text.join("\n")), images };
  });
}
if (process.env.UNCENSIA_LAB_CAPTURE_REQUESTS === "1") {
  const { ORIGINAL_WRITING_PROMPT } = await import("../src/server/prompts/defaults.ts");
  const actualFetch = globalThis.fetch;
  fs.mkdirSync(lab, { recursive: true });
  globalThis.fetch = async (input, init) => {
    // Audit outbound request structure without storing credentials, private
    // prompts, images, or the provider response body.
    if (typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body);
        if (body.model && (Array.isArray(body.messages) || body.system || body.instructions)) {
          const system = JSON.stringify([body.system, body.instructions, ...(body.messages ?? []).filter((m: {role?:string}) => m.role === "system" || m.role === "developer")]);
          const retained = system.includes(JSON.stringify(ORIGINAL_WRITING_PROMPT).slice(1, -1));
          const url = new URL(input instanceof Request ? input.url : String(input));
          const countImages = (value: unknown): number => {
            if (!value || typeof value !== "object") return 0;
            if (Array.isArray(value)) return value.reduce((sum, item) => sum + countImages(item), 0);
            const item = value as Record<string, unknown>;
            if (["image_url", "input_image", "image"].includes(String(item.type))) return 1;
            return Object.values(item).reduce<number>((sum, child) => sum + countImages(child), 0);
          };
          fs.appendFileSync(path.join(lab, "request-contracts.jsonl"), JSON.stringify({
            at: new Date().toISOString(), endpoint: url.origin + url.pathname, model: body.model,
            systemSha256: createHash("sha256").update(system).digest("hex"), originalWritingBriefPresent: retained,
            tools: (body.tools ?? []).map((t: {function?:{name?:string};name?:string}) => t.function?.name ?? t.name),
            messages: body.messages?.length, imageParts: countImages(body.messages ?? body.input),
            messageFingerprints: Array.isArray(body.messages) ? messageFingerprints(body.messages) : undefined,
          }) + "\n");
        }
      } catch { /* Non-JSON provider protocols have no captured contract here. */ }
    }
    return actualFetch(input, init);
  };
}
const { createServices } = await import("../src/server/services.ts");
const { createApp } = await import("../src/server/http/app.ts");
const { SecretVault } = await import("../src/server/crypto/secrets.ts");
const services = createServices();
if (!services.store.getSetting("liveLabInitialized", false)) {
  const source = new DatabaseSync(databaseFile("data"), { readOnly: true });
  try {
    for (const table of ["providers", "models"] as const) {
      const allowed = new Set(services.db.all<{name:string}>(`PRAGMA table_info(${table})`).map(row => row.name));
      for (const row of source.prepare(`SELECT * FROM ${table}`).all()) {
        const names = Object.keys(row).filter(name => allowed.has(name));
        services.db.run(`INSERT OR REPLACE INTO ${table} (${names.map(name => `"${name}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`, ...names.map(name => row[name]));
      }
    }
    const sourceVault = new SecretVault({ readSecretRow: (name: string) => source.prepare("SELECT iv,tag,ciphertext FROM secrets WHERE name=?").get(name) } as ConstructorParameters<typeof SecretVault>[0], fs.readFileSync("data/master.key"));
    for (const provider of services.store.listProviders()) {
      const key = sourceVault.get(`provider:${provider.id}`);
      if (key) services.vault.set(`provider:${provider.id}`, key);
    }
    const defaults = source.prepare("SELECT value FROM settings WHERE key='generationDefaults'").get();
    if (defaults) services.store.setSetting("generationDefaults", JSON.parse(String(defaults.value)));
    // Explicit vision-model test selection: no automatic fallback from the user's text default.
    services.store.setSetting("defaultModelId", process.env.UNCENSIA_LAB_CHAT_MODEL ?? "cometapi-deepseek-v4-flash-vision");
    services.config.savePrompts({ titleEnabled: false });
    const capabilities = services.config.capabilities();
    services.config.saveCapabilities({
      coding: { read: false, write: false, shell: false, workspace: path.join(lab, "workspace") },
      web: { ...capabilities.web, enabled: false },
      embedding: { ...capabilities.embedding, enabled: false },
    });
    services.store.setSetting("liveLabInitialized", true);
    services.reload();
  } finally { source.close(); }
}
const app = createApp(services);
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => console.log(`Live product lab: http://127.0.0.1:${port} — ${lab}`));
let closing = false;
async function close() { if (closing) return; closing = true; server.close(); await services.close(); process.exit(0); }
process.once("SIGINT", close);
process.once("SIGTERM", close);
