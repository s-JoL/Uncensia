/**
 * Venice's native image endpoints. They are not OpenAI's `/images/generations`.
 *
 * Generate is `POST /image/generate` and answers `{ images: [base64] }`. Edit is
 * a different path — `/image/edit` for one source, `/image/multi-edit` when the
 * row says it can compose — and usually a different model id (`…-edit`). A
 * successful edit answers with the image bytes (`image/png`), not that JSON
 * envelope. Calling the OpenAI-shaped path is a 404 dressed up as a failed render.
 *
 * `safe_mode` defaults to true on their side and blurs the result. That is a
 * filter Uncensia does not add (`00-product.md`), so every request sends false.
 */
import type { GenerationOp, JsonSchema, ModelSpec } from "@shared/types.ts";
import { saveImageBytes } from "../images.ts";
import { request as http } from "./http.ts";
import {
  ADDITIONAL_SOURCE_IDS_DESCRIPTION,
  GenerationError,
  promptField,
  type GenerationAdapter,
  type GenerationRequest,
  type GenerationResult,
} from "./types.ts";

const TIMEOUT_MS = 300_000;
const AUTO = "auto";
const DEFAULT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"];
// Native edit endpoints use a different enum from generation. Source:
// https://docs.venice.ai/api-reference/endpoint/image/edit (2026-09-07).
const EDIT_RATIOS = ["auto", "1:1", "3:2", "16:9", "21:9", "9:16", "2:3", "3:4", "4:5"];

interface VeniceImageParams {
  aspectRatios?: string[];
  editAspectRatios?: string[];
  resolutions?: string[];
  qualities?: string[];
  sizes?: string[];
  maxSources?: number;
  promptLimit?: number;
  promptHints?: string;
  extra?: Record<string, unknown>;
  /** Remote id for edits when the host splits generate and edit (e.g. `seedream-v5-pro-edit`). */
  editModel?: string;
}

interface ImagePayload {
  images?: string[];
  image?: string;
  data?: Array<{ b64_json?: string }>;
  error?: string | { message?: string };
  message?: string;
  details?: unknown;
}

const params = (spec: ModelSpec) => (spec.params ?? {}) as VeniceImageParams;
const maxSourcesOf = (spec: ModelSpec) => Math.max(1, params(spec).maxSources ?? 1);
const modelOf = (request: GenerationRequest) =>
  request.op === "image_to_image" ? params(request.spec).editModel ?? request.spec.model : request.spec.model;
const ratiosOf = (spec: ModelSpec, op: GenerationOp) => {
  const configured = params(spec);
  const declared = op === "image_to_image"
    ? configured.editAspectRatios ?? configured.aspectRatios ?? EDIT_RATIOS
    : configured.aspectRatios ?? DEFAULT_RATIOS;
  return op === "image_to_image" && !declared.includes(AUTO) ? [AUTO, ...declared] : declared;
};

function errorOf(payload: ImagePayload, fallback: string) {
  const nested = typeof payload.error === "object" ? payload.error.message : payload.error;
  const fields: string[] = [];
  const visit = (value: unknown, field: string, depth: number) => {
    if (depth > 6 || fields.length >= 12 || !value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "_errors" && Array.isArray(child)) {
        for (const message of child) if (typeof message === "string") fields.push(`${field || "request"}: ${message.slice(0, 300)}`);
      } else visit(child, [field, key].filter(Boolean).join("."), depth + 1);
    }
  };
  visit(payload.details, "", 0);
  return [nested || payload.message || fallback, ...fields].join("; ");
}

function decodeImage(encoded: string) {
  const stripped = encoded.replace(/^data:[^;]+;base64,/, "");
  return { bytes: Buffer.from(stripped, "base64"), mime: "image/png" };
}

async function readImage(response: Response, spec: ModelSpec) {
  const mime = response.headers.get("content-type")?.split(";")[0]?.toLowerCase() ?? "";
  // Edit answers with the image bytes themselves. Generate answers JSON
  // `{ images: [base64] }`. Treating both as JSON is how a successful 20-second
  // Seedream edit used to land as "the provider returned no image".
  if (mime.startsWith("image/")) {
    if (!response.ok) throw new GenerationError(`${spec.name} returned ${response.status}`, "upstream_error");
    return { bytes: Buffer.from(await response.arrayBuffer()), mime };
  }
  const payload = (await response.json().catch(() => ({}))) as ImagePayload;
  if (!response.ok) {
    throw new GenerationError(errorOf(payload, `${spec.name} returned ${response.status}`), "upstream_error");
  }
  const encoded = payload.images?.[0] ?? payload.image ?? payload.data?.[0]?.b64_json;
  if (!encoded) throw new GenerationError(errorOf(payload, "The provider returned no image"), "upstream_error");
  return decodeImage(encoded);
}

function encode(source: { bytes: Buffer; mime: string }) {
  return source.bytes.toString("base64");
}

function frameOf(spec: ModelSpec, request: GenerationRequest) {
  const extras: Record<string, unknown> = {};
  const ratios = ratiosOf(spec, request.op);
  const askedRatio = String(request.params.aspect_ratio ?? "");
  if (askedRatio && askedRatio !== AUTO && ratios.includes(askedRatio)) extras.aspect_ratio = askedRatio;
  const resolutions = params(spec).resolutions ?? [];
  const askedResolution = String(request.params.resolution ?? "");
  if (askedResolution && resolutions.includes(askedResolution)) extras.resolution = askedResolution;
  const qualities = params(spec).qualities ?? [];
  const askedQuality = String(request.params.quality ?? "");
  if (askedQuality && qualities.includes(askedQuality)) extras.quality = askedQuality;
  const sizes = params(spec).sizes ?? [];
  const askedSize = String(request.params.size ?? "");
  if (askedSize && /^\d+x\d+$/.test(askedSize) && sizes.includes(askedSize)) {
    const [width, height] = askedSize.split("x").map(Number);
    extras.width = width;
    extras.height = height;
  }
  return extras;
}

export const veniceImagesAdapter: GenerationAdapter = {
  id: "venice-images",
  runs: ["text_to_image", "image_to_image"],

  schema(spec, op) {
    const configured = params(spec);
    const properties: Record<string, JsonSchema> = {
      prompt: promptField(
        op === "image_to_image" ? "改成什么样" : "画面描述",
        configured.promptLimit ?? 7_500,
        configured.promptHints,
      ),
    };
    const ratios = ratiosOf(spec, op);
    if (ratios.length) {
      properties.aspect_ratio = {
        type: "string",
        title: "画幅",
        enum: ratios,
        default: ratios[0],
        description:
          op === "image_to_image"
            ? `${AUTO} keeps the source image's frame. An explicit ratio reframes it.`
            : "The frame the backend should render into.",
      };
    }
    if (configured.resolutions?.length) {
      properties.resolution = {
        type: "string",
        title: "分辨率",
        enum: configured.resolutions,
        default: configured.resolutions[0],
      };
    }
    if (configured.qualities?.length) {
      properties.quality = {
        type: "string",
        title: "质量",
        enum: configured.qualities,
        default: configured.qualities[0],
      };
    }
    if (configured.sizes?.length) {
      properties.size = {
        type: "string",
        title: "尺寸",
        enum: configured.sizes,
        default: configured.sizes[0],
      };
    }
    if (op === "image_to_image") {
      properties.source_image_id = {
        type: "string",
        title: "源图片",
        description: "Copy an exact image_id from the conversation.",
      };
      const extras = maxSourcesOf(spec) - 1;
      if (extras > 0) {
        properties.additional_source_image_ids = {
          type: "array",
          title: `参考图（最多 ${extras} 张，按顺序作为参考）`,
          description: ADDITIONAL_SOURCE_IDS_DESCRIPTION,
          items: { type: "string" },
          maxItems: extras,
        };
      }
    }
    return {
      type: "object",
      properties,
      required: op === "image_to_image" ? ["prompt", "source_image_id"] : ["prompt"],
    };
  },

  async run(request, ctx): Promise<GenerationResult> {
    if (!ctx.apiKey) throw new GenerationError("Venice AI has no API key configured", "not_configured");
    const { spec, provider } = request;
    const base = provider.baseUrl.replace(/\/+$/, "");
    const editing = request.op === "image_to_image";
    if (editing && !request.sources.length) {
      throw new GenerationError("This operation needs a source image", "invalid_request");
    }
    if (editing && request.sources.length > maxSourcesOf(spec)) {
      throw new GenerationError(`${spec.name} accepts at most ${maxSourcesOf(spec)} images`, "invalid_request");
    }
    ctx.progress(null, "已提交");

    const model = modelOf(request);
    const body: Record<string, unknown> = {
      model,
      prompt: request.prompt,
      safe_mode: false,
      ...(editing ? { output_format: "png" } : { format: "png" }),
      ...frameOf(spec, request),
      ...(params(spec).extra ?? {}),
    };
    let path = "/image/generate";
    if (editing) {
      const compose = request.sources.length > 1;
      path = compose ? "/image/multi-edit" : "/image/edit";
      if (compose) {
        // Venice's multi-edit contract names this field modelId, while its
        // single-edit/generate contracts use model. Never let an omitted field
        // select the provider's default model.
        delete body.model;
        body.modelId = model;
        body.images = request.sources.map(encode);
      }
      else body.image = encode(request.sources[0]!);
    }

    const response = await http(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      cancel: ctx.signal,
      timeoutMs: TIMEOUT_MS,
      label: `${spec.name} ${path}`,
    });
    const { bytes, mime } = await readImage(response, spec);
    const imageId = await saveImageBytes(ctx.store, bytes, {
      mime,
      provider: provider.id,
      model,
      width: null,
      height: null,
      parents: request.sources.map((source) => source.imageId),
    });
    const asset = ctx.store.getImageAsset(imageId);
    return {
      assets: [
        { assetId: imageId, kind: "image", mime, width: asset?.width ?? null, height: asset?.height ?? null },
      ],
    };
  },
};
