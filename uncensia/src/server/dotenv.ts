import fs from "node:fs";
import path from "node:path";

/**
 * Load a local `.env` before any other module reads `process.env`.
 *
 * A self-hosted install can then keep its `UNCENSIA_*` settings and provider
 * keys in a file instead of exporting them in the shell. Keys are named
 * `<PROVIDER>_API_KEY` or `<PROVIDER>_TOKEN` (e.g. `SIRAY_TOKEN`,
 * `OPENROUTER_API_KEY`) and are adopted once, on first boot, by the seed. The
 * app directory wins over the repository root when both files exist, and an
 * already-exported variable is left untouched.
 *
 * Imported first from `main.ts` so `env.ts`, which reads `process.env` at module
 * load, already sees these values. A missing or malformed file is ignored.
 */
for (const file of [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "..", ".env"),
]) {
  try {
    if (fs.existsSync(file)) process.loadEnvFile(file);
  } catch {
    // Startup must not depend on a readable or well-formed .env.
  }
}
