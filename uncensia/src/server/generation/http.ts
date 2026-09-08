/**
 * Shared transport policy. Reads can retry transient failures. A render POST
 * may already have been accepted when its connection disappears, so repeating
 * it without provider idempotency can create another paid render.
 */
import { GenerationError } from "./types.ts";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

/** Statuses worth asking again, matching the ComfyUI adapter's list. */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

const transportFailure = (error: unknown) =>
  error instanceof TypeError || (error instanceof Error && error.name === "TypeError");

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** A failed connection does not establish why the service was unreachable. */
function unreachable(url: string, label: string, error: unknown, submission: boolean) {
  const host = hostOf(url);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  return new GenerationError(
    `${label} 与 ${host} 的连接失败${cause ? `（${cause}）` : ""}。${submission
      ? "未能确认服务是否接收了请求；为避免重复生成，没有自动重试。请先核对服务端记录。"
      : "未取得本次响应，请检查服务状态和连接。"}`,
    submission ? "delivery_unknown" : "unreachable",
  );
}

/** Exponential with jitter, so two adapters retrying do not march in step. */
export const backoff = (attempt: number) =>
  Math.round(BASE_DELAY_MS * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4));

const delay = (attempt: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, backoff(attempt));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new GenerationError("Cancelled", "cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export interface RequestOptions extends RequestInit {
  /** 1 disables retrying, for a request that must not be sent twice. */
  attempts?: number;
  /** The caller's cancellation, kept separate from the per-attempt timeout. */
  cancel?: AbortSignal;
  timeoutMs?: number;
  /** Rebuilt per attempt, because a FormData body cannot be sent twice. */
  bodyOf?: () => BodyInit;
  label: string;
}

export async function request(url: string, options: RequestOptions): Promise<Response> {
  const { attempts: configuredAttempts, cancel, timeoutMs = 300_000, bodyOf, label, ...init } = options;
  const readOnly = ["GET", "HEAD"].includes((init.method ?? "GET").toUpperCase());
  const attempts = configuredAttempts ?? (readOnly ? MAX_ATTEMPTS : 1);
  const idle = new AbortController().signal;
  let last: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (cancel?.aborted) throw new GenerationError("Cancelled", "cancelled");
    try {
      const response = await fetch(url, {
        ...init,
        body: bodyOf ? bodyOf() : init.body,
        signal: AbortSignal.any([cancel ?? idle, AbortSignal.timeout(timeoutMs)]),
      });
      if (response.ok || !RETRYABLE.has(response.status) || attempt === attempts) return response;
      last = new GenerationError(`${label} returned ${response.status}`, "upstream_error");
    } catch (error) {
      if (cancel?.aborted) throw new GenerationError("Cancelled", "cancelled");
      // A timeout or a cancel is a decision, not a hiccup.
      if (!transportFailure(error)) throw error;
      if (attempt === attempts) throw unreachable(url, label, error, !readOnly);
      last = error;
    }
    await delay(attempt, cancel ?? idle);
  }

  throw last instanceof Error ? last : new GenerationError(`${label} failed`, "upstream_error");
}

/** Reads the bytes of a result the provider hosts rather than inlines. */
export async function download(url: string, cancel: AbortSignal, label: string) {
  const response = await request(url, { cancel, label, timeoutMs: 120_000 });
  if (!response.ok) {
    throw new GenerationError(`Downloading from ${label} failed with ${response.status}`, "upstream_error");
  }
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    mime: response.headers.get("content-type")?.split(";")[0] ?? "image/png",
  };
}
