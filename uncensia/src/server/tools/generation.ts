/**
 * The generation layer, offered to the model as tools.
 *
 * The schemas come from the same adapters the studio renders, and this file makes
 * the two deliberate differences between the audiences — both of them here, so
 * neither is a surprise found in the frontend. `withIntent` adds the status label
 * only a tool call needs, and `forModel` drops the knobs an adapter marked as the
 * person's business: a sampler its author already tuned, a seed nothing in the
 * conversation names. Any other one-sided parameter is a bug in the adapter.
 *
 * And because a tool only exists when a model that can perform the operation is
 * configured, the tool list stays honest: no `edit_image` in front of a backend
 * that cannot edit (`03-generation.md §What the model calls`).
 *
 * These tools are the only image path. The MCP sidecar that used to carry local
 * ComfyUI is gone, because two ways to draw meant the model chose between them at
 * random; MCP remains what it is for: third-party servers.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  GenerationOp,
  JobRecord,
  JsonSchema,
  ModelSpec,
} from "@shared/types.ts";
import type { Jobs } from "../generation/jobs.ts";
import { forModel, schemaOf, supportsOp } from "../generation/index.ts";
import { encodeForModel, locateImage } from "../images.ts";
import type { Store } from "../store/store.ts";
import { IMAGE_DISPLAY_DESCRIPTION, INTENT_DESCRIPTION } from "./descriptions.ts";

export interface GenerationToolOptions {
  jobs: Jobs;
  store: Store;
  conversationId: string;
  /** Models the generation defaults resolved to, if any. */
  image?: ModelSpec;
  edit?: ModelSpec;
  video?: ModelSpec;
  /** Models asked for by name, each getting a tool of its own. */
  extraGeneration?: ModelSpec[];
  /** Images uploaded in this turn; Runtime discloses them as request data. */
  uploads: Array<{ id: string; mime: string; width: number | null; height: number | null }>;
  /** Forwards a running job onto the run's event stream. */
  onProgress?: (job: JobRecord) => void;
}

export const uploadedImageContext = (uploads: GenerationToolOptions["uploads"]) => {
  if (!uploads.length) return "";
  const lines = uploads.map((file, index) => {
    return `- uploaded image ${index + 1}: image_id=${file.id}; ${file.width ?? "?"}x${file.height ?? "?"}; ${file.mime}`;
  });
  return `\n\nCurrent request uploaded images:\n${lines.join("\n")}\nUpload order does not assign image roles. Choose the base from the user's request and put its exact ID in source_image_id; put every other picture actually used in additional_source_image_ids, in the order described by the prompt. Writing [Image 2] alone does not send pixels.`;
};

/**
 * What the model gets back. `image_id` / `video_id` stay because the transcript
 * and `view_image` already speak that name; `asset` is the same `GeneratedAsset`
 * the gallery and the job row use, so nothing has to convert.
 */
async function resultFor(job: JobRecord, store: Store) {
  const asset = job.assets[0];
  if (!asset) throw new Error(job.error ?? "The job produced nothing");
  const provider = store.getModel(job.modelId)?.providerId ?? null;

  if (asset.kind === "video") {
    const structured = {
      job_id: job.id,
      video_id: asset.assetId,
      mime_type: asset.mime,
      width: asset.width,
      height: asset.height,
      duration_ms: asset.durationMs ?? null,
      poster_image_id: asset.posterAssetId ?? null,
      provider,
      model: job.modelName,
      asset,
    };
    return {
      content: [
        {
          type: "text" as const,
          text: `Rendered video ${asset.assetId}.\n${JSON.stringify(structured)}\nThe user can already see it; describe it rather than repeating the id.`,
        },
      ],
      details: { structuredContent: structured },
    };
  }

  const structured = {
    job_id: job.id,
    image_id: asset.assetId,
    mime_type: asset.mime,
    width: asset.width,
    height: asset.height,
    provider,
    model: job.modelName,
    parent_image_ids: job.sources,
    asset,
  };
  // The model sees the picture it just made, which is what lets it judge whether
  // the next step is another edit or an answer.
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
    {
      type: "text",
      text: `Produced image ${asset.assetId}.\n${JSON.stringify(structured)}\n${IMAGE_DISPLAY_DESCRIPTION}\nUse image_id as source_image_id for edits.`,
    },
  ];
  const located = locateImage(store, asset.assetId);
  const encoded = located && (await encodeForModel(asset.assetId, located.diskPath, located.mime));
  if (encoded) content.push({ type: "image", ...encoded });
  return { content, details: { structuredContent: structured } };
}

/**
 * A generation tool is always the same three steps — submit, follow, report — so
 * `op` is the only thing that varies, and it can depend on the arguments: naming
 * a first frame is what turns text-to-video into image-to-video.
 */
function tool(
  name: string,
  description: string,
  schema: JsonSchema,
  spec: ModelSpec,
  op: GenerationOp | ((params: Record<string, unknown>) => GenerationOp),
  options: GenerationToolOptions,
): AgentTool {
  return {
    name,
    label: name,
    description: `${description}\n${IMAGE_DISPLAY_DESCRIPTION}`,
    parameters: withIntent(forModel(schema)) as never,
    execute: async (_callId, args, signal) => {
      // `intent` is the live status label, not a generation parameter, so it does
      // not belong in the job row or in what the backend is asked for.
      const { intent: _intent, ...params } = (args ?? {}) as Record<string, unknown>;
      const job = options.jobs.submit({
        modelId: spec.id,
        op: typeof op === "function" ? op(params) : op,
        conversationId: options.conversationId,
        params,
      });
      const abort = () => void options.jobs.cancel(job.id);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const settled = await options.jobs.await(job.id, options.onProgress);
        if (settled.status !== "succeeded") {
          throw new Error(settled.error ?? `The job ended as ${settled.status}`);
        }
        return await resultFor(settled, options.store);
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}

/** First property, so a client can label the call while the arguments stream. */
const withIntent = (schema: JsonSchema): JsonSchema => ({
  ...schema,
  properties: { intent: { type: "string", description: INTENT_DESCRIPTION }, ...schema.properties },
  required: ["intent", ...(schema.required ?? [])],
});

const drawTool = (name: string, spec: ModelSpec, options: GenerationToolOptions) =>
  tool(
    name,
    `Create one new image from a description with ${spec.name}. This operation does not pass an existing image's pixels as a source. Each call is independent; the description must include what this image needs. Applicable to new work and refinements of a generation task. Resolve the operation from the active task, including earlier user constraints. A request for analysis or a written prompt needs no media call.`,
    schemaOf(spec, "text_to_image"),
    spec,
    "text_to_image",
    options,
  );

const editTool = (name: string, spec: ModelSpec, options: GenerationToolOptions) =>
  tool(
    name,
    `Edit or combine existing images with ${spec.name}, including carrying a selected identity into a new scene. Do not use for an explicitly requested independent regeneration, or for inspection alone. source_image_id is the base and must be copied exactly from the conversation or a tool result. Additional pictures only reach the backend as additional_source_image_ids, in order; naming them in the prompt is not enough. Use the user's selected version, not automatically the newest image. The backend reads the pixels, so this works even when the chat model cannot see images; that does not give a text-only chat model visual verification.`,
    schemaOf(spec, "image_to_image"),
    spec,
    "image_to_image",
    options,
  );

function videoTool(name: string, spec: ModelSpec, options: GenerationToolOptions) {
  // One tool, two ops: whether a first frame was named decides which.
  const animates = supportsOp(spec, "image_to_video");
  const op: GenerationOp = supportsOp(spec, "text_to_video") ? "text_to_video" : "image_to_video";
  const schema = schemaOf(spec, op);
  if (animates && op === "text_to_video") {
    schema.properties = {
      ...schema.properties,
      source_image_id: {
        type: "string",
        title: "首帧图片（可选）",
        description: "Copy an exact image_id to animate it instead of starting from text.",
      },
    };
  }
  return tool(
    name,
    `Render a short video with ${spec.name}. This takes minutes rather than seconds. ${
      animates ? "Name a source_image_id to animate an existing image." : ""
    }`,
    schema,
    spec,
    (params) => (params.source_image_id && animates ? "image_to_video" : op),
    options,
  );
}

/**
 * Model ids carry colons and dots; tool names may not. Truncated well inside the
 * 64-character ceiling providers impose, then made unique, because two ids can
 * collide once shortened and a repeated tool name is silently dropped.
 */
function suffix(spec: ModelSpec, taken: Set<string>) {
  const base = spec.id.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "model";
  let slug = base;
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}_${n}`;
  taken.add(slug);
  return slug;
}

export function generationTools(options: GenerationToolOptions): AgentTool[] {
  const tools: AgentTool[] = [];
  const { image, edit, video, extraGeneration } = options;

  if (image && supportsOp(image, "text_to_image")) tools.push(drawTool("generate_image", image, options));

  // Default selection belongs to resolveGeneration. A missing/invalid editor
  // must not quietly become the drawing backend here.
  const editor = edit && supportsOp(edit, "image_to_image") ? edit : undefined;
  if (editor) tools.push(editTool("edit_image", editor, options));

  if (video) tools.push(videoTool("generate_video", video, options));

  // A model already reachable through one of the three above is not offered a
  // second time under its own name: two tools doing one thing is a coin flip.
  const covered = new Set<string>();
  if (image && supportsOp(image, "text_to_image")) covered.add(`${image.id}:draw`);
  if (editor) covered.add(`${editor.id}:edit`);
  if (video) covered.add(`${video.id}:video`);

  const slugs = new Set<string>();
  for (const spec of extraGeneration ?? []) {
    const films = spec.kind === "video" && !covered.has(`${spec.id}:video`);
    const draws = spec.kind !== "video" && supportsOp(spec, "text_to_image") && !covered.has(`${spec.id}:draw`);
    const edits = spec.kind !== "video" && supportsOp(spec, "image_to_image") && !covered.has(`${spec.id}:edit`);
    // Claims a slug only once the model is known to contribute, so a fully
    // covered one cannot push the next model onto a disambiguating suffix.
    if (!films && !draws && !edits) continue;
    const slug = suffix(spec, slugs);
    if (films) tools.push(videoTool(`generate_video_${slug}`, spec, options));
    if (draws) tools.push(drawTool(`generate_image_${slug}`, spec, options));
    if (edits) tools.push(editTool(`edit_image_${slug}`, spec, options));
  }

  return tools;
}
