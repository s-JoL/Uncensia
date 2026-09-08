import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { databaseFile, inheritLegacyEnvironment } from "./legacy.ts";

inheritLegacyEnvironment();

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * An operator-supplied directory, absolutised. `~` means nothing to `path`, and
 * on macOS and Linux the string does not always arrive through a shell that
 * would have expanded it — a launchd plist and a systemd unit both hand it over
 * verbatim — so without this Uncensia creates a directory literally named `~` beside
 * the working directory and puts the user's database in it.
 */
function configuredDirectory(value: string | undefined) {
  if (!value) return undefined;
  const expanded =
    value === "~" || value.startsWith("~/") || value.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), value.slice(1))
      : value;
  return path.resolve(expanded);
}

const ROOT = configuredDirectory(process.env.UNCENSIA_ROOT) ?? path.resolve(here, "..", "..");

export const DATA_DIR = configuredDirectory(process.env.UNCENSIA_DATA_DIR) ?? path.join(ROOT, "data");

export const paths = {
  root: ROOT,
  data: DATA_DIR,
  db: databaseFile(DATA_DIR),
  /** Pi session trees; one JSONL file per conversation. */
  sessions: path.join(DATA_DIR, "sessions-sdk"),
  masterKey: path.join(DATA_DIR, "master.key"),
  files: path.join(DATA_DIR, "files"),
  /** Folders of written procedures the agent can load on demand. */
  skills: path.join(DATA_DIR, "skills"),
  /**
   * The two editable prompt slots as files, so the agent can revise them the
   * same way it revises a skill. The settings row stays the HTTP write; these
   * files win on read when they exist.
   */
  prompts: path.join(DATA_DIR, "prompts"),
  promptGlobal: path.join(DATA_DIR, "prompts", "global.md"),
  promptTools: path.join(DATA_DIR, "prompts", "tools.md"),
  /**
   * ComfyUI graphs in API format. A new workflow is a file plus a model row, so
   * adding one is not a release.
   */
  workflows: path.join(DATA_DIR, "workflows"),
  assets: path.join(DATA_DIR, "assets"),
  assetMeta: path.join(DATA_DIR, "assets", "meta"),
  assetFiles: path.join(DATA_DIR, "assets", "files"),
  thumbs: path.join(DATA_DIR, "assets", "thumbs"),
  webDist: path.join(ROOT, "dist"),
};

export const PORT = Number(process.env.UNCENSIA_PORT ?? 8090);
export const HOST = process.env.UNCENSIA_HOST ?? "127.0.0.1";

export const MAX_UPLOAD_BYTES = Number(process.env.UNCENSIA_MAX_UPLOAD_BYTES ?? 64 * 1024 * 1024);
export const MAX_ATTACHMENTS = Number(process.env.UNCENSIA_MAX_ATTACHMENTS ?? 8);

export function ensureDirectories() {
  for (const dir of [
    paths.data,
    paths.files,
    paths.skills,
    paths.prompts,
    paths.workflows,
    paths.assets,
    paths.assetMeta,
    paths.assetFiles,
    paths.thumbs,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
