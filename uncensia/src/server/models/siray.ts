/** Explicit Siray profiles, verified against /api-reference/openapi-spec on 2026-09-07.
 * Model IDs select documented protocols; these are not intent-routing rules. */
import type { JsonSchema, ModelInput } from "@shared/types.ts";
import type { SirayProfile } from "../generation/siray.ts";

const choice = (title: string, values: Array<string | number>): JsonSchema => ({ type: typeof values[0] === "number" ? "integer" : "string", title, enum: values });
const prompt: JsonSchema = { type: "string", title: "提示词", minLength: 1, description: "Describe the requested changes or motion, and the details to preserve. References are sent separately in order." };
const seed: JsonSchema = { type: "integer", title: "随机种子", minimum: -1, maximum: 2147483647, audience: "studio" };
const expansion: JsonSchema = { type: "boolean", title: "供应商扩写提示词", default: true, audience: "studio" };
const defaults = { providerId: "siray", apiMode: "siray-media" as const, enabled: true, pinned: false, agentTool: false, reasoning: false, input: ["text", "image"] as Array<"text" | "image">, contextWindow: 4096, maxTokens: 4096, thinkingLevel: "off" as const };
function row(model: string, name: string, kind: "image" | "video", ops: ModelInput["ops"], siray: SirayProfile, options: Pick<ModelInput, "enabled" | "agentTool"> = { enabled: true, agentTool: false }): ModelInput {
  return { ...defaults, ...options, id: `siray:${model.split("/")[1]}`, name: `${name} · Siray`, model, kind, ops, params: { siray } };
}
export const sirayModels: ModelInput[] = [
  row("bytedance/seedream-5.0-pro-i2i-spicy", "Seedream 5.0 Pro Spicy · I2I", "image", ["image_to_image"], {
    sources: "images", maxSources: 10, required: ["prompt", "size"], fields: {
      prompt,
      size: choice("输出尺寸", ["1024x1024", "1152x864", "864x1152", "1424x800", "800x1424", "1248x832", "832x1248", "1568x672", "2048x2048", "2368x1776", "1776x2368", "2816x1584", "1584x2816", "2496x1664", "1664x2496", "3136x1344"]),
      output_format: { ...choice("文件格式", ["jpg", "png"]), default: "png", audience: "studio" },
    },
  }),
  row("alibaba/qwen-image-3-pro-edit-spicy", "Qwen Image 3 Pro Spicy · I2I", "image", ["image_to_image"], {
    sources: "images", maxSources: 3, required: ["prompt", "size", "aspect_ratio"], fields: {
      prompt, size: choice("分辨率", ["1k", "2k"]),
      aspect_ratio: choice("画幅", ["1:1", "1:2", "2:1", "1:3", "3:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "9:21", "21:9"]),
      seed, prompt_expansion_enable: expansion,
      // One call delivers one image in Uncensia's conversational media contract.
      n: { type: "integer", title: "输出数量", enum: [1], default: 1, audience: "studio" },
    },
  }, { enabled: false, agentTool: false }),
];
for (const family of ["wan", "seedance"] as const) {
  const wan = family === "wan";
  const root = wan ? "alibaba/wan-3.0" : "bytedance/seedance-2.5";
  const title = wan ? "Wan 3.0 Spicy" : "Seedance 2.5 Spicy";
  for (const mode of ["t2v", "i2v", "ref2v"] as const) {
    const reference = mode === "ref2v", frames = mode === "i2v";
    const fields: Record<string, JsonSchema> = {
      prompt,
      duration: choice("时长（秒）", [...(!wan && reference ? [-1] : []), ...Array.from({ length: wan ? 29 : 27 }, (_, i) => i + (wan ? 2 : 4))]),
      size: choice("分辨率", wan ? ["480p", "720p", "1080p"] : ["720p", "480p", "1080p"]),
      aspect_ratio: choice("画幅", wan ? ["16:9", "9:16", "1:1", "4:3", "3:4", "adaptive"] : ["adaptive", "16:9", "4:3", "1:1", "3:4", "9:16", "21:9"]),
      audio_enable: { type: "boolean", title: "生成声音" },
      ...(wan ? { seed, prompt_expansion_enable: expansion } : {}),
    };
    // Live upstream rejects explicit ratios for Seedance first/end-frame jobs
    // (InvalidParameter.TaskTypeConstraint), despite the broader OpenAPI enum.
    if (!wan && frames) fields.aspect_ratio = { ...choice("画幅（跟随首帧）", ["adaptive"]), default: "adaptive", description: "First/end-frame video follows the first image's aspect ratio." };
    if (!wan && reference) fields.duration!.description = "-1 lets the provider determine duration; otherwise the exact selected seconds.";
    if (reference) for (const name of ["videos", "audios"]) fields[name] = { type: "array", title: name === "videos" ? "参考视频 URL" : "参考音频 URL", items: { type: "string" }, maxItems: wan ? 5 : 10, description: "Explicit public URLs of references the user wants included." };
    sirayModels.push(row(`${root}-${mode}-spicy`, `${title} · ${mode.toUpperCase()}`, "video", frames ? ["image_to_video"] : reference ? ["text_to_video", "image_to_video"] : ["text_to_video"], {
      fields, required: ["prompt", "duration", "size", "aspect_ratio"], sources: frames ? "frames" : reference ? "images" : "none", maxSources: frames ? 2 : reference ? (wan ? 10 : 30) : 0,
    }, { enabled: wan, agentTool: wan && mode !== "t2v" }));
  }
}
