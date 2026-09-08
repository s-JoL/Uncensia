/** Siray async image/video protocol; model fields follow its published OpenAPI. */
import { setTimeout as delay } from "node:timers/promises";
import type { JsonSchema, ModelSpec } from "@shared/types.ts";
import { saveImageBytes, saveVideoBytes } from "../images.ts";
import { download, request as http } from "./http.ts";
import { ADDITIONAL_SOURCE_IDS_DESCRIPTION, GenerationError, type GenerationAdapter, type GenerationContext, type GenerationRequest, type GenerationResult } from "./types.ts";

export interface SirayProfile {
  fields: Record<string, JsonSchema>;
  required: string[];
  sources: "none" | "images" | "frames";
  maxSources: number;
}
const profile = (spec: ModelSpec): SirayProfile => {
  const value = spec.params?.siray as SirayProfile | undefined;
  if (!value?.fields || !value.required || !["none", "images", "frames"].includes(value.sources)) throw new GenerationError("Missing Siray model schema", "not_configured");
  return value;
};
const endpoint = (r: GenerationRequest) => `${r.provider.baseUrl.replace(/\/$/, "")}/${r.spec.kind === "image" ? "images/generations/async" : "video/generations"}`;
interface TaskData { task_id?: string; id?: string; status?: string; progress?: string; outputs?: string[]; fail_code?: string; fail_reason?: string }
async function payload(response: Response, submission = false) {
  // OpenAPI shows nested submission data; Siray SDK 1.3 reads top-level task_id/id.
  // Actual endpoints use both. HTTP status plus the task ID/state is authoritative,
  // not the cosmetic code/message spelling ("success", "Success", or numeric code).
  const value = await response.json().catch(() => { throw new GenerationError("Siray returned an unreadable response; check the task history before resubmitting", submission ? "delivery_unknown" : "upstream_error"); }) as TaskData & { message?: string; error?: { message?: string }; data?: TaskData };
  if (!response.ok || value.error) throw new GenerationError(value.error?.message || value.message || value.fail_code || `Siray returned ${response.status}`, "upstream_error");
  const data = value.data ?? value;
  return { ...data, task_id: data.task_id ?? data.id };
}
async function follow(r: GenerationRequest, ctx: GenerationContext, id: string): Promise<GenerationResult> {
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const state = await payload(await http(`${endpoint(r)}/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${ctx.apiKey}` }, cancel: ctx.signal, timeoutMs: 30_000, label: r.spec.name }));
    if (state.task_id !== id) throw new GenerationError("Siray returned a different task ID", "upstream_error");
    state.status = state.status?.toUpperCase();
    if (state.status === "FAILURE") throw new GenerationError(state.fail_reason || state.fail_code || "Siray task failed", state.fail_code || "upstream_error");
    if (state.status === "SUCCESS") {
      if (!state.outputs?.length) throw new GenerationError("Siray succeeded without outputs", "upstream_error");
      const assets: GenerationResult["assets"] = [];
      for (const url of state.outputs) {
        // Output URLs are public; never forward the provider credential to them.
        const { bytes, mime } = await download(url, ctx.signal, "Siray output");
        const kind = r.spec.kind === "image" ? "image" : "video";
        if (!mime.startsWith(`${kind}/`)) throw new GenerationError(`Siray returned ${mime} instead of ${kind}`, "upstream_error");
        const meta = { mime, provider: r.provider.id, model: r.spec.model, parents: r.sources.map(s => s.imageId) };
        if (kind === "image") {
          const assetId = await saveImageBytes(ctx.store, bytes, meta);
          const image = ctx.store.getImageAsset(assetId);
          assets.push({ assetId, kind, mime, width: image?.width ?? null, height: image?.height ?? null });
        } else {
          const duration = Number(r.params.duration);
          const durationMs = duration > 0 ? duration * 1000 : null;
          const posterAssetId = r.sources[0]?.imageId ?? null;
          const assetId = saveVideoBytes(ctx.store, bytes, { ...meta, durationMs, posterImageId: posterAssetId });
          assets.push({ assetId, kind, mime, width: null, height: null, durationMs, posterAssetId });
        }
      }
      return { assets, providerRequestId: id };
    }
    if (!["NOT_START", "SUBMITTED", "QUEUED", "IN_PROGRESS"].includes(state.status ?? "")) throw new GenerationError(`Unknown Siray task state: ${state.status}`, "upstream_error");
    const progress = Number.parseFloat(state.progress ?? "");
    ctx.progress(Number.isFinite(progress) ? progress / 100 : null, state.status!);
    await delay(5000, undefined, { signal: ctx.signal });
  }
  throw new GenerationError(`Siray task ${id} timed out; check its status before resubmitting`, "timeout");
}

export const sirayAdapter: GenerationAdapter = {
  id: "siray-media",
  runs: ["image_to_image", "text_to_video", "image_to_video"],
  schema(spec, op) {
    const p = profile(spec);
    const properties = structuredClone(p.fields);
    const required = [...p.required];
    if (op === "image_to_image" || op === "image_to_video") {
      properties.source_image_id = { type: "string", title: p.sources === "frames" ? "首帧图片" : "基础／第一张参考图", description: "Exact image_id from an upload or tool result." };
      required.push("source_image_id");
      if (p.maxSources > 1) properties.additional_source_image_ids = { type: "array", title: p.sources === "frames" ? "尾帧（可选）" : "其他参考图片", maxItems: p.maxSources - 1, items: { type: "string" }, description: p.sources === "frames" ? "Optional single end-frame image_id; this is an ending frame, not a style reference." : ADDITIONAL_SOURCE_IDS_DESCRIPTION };
    }
    return { type: "object", properties, required, additionalProperties: false };
  },
  async run(r, ctx) {
    const p = profile(r.spec);
    const expectsSource = r.op === "image_to_image" || r.op === "image_to_video";
    if (r.sources.length > p.maxSources || (expectsSource && !r.sources.length) || (!expectsSource && r.sources.length)) throw new GenerationError("Invalid Siray source count for the selected operation", "invalid_request");
    const body: Record<string, unknown> = { model: r.spec.model };
    for (const [name, field] of Object.entries(p.fields)) {
      const value = name === "prompt" ? r.prompt : r.params[name] ?? field.default;
      if (value !== undefined) body[name] = value;
    }
    const sources = r.sources.map(s => `data:${s.mime};base64,${s.bytes.toString("base64")}`);
    if (p.sources === "images" && sources.length) body.images = sources;
    if (p.sources === "frames") { body.image = sources[0]; if (sources[1]) body.end_image = sources[1]; }
    const response = await payload(await http(endpoint(r), { method: "POST", headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body), cancel: ctx.signal, timeoutMs: 60_000, attempts: 1, label: r.spec.name }), true);
    if (typeof response.task_id !== "string" || !response.task_id) throw new GenerationError("Siray returned no task ID; submission may have been accepted", "delivery_unknown");
    ctx.adopt(response.task_id);
    return follow(r, ctx, response.task_id);
  },
  resume: follow,
  // Siray publishes no cancellation endpoint. Abort stops local waiting only.
};
