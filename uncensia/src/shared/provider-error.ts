/**
 * Provider failures arrive as a status code glued to whatever JSON the gateway
 * felt like returning. Showing that to the reader is useless, and the useful
 * part — the one sentence explaining what went wrong — is buried inside it.
 * This pulls that sentence out and says what kind of failure it is, so every
 * client can say what can be done about it. Headlines are the Chinese source
 * strings the web client translates with `uiText`.
 */

export type ProviderFailureKind = "auth" | "permission" | "not_found" | "request" | "rate_limit" | "timeout" | "server" | "network" | "unknown";

export interface ProviderFailure {
  status: number;
  kind: ProviderFailureKind;
  headline: string;
  /** The provider's own sentence, when one could be found. */
  detail: string;
}

const BY_STATUS = new Map<number, [ProviderFailureKind, string]>([
  [401, ["auth", "服务商拒绝了密钥，请在设置里检查 API Key"]],
  [403, ["permission", "服务商拒绝了这次请求，密钥可能没有该模型的权限"]],
  [404, ["not_found", "服务商没有这个模型或接口，请检查模型 ID 和 Base URL"]],
  [408, ["timeout", "服务商响应超时"]],
  [413, ["request", "请求内容过大，请缩短消息或减少附件"]],
  [422, ["request", "服务商拒绝了请求参数"]],
  [429, ["rate_limit", "触发了服务商限流，请稍后再试"]],
  [500, ["server", "服务商内部错误"]],
  [502, ["server", "服务商网关错误"]],
  [503, ["server", "服务商暂时不可用"]],
  [504, ["timeout", "服务商网关超时"]],
]);

const NETWORK = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|getaddrinfo|Connection error/i;

/** Digs the human sentence out of whatever shape the gateway returned. */
function detailFrom(body: unknown, depth = 0): string {
  if (typeof body === "string") return body;
  if (depth > 4 || !body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  for (const key of ["message", "detail", "error_message", "msg"]) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  for (const key of ["error", "data", "body"]) {
    const nested = detailFrom(record[key], depth + 1);
    if (nested) return nested;
  }
  return "";
}

/** The status a thrown error states about itself, if it states one. */
function statusOf(error: unknown) {
  const value = (error as { status?: unknown; statusCode?: unknown })?.status ?? (error as { statusCode?: unknown })?.statusCode;
  return typeof value === "number" && value >= 100 && value < 600 ? value : 0;
}

/**
 * `error` is the thrown object when the caller has it. Its own status is used
 * first, because recovering one from prose reads the first three digits it can
 * find: `read timeout after 504 ms` became "网关超时（504）", and a body
 * mentioning `429 requests/min` turned an unrelated 500 into a rate-limit
 * explanation. Scraping remains only as the last resort for gateways that put
 * the code nowhere else.
 */
export function classifyProviderFailure(raw: string, error?: unknown): ProviderFailure {
  const message = String(raw ?? "").trim();
  if (!message) return { status: 0, kind: "unknown", headline: "模型请求失败", detail: "" };

  const status = statusOf(error) || Number(message.match(/(?:^|\s)(\d{3})(?::|\s)/)?.[1] ?? 0);
  const braceAt = message.indexOf("{");
  let detail = "";
  if (braceAt >= 0) {
    try {
      detail = detailFrom(JSON.parse(message.slice(braceAt)));
    } catch {
      detail = "";
    }
  }
  if (!detail) detail = (braceAt > 0 ? message.slice(0, braceAt) : message).replace(/[:\s]+$/, "");

  const known = BY_STATUS.get(status);
  const [kind, headline]: [ProviderFailureKind, string] =
    known ??
    (NETWORK.test(message)
      ? ["network", "无法连接到服务商，请检查网络或代理"]
      : status >= 500
        ? ["server", "服务商内部错误"]
        : ["unknown", "模型请求失败"]);
  return { status, kind, headline, detail: detail === headline ? "" : detail.slice(0, 300) };
}

/** Whether the person has to change a key, model or address before retrying helps. */
export const needsSettings = (kind: ProviderFailureKind) => kind === "auth" || kind === "permission" || kind === "not_found";
