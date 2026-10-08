/**
 * Mods: declarative extensions of the interface, one `mod.json` per folder
 * under `data/mods`. A mod contributes text to fixed slots — buttons under a
 * reply, suggestion chips, side panels that show conversation notes — and
 * never runs code, which is what lets the assistant write one under the same
 * permission as a skill. Shipped mods install like shipped skills: an edited
 * copy is kept on upgrade. Enabled state lives beside them, so an upgrade of
 * the file never undoes the owner's switch.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { isNoteKey, MOD_LIMITS, type ModManifest, type ModRecord } from "@shared/types.ts";
import { paths } from "./env.ts";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const preferencesFile = () => path.join(paths.data, "mod-preferences.json");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

const label = z.string().trim().min(1).max(MOD_LIMITS.label);
const prompt = z.string().trim().min(1).max(MOD_LIMITS.prompt);
const schema = z.object({
  name: z.string().regex(NAME, "name must be lowercase letters, digits and single hyphens, e.g. story-panel").max(64),
  title: z.string().trim().min(1).max(MOD_LIMITS.title),
  description: z.string().trim().max(MOD_LIMITS.description).default(""),
  origin: z.literal("learned").optional(),
  contributes: z.object({
    messageActions: z.array(z.object({ label, prompt })).max(MOD_LIMITS.perSlot).optional(),
    starters: z.array(z.object({ label, prompt })).max(MOD_LIMITS.perSlot).optional(),
    panels: z.array(z.object({
      title: label,
      notes: z.array(z.string().refine(isNoteKey, "note keys are 1-48 lowercase letters, digits, '-' or '_'")).min(1).max(MOD_LIMITS.notesPerPanel),
    })).max(MOD_LIMITS.perSlot).optional(),
  }).strict(),
}).strict();

/** Parses and checks a manifest; the message says which field is wrong. */
export function validateMod(value: unknown): ModManifest {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw Object.assign(new Error(`${issue.path.join(".") || "mod"}: ${issue.message}`), { status: 400 });
  }
  const contributes = parsed.data.contributes;
  if (!contributes.messageActions?.length && !contributes.starters?.length && !contributes.panels?.length) {
    throw Object.assign(new Error("contributes: add at least one messageAction, starter or panel"), { status: 400 });
  }
  return parsed.data as ModManifest;
}

function preferences(): Record<string, boolean> {
  try { return JSON.parse(fs.readFileSync(preferencesFile(), "utf8")); } catch { return {}; }
}

const fileOf = (name: string) => path.join(paths.mods, name, "mod.json");

/** Every readable mod, valid ones first; a broken file is reported, not hidden. */
export function listMods(): { items: ModRecord[]; errors: string[] } {
  const items: ModRecord[] = [];
  const errors: string[] = [];
  if (!fs.existsSync(paths.mods)) return { items, errors };
  const state = preferences();
  for (const entry of fs.readdirSync(paths.mods, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = fileOf(entry.name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    try {
      const manifest = validateMod(JSON.parse(text));
      if (manifest.name !== entry.name) throw new Error(`name ${manifest.name} does not match its folder ${entry.name}`);
      items.push({ ...manifest, enabled: state[manifest.name] !== false, revision: hash(text) });
    } catch (error) {
      errors.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  items.sort((a, b) => a.title.localeCompare(b.title));
  return { items, errors };
}

export function readMod(name: string) {
  const file = fileOf(name);
  if (!NAME.test(name) || !fs.existsSync(file)) throw Object.assign(new Error(`No mod named ${name}`), { status: 404 });
  const content = fs.readFileSync(file, "utf8");
  return { content, revision: hash(content) };
}

/**
 * Creates or replaces a mod. Replacing needs the revision that was read, so
 * two writers never silently overwrite each other. Returns the previous text.
 */
export function saveMod(manifest: unknown, revision?: string) {
  const mod = validateMod(manifest);
  const file = fileOf(mod.name);
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (before !== null && hash(before) !== revision) {
    throw Object.assign(new Error("This mod changed since it was read; read it again and use its current revision"), { status: 409 });
  }
  const content = `${JSON.stringify(mod, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, file);
  return { name: mod.name, before, after: content };
}

export function setModEnabled(name: string, enabled: boolean) {
  readMod(name);
  const state = preferences();
  state[name] = enabled;
  fs.writeFileSync(preferencesFile(), JSON.stringify(state, null, 2));
}

/** Removal moves the folder aside rather than deleting it outright. */
export function deleteMod(name: string) {
  const { content } = readMod(name);
  const trash = path.join(paths.data, "mod-trash", `${name}-${Date.now()}`);
  fs.mkdirSync(path.dirname(trash), { recursive: true });
  fs.renameSync(path.dirname(fileOf(name)), trash);
  return content;
}
