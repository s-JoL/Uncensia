import fs from "node:fs";
import path from "node:path";

/** Upgrade contracts only; the old brand is never used for new installations. */
export function inheritLegacyEnvironment(env: NodeJS.ProcessEnv = process.env) {
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("LUMA_") || value === undefined) continue;
    const current = "UNCENSIA_" + key.slice(5);
    if (env[current] === undefined) env[current] = value;
  }
}

export function databaseFile(directory: string) {
  const current = path.join(directory, "uncensia.sqlite");
  const legacy = path.join(directory, "luma.sqlite");
  return !fs.existsSync(current) && fs.existsSync(legacy) ? legacy : current;
}
