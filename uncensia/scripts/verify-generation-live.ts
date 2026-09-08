/**
 * The generation layer against the real backends, which is the only place the
 * fakes in `audit-generation.ts` cannot reach: a wire shape a provider actually
 * accepts, and which model each agent tool is really bound to.
 *
 *   node --import tsx scripts/verify-generation-live.ts            # free: seed and report
 *   node --import tsx scripts/verify-generation-live.ts --draw     # one hosted image
 *   node --import tsx scripts/verify-generation-live.ts --edit     # one hosted edit
 *   node --import tsx scripts/verify-generation-live.ts --video    # one hosted clip
 *
 * The rendering flags cost real money, one render each, which is why reporting
 * is the default and every render is asked for by name.
 */
import fs from "node:fs";
import path from "node:path";

const { paths, ensureDirectories } = await import("../src/server/env.ts");
const { Db } = await import("../src/server/store/db.ts");
const { Store } = await import("../src/server/store/store.ts");
const { SecretVault, loadMasterKey } = await import("../src/server/crypto/secrets.ts");
const { Config } = await import("../src/server/config.ts");
const { seed } = await import("../src/server/store/seed.ts");
const { Jobs } = await import("../src/server/generation/jobs.ts");
const { schemaOf, opsOf, forModel } = await import("../src/server/generation/index.ts");
const { resolveGeneration } = await import("../src/server/agent/defaults.ts");
const { saveImageBytes } = await import("../src/server/images.ts");

ensureDirectories();
const db = new Db(paths.db);
const store = new Store(db);
const vault = new SecretVault(store, loadMasterKey(paths.masterKey));
const config = new Config(store, vault);

console.log(seed(store, config, vault) ? "seed: applied" : "seed: already current");

/* ── what the agent is actually bound to ─────────────────────────────────── */

const resolved = resolveGeneration(store, config);
console.log("\nagent tool bindings");
for (const [role, spec] of [
  ["generate_image", resolved.image],
  ["edit_image", resolved.edit],
  ["generate_video", resolved.video],
] as const) {
  console.log(`  ${role.padEnd(15)} ${spec ? `${spec.name}  (${spec.id}, ${spec.apiMode})` : "— nothing bound"}`);
}
console.log(`  defaults        image=${resolved.image?.id ?? "—"} edit=${resolved.edit?.id ?? "—"} video=${resolved.video?.id ?? "—"}`);

console.log("\ngeneration models and the parameters each one offers  (* studio only, never sent to the model)");
for (const spec of store.listModels().filter((entry) => entry.kind === "image" || entry.kind === "video")) {
  console.log(`  ${spec.name}  (${spec.id}) ${spec.enabled ? "" : "[disabled] "}${spec.apiMode}`);
  for (const op of opsOf(spec)) {
    const schema = schemaOf(spec, op);
    const fields = Object.entries(schema.properties ?? {}).map(([name, field]) => {
      const options = field.enum?.length ? `=${field.enum.slice(0, 3).join("|")}${field.enum.length > 3 ? "…" : ""}` : "";
      return `${name}${options}${field.audience === "studio" ? "*" : ""}`;
    });
    const offered = Object.keys(forModel(schema).properties ?? {}).length;
    console.log(`      ${op}: ${fields.join(", ")}`);
    console.log(`        ${offered} of ${fields.length} reach the model, plus intent`);
  }
}

/* ── real renders, each one asked for by name ─────────────────────────────── */

const jobs = new Jobs(store, vault);
const outDir = path.join(paths.root, "probe-out");
fs.mkdirSync(outDir, { recursive: true });

async function render(label: string, request: Parameters<typeof jobs.run>[0]) {
  process.stdout.write(`\n── ${label}\n`);
  const started = Date.now();
  const job = await jobs.run(request);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (job.status !== "succeeded") {
    console.log(`   ${job.status.toUpperCase()} after ${seconds}s: ${job.error}`);
    return undefined;
  }
  for (const asset of job.assets) {
    const file = store.getFile(asset.assetId);
    const bytes = file ? fs.statSync(file.diskPath).size : 0;
    console.log(`   OK in ${seconds}s: ${asset.assetId} ${asset.width}x${asset.height} ${asset.kind} ${bytes} bytes`);
    if (file) {
      const copy = path.join(outDir, `live-${label.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase()}${path.extname(file.diskPath)}`);
      fs.copyFileSync(file.diskPath, copy);
      console.log(`   copied to ${path.relative(paths.root, copy)}`);
    }
  }
  return job.assets[0]?.assetId;
}

const wants = (flag: string) => process.argv.includes(flag);
/** `--image=<modelId>` renders through a named row instead of the bound one. */
const named = (flag: string) =>
  process.argv.find((argument) => argument.startsWith(`${flag}=`))?.split("=", 2)[1];
const rowFor = (flag: string, fallback: typeof resolved.image) => {
  const id = named(flag);
  if (!id) return fallback;
  const spec = store.getModel(id);
  if (!spec) throw new Error(`no model row ${id}`);
  return spec;
};

let drawn: string | undefined = named("--source");

if (wants("--draw")) {
  const spec = rowFor("--image", resolved.image);
  if (!spec) console.log("\n── draw skipped: nothing bound");
  else
    drawn = await render(`draw via ${spec.apiMode}`, {
      modelId: spec.id,
      params: {
        prompt:
          "A candid color photograph of a woman in her mid-twenties with a short black bob haircut standing outside a neighborhood convenience store just after rain, looking down at a phone held in both hands. She wears a plain black wool coat, dark jeans, and white sneakers. Wet pavement reflects the warm store light, overcast daylight, eye-level three-quarter body framing, ordinary unretouched skin and natural fabric folds, no text.",
        ...(spec.apiMode === "openai-images" ? { size: "2736x1536" } : {}),
      },
    });
}

if (wants("--edit") && resolved.edit) {
  const { default: sharp } = await import("sharp");
  const swatch = async (r: number, g: number, b: number) =>
    saveImageBytes(
      store,
      await sharp({ create: { width: 512, height: 288, channels: 3, background: { r, g, b } } }).png().toBuffer(),
      { mime: "image/png", provider: "verify", model: "fixture" },
    );
  const first = drawn ?? (await swatch(220, 40, 40));
  await render("single-source continuity edit", {
    modelId: resolved.edit.id,
    op: "image_to_image",
    params: {
      prompt:
        "Edit the source image. Change only the woman's black wool coat to a deep red wool coat of the same cut and length. Update the coat's folds and shading for the existing light. Keep her face, hair, pose, phone, framing, store, wet pavement, and all other details unchanged. Make no other changes.",
      source_image_id: first,
    },
  });
}

if (wants("--video") && resolved.video) {
  const requestedSize = named("--size");
  await render("video", {
    modelId: resolved.video.id,
    params: {
      prompt: drawn
        ? "The woman slowly lifts her eyes from the phone and looks toward the camera while a light breeze moves a few strands of her short hair. The camera makes a very slow, steady push-in. Keep her identity, clothing, store entrance, wet pavement and lighting continuous with the first frame."
        : "A slow push-in on a ripe persimmon resting on a concrete ledge, overcast daylight.",
      duration: 2,
      ...(requestedSize ? { size: requestedSize } : drawn ? { source_image_id: drawn } : { size: "832x480" }),
      ...(drawn ? { source_image_id: drawn } : {}),
    },
  });
}

jobs.close();
db.close();
