import { getBuiltinModel, getBuiltinModels, getBuiltinModelDataGeneratedAt, type BuiltinProvider } from "@earendil-works/pi-ai/providers/all";
import type { ModelReference } from "@shared/types.ts";

// Prefer the model author's catalogue, never an arbitrary gateway's limits.
const AUTHORS: BuiltinProvider[] = ["google", "deepseek", "moonshotai", "zai", "xai", "anthropic", "openai"];
const ALIASES: Record<string, [BuiltinProvider, string]> = {
  "deepseek-v4-flash-0731": ["deepseek", "deepseek-v4-flash"],
  "deepseek-v4-flash-vision": ["deepseek", "deepseek-v4-flash-vision-exp"],
};
const catalog = new Map(AUTHORS.flatMap(provider => getBuiltinModels(provider).map(model => [model.id, model] as const)));

/** Exact identifiers only. Unknown versions stay unknown, not family guesses. */
export function modelReference(id: string): ModelReference | undefined {
  const alias = ALIASES[id];
  const model = alias ? getBuiltinModel(alias[0], alias[1] as never) : catalog.get(id);
  if (!model) return undefined;
  return {
    contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    input: [...model.input], reasoning: model.reasoning,
    source: `Pi · ${model.provider} · ${model.id}`,
    sourceUrl: `https://pi.dev/models/${encodeURIComponent(model.provider)}/${encodeURIComponent(model.id.replaceAll(".", "-"))}`,
    updatedAt: getBuiltinModelDataGeneratedAt() ?? null,
    note: "模型原厂目录的参考能力；网关可能另有限制。输出预算可以低于上限，采用参考值不会改变思考等级。",
  };
}
