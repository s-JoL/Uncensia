import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ModelInput, ProviderInput, PromptSettings } from "@shared/types.ts";
import { SECRET, type Config } from "../config.ts";
import type { SecretVault } from "../crypto/secrets.ts";
import { paths } from "../env.ts";
import { DEFAULT_GLOBAL_PROMPT, DEFAULT_TOOL_PROMPT } from "../prompts/defaults.ts";
import { json } from "./db.ts";
import type { Store } from "./store.ts";
import { sirayModels } from "../models/siray.ts";

const PROVIDERS: Array<ProviderInput & { id: string }> = [
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", auth: { style: "bearer" } },
  { id: "siray", name: "Siray", baseUrl: "https://api.siray.ai/v1", auth: { style: "bearer" } },
  { id: "comfy", name: "ComfyUI", baseUrl: "http://127.0.0.1:8188" },
];
const CHAT_ID = "openrouter-tencent-hy4-preview";
const IMAGE_ID = "comfy:lustify-v10";
const EDIT_ID = "siray:seedream-5.0-pro-i2i-spicy";
const VIDEO_ID = "siray:wan-3.0-t2v-spicy";
const GENERATION_DEFAULTS = { enabled: true, pinned: false, reasoning: false, input: ["text"] as Array<"text" | "image">, contextWindow: 4096, maxTokens: 4096, thinkingLevel: "off" as const };
const MODELS: ModelInput[] = [
  {
    id: CHAT_ID,
    name: "HY4 Preview · OpenRouter",
    providerId: "openrouter",
    model: "tencent/hy4-preview",
    enabled: true,
    pinned: true,
    reasoning: true,
    input: ["text"],
    contextWindow: 1_048_576,
    maxTokens: 64_000,
    thinkingLevel: "medium",
    apiMode: "openai-chat",
  },
  {
    ...GENERATION_DEFAULTS,
    id: IMAGE_ID,
    name: "Lustify V10 Krea Turbo",
    providerId: "comfy",
    model: "lustify-v10-krea-turbo",
    kind: "image",
    ops: ["text_to_image"],
    apiMode: "comfy-workflow",
    params: {
      workflow: "lustify-v10-krea-turbo.json",
      bind: {
        prompt: "4.inputs.text",
        width: "7.inputs.width",
        height: "7.inputs.height",
      },
    },
  },
  ...sirayModels.filter(model => model.enabled),
];

/** Initialize a new installation once. Existing model/provider choices are user-owned. */
export function seed(store: Store, config: Config, vault: SecretVault) {
  const firstBoot = store.getMeta("initialized") !== "true";
  if (firstBoot) {
    for (const provider of PROVIDERS) {
      if (!store.getProvider(provider.id)) store.upsertProvider({ ...provider, enabled: true });
    }
    for (const [sortOrder, model] of MODELS.entries()) {
      if (!store.getModel(model.id)) store.upsertModel({ ...model, sortOrder });
    }
    if (!config.defaultModelId()) config.setDefaultModelId(CHAT_ID);
    const defaults = config.generationDefaults();
    config.setGenerationDefaults({
      imageModelId: defaults.imageModelId || IMAGE_ID,
      editModelId: defaults.editModelId || EDIT_ID,
      videoModelId: defaults.videoModelId || VIDEO_ID,
    });
    const credentials = [
      ...PROVIDERS.map(provider => [SECRET.provider(provider.id), provider.id.toUpperCase().replaceAll("-", "_") + "_API_KEY"]),
      [SECRET.tavily, "TAVILY_API_KEY"], [SECRET.embedding, "EMBEDDING_API_KEY"],
    ];
    for (const [name, variable] of credentials) {
      const value = process.env[variable!];
      if (value?.trim() && !vault.has(name!)) vault.set(name!, value);
    }
  }
  migrateSkillName(store);
  installFiles(store, "skills", paths.skills, () => true);
  installFiles(store, "workflows", paths.workflows, name => name.endsWith(".json"));
  installPrompts(store, config, firstBoot);
  if (firstBoot) store.setMeta("initialized", "true");
  return firstBoot;
}

const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Keep edits and deletion markers when the bundled maintenance skill changes name. */
function migrateSkillName(store: Store) {
  const oldName = "improve-luma";
  const newName = "improve-uncensia";
  const previous = path.join(paths.skills, oldName);
  const current = path.join(paths.skills, newName);
  if (fs.existsSync(current)) return;
  if (fs.existsSync(previous)) fs.renameSync(previous, current);
  const hashes = json<Record<string, string>>(store.getMeta("skill_hashes"), {});
  let changed = false;
  for (const key of Object.keys(hashes)) {
    if (!key.startsWith(oldName + "/") && !key.startsWith(oldName + "\\")) continue;
    hashes[newName + key.slice(oldName.length)] = hashes[key]!;
    delete hashes[key];
    changed = true;
  }
  if (changed) store.setMeta("skill_hashes", JSON.stringify(hashes));
}

/** Package updates replace only bytes whose last installed hash we recorded. */
function installFiles(store: Store, folder: string, destination: string, include: (name: string) => boolean) {
  const source = path.join(paths.root, folder);
  if (!fs.existsSync(source)) return;
  const key = folder === "skills" ? "skill_hashes" : "workflow_hashes";
  const installed = json<Record<string, string>>(store.getMeta(key), {});
  const kept: string[] = [];
  let changed = false;
  for (const entry of fs.readdirSync(source, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !include(entry.name)) continue;
    const relative = path.relative(source, path.join(entry.parentPath, entry.name));
    const file = path.join(destination, relative);
    const shipped = fs.readFileSync(path.join(source, relative));
    const hash = digest(shipped);
    const current = fs.existsSync(file) ? digest(fs.readFileSync(file)) : undefined;
    // A previously installed file that is now absent was removed by its owner.
    if (current === undefined && installed[relative] !== undefined) continue;
    if (current !== hash) {
      if (current !== undefined && current !== installed[relative]) { kept.push(relative); continue; }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, shipped);
    }
    if (installed[relative] !== hash) { installed[relative] = hash; changed = true; }
  }
  if (changed) store.setMeta(key, JSON.stringify(installed));
  if (kept.length) console.log("[" + folder + "] kept your edited " + kept.join(", "));
}

/** The two editable prompt slots follow the same ownership rule as skill files. */
function installPrompts(store: Store, config: Config, firstBoot: boolean) {
  const installed = json<Record<string, string>>(store.getMeta("prompt_hashes"), {});
  const current = config.prompts();
  const patch: Partial<PromptSettings> = {};
  for (const [name, shipped] of Object.entries({ globalPrompt: DEFAULT_GLOBAL_PROMPT, toolPrompt: DEFAULT_TOOL_PROMPT })) {
    const key = name as "globalPrompt" | "toolPrompt";
    const hash = digest(shipped);
    if (current[key] === shipped) installed[key] = hash;
    else if ((firstBoot && !current[key]) || digest(current[key]) === installed[key]) {
      patch[key] = shipped;
      installed[key] = hash;
    }
  }
  if (Object.keys(patch).length) config.savePrompts(patch);
  store.setMeta("prompt_hashes", JSON.stringify(installed));
}
