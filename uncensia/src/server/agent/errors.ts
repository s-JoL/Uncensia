import { classifyProviderFailure } from "@shared/provider-error.ts";

/**
 * The run's own failure sentence: what went wrong, with the provider's status
 * and its one useful sentence. Classification is shared with the clients, which
 * render the same failure from the raw message the transcript keeps.
 */
export function describeModelError(raw: string, modelName?: string, error?: unknown) {
  if (!String(raw ?? "").trim()) return "模型请求失败";
  const failure = classifyProviderFailure(raw, error);
  const where = modelName ? `${modelName}：` : "";
  const code = failure.status ? `（${failure.status}）` : "";
  // An unrecognised failure still carries its raw sentence; dropping it leaves
  // the reader with a generic headline and nothing to act on.
  const tail = failure.detail ? ` — ${failure.detail}` : "";
  return `${where}${failure.headline}${code}${tail}`;
}
