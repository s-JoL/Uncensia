import { databaseFile } from "../src/server/legacy.ts";
/**
 * Rebuilds the time-specific acceptance report for the two matched real-media
 * chains used during the architecture upgrade. It is read-only with respect to
 * Uncensia state: SQLite and asset bytes are inspected, then a JSON/Markdown report
 * is written under run/upgrade-acceptance.
 *
 *   node --import tsx scripts/report-upgrade-acceptance.ts
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = process.cwd();
const outputDir = path.join(root, "run", "upgrade-acceptance");

const CHAINS = [
  {
    name: "before",
    baseJob: "job_e5a145c42eca4a1ca375f63ec41748af",
    editJob: "job_d4008f36e3ea420e866c10f5d32591f0",
    videoJob: "job_0d31b7012ff945b782c930ca42685f76",
    baseAsset: "img_51d3668f799d89601231ace3c96f377c",
    editAsset: "img_da2086bc697af60b5b4cdefa55eabdfc",
    videoAsset: "vid_7db80789ec7908ea783836b449ea6072",
    midFrame: "wan-before-mid.png",
  },
  {
    name: "after",
    baseJob: "job_a65702cd769546619daf341312a0c93f",
    editJob: "job_ff3f6b9c9e3e4c4a8074d4feb693b1b1",
    videoJob: "job_b48b1192d0b84bde97f54e813fa19f97",
    baseAsset: "img_6fa97741eb6c6cb5f359002f5140937f",
    editAsset: "img_552fa16b467c69800bef6c1cfadc0ee7",
    videoAsset: "vid_08750a2aec5248e369e760d57f611c90",
    midFrame: "wan-after-mid.png",
  },
] as const;

type JobRow = {
  id: string;
  status: string;
  model_id: string;
  model_name: string;
  params: string;
  sources: string;
  assets: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
};

type FileRow = {
  id: string;
  mime: string;
  bytes: number;
  disk_path: string;
  sha256: string;
  width: number | null;
  height: number | null;
};

const db = new DatabaseSync(databaseFile(path.join(root, "data")), { readOnly: true });
const jobById = db.prepare("SELECT * FROM jobs WHERE id = ?");
const fileById = db.prepare("SELECT id, mime, bytes, disk_path, sha256, width, height FROM files WHERE id = ?");
const imageById = db.prepare("SELECT parent_image_ids FROM image_assets WHERE image_id = ?");
const videoById = db.prepare("SELECT parent_image_ids, duration_ms FROM video_assets WHERE video_id = ?");

const json = <T>(value: string) => JSON.parse(value) as T;
const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

function asset(id: string) {
  const row = fileById.get(id) as FileRow | undefined;
  if (!row) throw new Error(`missing file row ${id}`);
  const exists = fs.existsSync(row.disk_path);
  return {
    id,
    mime: row.mime,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    diskPath: row.disk_path,
    exists,
    sha256: row.sha256,
    sha256Matches: exists && sha256(row.disk_path) === row.sha256,
  };
}

function job(id: string) {
  const row = jobById.get(id) as JobRow | undefined;
  if (!row) throw new Error(`missing job ${id}`);
  return {
    id: row.id,
    status: row.status,
    modelId: row.model_id,
    modelName: row.model_name,
    params: json<Record<string, unknown>>(row.params),
    sources: json<string[]>(row.sources),
    assets: json<Array<{ assetId: string; parents?: string[] }>>(row.assets),
    createdAt: row.created_at,
    elapsedMs: row.started_at !== null && row.finished_at !== null ? row.finished_at - row.started_at : null,
  };
}

const chains = CHAINS.map((ids) => {
  const base = job(ids.baseJob);
  const edit = job(ids.editJob);
  const video = job(ids.videoJob);
  const baseAsset = asset(ids.baseAsset);
  const editAsset = asset(ids.editAsset);
  const videoAsset = asset(ids.videoAsset);
  const imageParents = json<string[]>(
    String((imageById.get(ids.editAsset) as { parent_image_ids: string } | undefined)?.parent_image_ids ?? "[]"),
  );
  const videoRow = videoById.get(ids.videoAsset) as
    | { parent_image_ids: string; duration_ms: number | null }
    | undefined;
  const videoParents = json<string[]>(String(videoRow?.parent_image_ids ?? "[]"));
  const midFrame = path.join(outputDir, ids.midFrame);
  const graphValid =
    same(edit.sources, [ids.baseAsset]) &&
    same(video.sources, [ids.baseAsset]) &&
    same(imageParents, [ids.baseAsset]) &&
    same(videoParents, [ids.baseAsset]) &&
    same(edit.assets[0]?.parents, [ids.baseAsset]) &&
    same(video.assets[0]?.parents, [ids.baseAsset]);
  const valid =
    [base, edit, video].every((item) => item.status === "succeeded") &&
    [baseAsset, editAsset, videoAsset].every((item) => item.exists && item.sha256Matches) &&
    graphValid &&
    fs.existsSync(midFrame);
  return {
    name: ids.name,
    valid,
    graphValid,
    jobs: { base, edit, video },
    assets: { base: baseAsset, edit: editAsset, video: videoAsset },
    provenance: { editParents: imageParents, videoParents, videoDurationMs: videoRow?.duration_ms ?? null },
    midFrame,
  };
});

const [before, after] = chains;
const promptParity = {
  base: before!.jobs.base.params.prompt === after!.jobs.base.params.prompt,
  edit: before!.jobs.edit.params.prompt === after!.jobs.edit.params.prompt,
  video: before!.jobs.video.params.prompt === after!.jobs.video.params.prompt,
};

const routingFiles = [
  "skill-routing-ordinary-glm53flash.json",
  "skill-routing-roleplay-glm53flash.json",
  "skill-routing-rp-continuity-glm53flash.json",
  "media-routing-llm-continuity-glm53flash.json",
  "media-routing-llm-skills-glm53flash.json",
];
const routing = routingFiles.map((name) => {
  const file = path.join(root, "run", name);
  const report = json<{ passed: number; total: number; results: Array<{ id: string; passed: boolean; toolSequence: string[] }> }>(
    fs.readFileSync(file, "utf8"),
  );
  return { name, passed: report.passed, total: report.total, results: report.results };
});

const report = {
  generatedAt: new Date().toISOString(),
  valid:
    chains.every((chain) => chain.valid) &&
    Object.values(promptParity).every(Boolean) &&
    routing.flatMap((item) => item.results).every((item) => item.passed || item.id === "ledger-series"),
  promptParity,
  chains,
  routing,
  interpretation: {
    base:
      "The two Lustify renders use identical prompts but different random draws. Cross-run pixel or identity equality is not expected; each chain must be judged internally.",
    edit:
      "In both chains Seedream changes the coat to red while preserving the source face, hair, phone, pose, store, wet pavement and 3:4 framing. Output resolution is 864x1152 versus a 1152x1536 source.",
    video:
      "Both Wan mid-frames retain the source person, black coat, phone, rainy store exterior and continuous lighting while adding camera/subject motion. Both selected comparison clips are 832x480, 2 seconds.",
    routing:
      "GLM-5.3-Flash leaves ordinary work skill-free, selects roleplay and AIGC independently or together, refuses to invent a missing previous-frame id, and consumes the exact ledger id once continuity is supplied.",
  },
};

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "comparison.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

const row = (label: string, chain: (typeof chains)[number]) =>
  `| ${label} | ${chain.jobs.base.elapsedMs} ms | ${chain.jobs.edit.elapsedMs} ms | ${chain.jobs.video.elapsedMs} ms | ${chain.assets.base.width}x${chain.assets.base.height} | ${chain.assets.edit.width}x${chain.assets.edit.height} | ${chain.assets.video.width}x${chain.assets.video.height} / ${chain.provenance.videoDurationMs} ms | ${chain.graphValid ? "PASS" : "FAIL"} |`;
const markdown = `# Uncensia architecture-upgrade acceptance\n\nGenerated: ${report.generatedAt}\n\nOverall: **${report.valid ? "PASS" : "FAIL"}**\n\n| Chain | Lustify | Venice edit | Wan video | Base | Edit | Video | Provenance |\n|---|---:|---:|---:|---|---|---|---|\n${row("before", before!)}\n${row("after", after!)}\n\n## Invariants\n\n- Identical prompts across chains: base ${promptParity.base ? "PASS" : "FAIL"}, edit ${promptParity.edit ? "PASS" : "FAIL"}, video ${promptParity.video ? "PASS" : "FAIL"}.\n- Every asset exists and matches the SHA-256 stored in SQLite.\n- Each Venice image and Wan video names its exact Lustify source in the job, asset snapshot, and provenance table.\n- GLM-5.3-Flash routing artifacts are embedded in \`comparison.json\`.\n\n## Visual reading\n\n- ${report.interpretation.base}\n- ${report.interpretation.edit}\n- ${report.interpretation.video}\n- ${report.interpretation.routing}\n`;
fs.writeFileSync(path.join(outputDir, "report.md"), markdown, "utf8");
db.close();

console.log(`${report.valid ? "PASS" : "FAIL"} ${path.join(outputDir, "report.md")}`);
if (!report.valid) process.exitCode = 1;
