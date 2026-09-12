/**
 * Thin client over the `/v1` contract. The session token is mirrored into
 * localStorage for the Authorization header; the server also sets an HttpOnly
 * cookie, which is what lets plain `<img src="/v1/images/…">` work.
 */
import type {
  Approval,
  ImageAttachmentReference,
  BackgroundTask,
  TaskSchedule,
  LearningChange,
  Bootstrap,
  BulkAddResult,
  Capabilities,
  ConversationSearchHit,
  ConversationSummary,
  DiscoveredModel,
  FileKind,
  FileLibrary,
  FileRecord,
  GeneratedAsset,
  JobInput,
  JobRecord,
  JobStatus,
  McpServer,
  McpStatus,
  MemoryRecord,
  ModelInput,
  ModelSpec,
  ModelReference,
  ManagedSkill,
  Paginated,
  PromptDefaults,
  PromptSettings,
  Provenance,
  Provider,
  ProviderInput,
  RoleplayContext,
  RunSummary,
  SecuritySettings,
  StoredMessage,
  StudioTool,
  VisualContinuityContext,
} from "@shared/types.ts";

const TOKEN_KEY = "uncensia.token";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const token = {
  get: () => localStorage.getItem(TOKEN_KEY) ?? "",
  set: (value: string) => localStorage.setItem(TOKEN_KEY, value),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

/**
 * The rotation header is a promise, not a request: the server only replaces a
 * token for a client that has said it will store the replacement, because
 * handing one to a client that drops it signs the owner out.
 */
function authHeaders(extra: Record<string, string> = {}) {
  const value = token.get();
  return value ? { authorization: `Bearer ${value}`, "x-uncensia-token-rotation": "1", ...extra } : extra;
}

/**
 * Adopts a replacement token. The old one keeps working for a grace window, so
 * a request already in flight cannot fail — but only if the new one is stored,
 * and only if it is really there: writing an empty value would be the logout
 * this whole mechanism exists to avoid.
 *
 * Every response that is read to completion goes through here. The two event
 * streams do not, because the server never rotates on one: a client consuming
 * a stream it opened hours ago has no reason to re-read its headers.
 */
function adoptRotatedToken(response: Response) {
  const rotated = response.headers.get("x-uncensia-token");
  if (rotated) token.set(rotated);
}

/** Confirmation the server demands in front of a change that outlives a session. */
export interface StepUp {
  accessCode: string;
  /** Empty when no authenticator is enrolled; the header is then omitted. */
  totp?: string;
}

const stepUpHeaders = ({ accessCode, totp }: StepUp): Record<string, string> => ({
  "x-uncensia-access-code": accessCode,
  ...(totp ? { "x-uncensia-totp": totp } : {}),
});

async function request<T>(
  method: string,
  endpoint: string,
  body?: unknown,
  signal?: AbortSignal,
  extra: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(`/v1${endpoint}`, {
    method,
    headers: authHeaders(body === undefined ? extra : { "content-type": "application/json", ...extra }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  adoptRotatedToken(response);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    const error = (parsed as { error?: { code?: string; message?: string } }).error;
    throw new ApiError(response.status, error?.code ?? "error", error?.message ?? `Request failed (${response.status})`);
  }
  return parsed as T;
}

export const api = {
  conversationEvidence: (id: string) => request<{ deliverables: Array<{ key: string; description: string; status: string; asset_id?: string; evidence?: string }>; feedback: Array<{ entry_id: string; text: string }>; contexts: Array<{ runId: string; modelId: string; modelInput: string[]; tools: string[] }> }>("GET", `/resources/conversations/${encodeURIComponent(id)}/evidence`),
  acquireResource: (url: string) => request<{ file_id: string; indexing: string; index_error: string | null }>("POST", "/resources/acquire", { url }),
  resourceQuote: (id: string) => request<{ text: string; title: string; start_line: number; end_line: number; file_id: string }>("GET", `/resources/quotes/${encodeURIComponent(id)}`),
  resourceText: (id: string, start = 1, encoding?: string) => request<{ text: string; title: string; next_line: number | null; total_lines: number }>("GET", `/resources/files/${encodeURIComponent(id)}?start=${start}${encoding ? `&encoding=${encodeURIComponent(encoding)}` : ""}`),
  resourceSources: (id: string) => request<Array<{ original_url: string; final_url: string; fetched_at: string }>>("GET", `/resources/sources/${encodeURIComponent(id)}`),
  saveFeedback: (conversationId: string, seq: number, text: string) => request("POST", "/resources/feedback", { conversationId, seq, text }),
  modelReference: (model: string) => request<{ reference: ModelReference | null }>("GET", `/model-reference?model=${encodeURIComponent(model)}`),
  skills: () => request<{ items: ManagedSkill[]; diagnostics: string[] }>("GET", "/skills"),
  learningHistory: () => request<{ items: LearningChange[] }>("GET", "/learning/history"),
  createSkill: (content: string) => request("POST", "/skills", { content }),
  updateSkill: (id: string, input: { content?: string; revision?: string; enabled?: boolean }) => request("PATCH", `/skills/${id}`, input),
  allBackgroundTasks: () => request<{ items: BackgroundTask[] }>("GET", "/background-tasks"),
  loginChallenge: () => request<{ totpRequired: boolean; lockedFor: number }>("GET", "/auth/challenge"),
  login: (accessCode: string, totp = "") =>
    request<{ token: string; expiresAt: number }>("POST", "/auth/token", {
      accessCode,
      totp,
      deviceName: navigator.platform || "web",
    }),
  logout: () => request<void>("POST", "/auth/logout"),

  security: () => request<SecuritySettings>("GET", "/security"),
  setAccessCode: (value: string, step: StepUp) =>
    request<SecuritySettings>("PUT", "/security/access-code", { value }, undefined, stepUpHeaders(step)),
  startTotp: (step: StepUp) =>
    request<{ secret: string; uri: string }>("POST", "/security/totp", undefined, undefined, stepUpHeaders(step)),
  /** Enrolment proves the authenticator by itself, so this one needs no step-up. */
  confirmTotp: (code: string) => request<SecuritySettings>("POST", "/security/totp/confirm", { code }),
  // The body's `code` is the server's fallback for the TOTP header, so it has to
  // be the same value rather than a second one to disagree with.
  disableTotp: (step: StepUp) =>
    request<SecuritySettings>("DELETE", "/security/totp", { code: step.totp ?? "" }, undefined, stepUpHeaders(step)),
  revokeSession: (id: string, step: StepUp) =>
    request<SecuritySettings>("DELETE", `/security/sessions/${id}`, undefined, undefined, stepUpHeaders(step)),
  revokeOtherSessions: (step: StepUp) =>
    request<SecuritySettings>("POST", "/security/sessions/revoke-others", undefined, undefined, stepUpHeaders(step)),
  bootstrap: () => request<Bootstrap>("GET", "/bootstrap"),

  conversations: () => request<Paginated<ConversationSummary>>("GET", "/conversations?limit=100"),
  /** Full text across every conversation. The signal is for search-as-you-type. */
  searchConversations: (query: string, signal?: AbortSignal) =>
    request<{ items: ConversationSearchHit[] }>(
      "GET",
      `/conversations/search?q=${encodeURIComponent(query)}`,
      undefined,
      signal,
    ),
  createConversation: (modelId?: string) =>
    request<ConversationSummary>("POST", "/conversations", { modelId }),
  conversation: (id: string) =>
    request<ConversationSummary & { activeRun: (RunSummary & { resumeSeq: number }) | null }>(
      "GET",
      `/conversations/${id}`,
    ),
  setConversationModel: (id: string, modelId: string) =>
    request<ConversationSummary>("PATCH", `/conversations/${id}`, { modelId }),
  setConversationContext: (
    id: string,
    input: { roleplay: RoleplayContext; visualContinuity: VisualContinuityContext },
  ) => request<ConversationSummary>("PATCH", `/conversations/${id}`, input),
  deleteConversation: (id: string) => request<void>("DELETE", `/conversations/${id}`),
  conversationTree: (id: string) => request<{ leafId: string | null; entries: Array<{ id: string; parentId: string | null; type: string; role?: string; preview: string; timestamp: string }> }>("GET", `/conversations/${id}/tree`),
  forkConversation: (id: string, entryId?: string) => request<ConversationSummary>("POST", `/conversations/${id}/fork`, { entryId }),
  messages: (id: string, after = -1) =>
    request<Paginated<StoredMessage>>("GET", `/conversations/${id}/messages?after=${after}`),
  /** `fromSeq` replays the conversation from that message: edit and regenerate. */
  startRun: (id: string, text: string, attachments: string[], modelId?: string, fromSeq?: number, imageReferences?: ImageAttachmentReference[]) =>
    request<{ runId: string; seq: number }>("POST", `/conversations/${id}/runs`, {
      text,
      attachments,
      modelId,
      fromSeq,
      imageReferences,
    }),
  continueRun: (id: string) => request<{ runId: string; seq: number }>("POST", `/conversations/${id}/continue`),
  compactConversation: (id: string) => request<{ runId: string; seq: number }>("POST", `/conversations/${id}/compact`),
  stopRun: (id: string) => request<void>("POST", `/conversations/${id}/stop`),
  steerRun: (id: string, text: string) => request<void>("POST", `/conversations/${id}/steer`, { text }),
  followUpRun: (id: string, text: string) => request<void>("POST", `/conversations/${id}/follow-up`, { text }),
  backgroundTasks: (id: string) => request<{ items: BackgroundTask[] }>("GET", `/conversations/${id}/background-tasks`),
  createBackgroundTask: (id: string, prompt: string, runAt = Date.now(), schedule?: TaskSchedule) =>
    request<BackgroundTask>("POST", `/conversations/${id}/background-tasks`, { prompt, runAt, ...schedule }),
  cancelBackgroundTask: (id: string) => request<BackgroundTask>("DELETE", `/background-tasks/${id}`),
  controlBackgroundTask: (id: string, action: "pause" | "resume") => request<BackgroundTask>("PATCH", `/background-tasks/${id}`, { action }),
  taskRuns: (id: string) => request<{ items: RunSummary[] }>("GET", `/background-tasks/${id}/runs`),

  /**
   * Questions still waiting on the reader. The stream carries them live, but a
   * client that was closed when one was asked has no event left to replay.
   */
  approvals: (conversationId: string) =>
    request<{ items: Approval[] }>("GET", `/conversations/${conversationId}/approvals`),
  decideApproval: (id: string, approved: boolean) => request<Approval>("POST", `/approvals/${id}`, { approved }),

  providers: () => request<Provider[]>("GET", "/providers"),
  createProvider: (input: ProviderInput) => request<Provider>("POST", "/providers", input),
  /** The key travels on its own route, so a patch never has to carry a secret. */
  updateProvider: (id: string, input: Partial<ProviderInput>) =>
    request<Provider>("PATCH", `/providers/${id}`, input),
  deleteProvider: (id: string) => request<void>("DELETE", `/providers/${id}`),
  setProviderKey: (id: string, value: string) => request<void>("PUT", `/providers/${id}/key`, { value }),
  remoteModels: (id: string) => request<{ items: DiscoveredModel[] }>("GET", `/providers/${id}/models`),

  models: () =>
    request<{
      items: ModelSpec[];
      defaultModelId: string;
      defaultImageModelId: string;
      defaultEditModelId: string;
      defaultVideoModelId: string;
    }>("GET", "/models"),
  createModel: (input: ModelInput) => request<ModelSpec>("POST", "/models", input),
  createModels: (providerId: string, models: ModelInput[]) =>
    request<BulkAddResult>("POST", "/models/bulk", { providerId, models }),
  updateModel: (id: string, input: Partial<ModelInput>) => request<ModelSpec>("PATCH", `/models/${id}`, input),
  deleteModel: (id: string) => request<void>("DELETE", `/models/${id}`),
  setDefaultModel: (modelId: string) => request<{ defaultModelId: string }>("PUT", "/models/default", { modelId }),
  setGenerationDefaults: (input: { imageModelId?: string; editModelId?: string; videoModelId?: string }) =>
    request<{ defaultImageModelId: string; defaultEditModelId: string; defaultVideoModelId: string }>(
      "PUT",
      "/models/generation-defaults",
      input,
    ),

  jobs: (query: { status?: JobStatus; conversationId?: string; limit?: number } = {}) =>
    request<{ items: JobRecord[] }>(
      "GET",
      `/jobs?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`,
    ),
  submitJob: (input: JobInput) => request<JobRecord>("POST", "/jobs", input),
  cancelJob: (id: string) => request<JobRecord>("POST", `/jobs/${id}/cancel`),

  capabilities: () => request<Capabilities>("GET", "/capabilities"),
  updateCapabilities: (patch: DeepPartial<Capabilities>) => request<Capabilities>("PATCH", "/capabilities", patch),
  setSecret: (name: string, value: string) => request<Capabilities>("PUT", `/capabilities/secrets/${name}`, { value }),
  clearSecret: (name: string) => request<Capabilities>("DELETE", `/capabilities/secrets/${name}`),

  prompts: () => request<PromptSettings>("GET", "/prompts"),
  promptDefaults: () => request<PromptDefaults>("GET", "/prompts/defaults"),
  savePrompts: (input: PromptSettings) => request<PromptSettings>("PUT", "/prompts", input),

  mcpServers: () => request<{ items: McpServer[]; status: McpStatus[] }>("GET", "/mcp/servers"),
  createMcpServer: (input: Partial<McpServer>) => request<McpServer>("POST", "/mcp/servers", input),
  updateMcpServer: (id: string, input: Partial<McpServer>) =>
    request<McpServer>("PATCH", `/mcp/servers/${id}`, input),
  deleteMcpServer: (id: string) => request<void>("DELETE", `/mcp/servers/${id}`),
  reconnectMcp: () => request<{ status: McpStatus[] }>("POST", "/mcp/reconnect"),

  files: async (query: { kind?: FileKind; source?: string; q?: string; limit?: number; offset?: number } = {}) => {
    // The HTTP endpoint caps a page at 200. A refreshed visible window may be
    // larger after loading more; retrieve each page instead of shrinking it.
    const limit = query.limit ?? 60, start = query.offset ?? 0;
    const page = (offset: number, size: number) => request<FileLibrary>("GET", `/files?${new URLSearchParams(
      Object.entries({ ...query, limit: size, offset }).map(([key, value]) => [key, String(value)]),
    )}`);
    const first = await page(start, Math.min(200, limit));
    const remaining = [];
    for (let offset = start + 200; offset < Math.min(start + limit, first.total); offset += 200) {
      remaining.push(page(offset, Math.min(200, start + limit - offset)));
    }
    return { ...first, items: [first, ...await Promise.all(remaining)].flatMap(result => result.items) };
  },
  createNote: (name: string, text: string) => request<FileRecord>("POST", "/files/notes", { name, text }),
  fileText: (id: string) => request<{ id: string; name: string; text: string }>("GET", `/files/${id}/text`),
  file: (id: string) => request<FileRecord>("GET", `/files/${id}`),
  saveFileText: (id: string, name: string, text: string) =>
    request<FileRecord>("PUT", `/files/${id}/text`, { name, text }),
  deleteFile: (id: string) => request<void>("DELETE", `/files/${id}`),
  reindexFile: (id: string) => request<FileRecord>("POST", `/files/${id}/reindex`),
  searchFiles: (query: string) =>
    request<{ mode: string; results: FileHit[]; index: { total: number; ready: number } }>("POST", "/files/search", {
      query,
    }),

  studioTools: () => request<{ items: StudioTool[]; enabled: boolean }>("GET", "/studio/tools"),
  gallery: (offset = 0, limit = 60) =>
    request<{ items: GeneratedAsset[]; total: number }>("GET", `/studio/gallery?offset=${offset}&limit=${limit}`),
  /** Where an asset came from. The `img_`/`vid_` prefix picks the route. */
  provenance: (assetId: string) =>
    request<Provenance>("GET", `/${assetId.startsWith("vid_") ? "videos" : "images"}/${assetId}/provenance`),

  memory: () => request<MemorySnapshot>("GET", "/memory"),
  setMemory: (key: string, value: string) => request<MemorySnapshot>("PUT", `/memory/${key}`, { value }),
  deleteMemory: (key: string) => request<MemorySnapshot>("DELETE", `/memory/${key}`),

  async upload(file: File, conversationId?: string) {
    const form = new FormData();
    form.set("file", file);
    if (conversationId) form.set("conversationId", conversationId);
    const response = await fetch("/v1/files", { method: "POST", headers: authHeaders(), body: form });
    adoptRotatedToken(response);
    const parsed = (await response.json()) as unknown;
    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string } }).error;
      throw new ApiError(response.status, error?.code ?? "error", error?.message ?? "Upload failed");
    }
    return parsed as FileRecord;
  },
};

export interface FileHit {
  chunkId: string;
  id: string;
  name: string;
  excerpt: string;
  page: number | null;
  chunk: number;
  semanticScore: number | null;
  matchType: string;
  retrievalScore: number;
}

export interface MemorySnapshot {
  items: MemoryRecord[];
  tokens: number;
  limit: number;
  charLimit: number;
  suggestedKeys: string[];
}

type DeepPartial<T> = { [K in keyof T]?: NonNullable<T[K]> extends object ? DeepPartial<NonNullable<T[K]>> : T[K] };

export type RunEventHandler = (type: string, data: Record<string, unknown>, seq: number) => void;

const TERMINAL_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled"]);
const SETTLED = new Set(["completed", "failed", "cancelled"]);
const JOB_SETTLED = new Set<JobStatus>(["succeeded", "failed", "cancelled"]);

const permanentFailure = (error: unknown) => error instanceof ApiError &&
  error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;

const retryableFailure = (error: unknown) => {
  if (permanentFailure(error)) throw error;
  return null;
};

/**
 * Reads a run's SSE stream. `EventSource` cannot send an Authorization header,
 * so the stream is consumed from `fetch` directly. Resolves true once a
 * terminal event has been delivered.
 */
async function streamRun(runId: string, after: number, onEvent: RunEventHandler, signal?: AbortSignal) {
  const response = await fetch(`/v1/runs/${runId}/events?after=${after}`, { headers: authHeaders(), signal });
  if (!response.ok || !response.body) throw new ApiError(response.status, "stream_failed", "Cannot open the stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const lines = frame.split("\n");
      const type = lines.find((line) => line.startsWith("event: "))?.slice(7);
      const raw = lines.find((line) => line.startsWith("data: "))?.slice(6);
      if (!type || !raw) continue;
      const payload = JSON.parse(raw) as { data?: Record<string, unknown>; seq?: number };
      onEvent(type, payload.data ?? {}, Number(payload.seq ?? 0));
      if (TERMINAL_EVENTS.has(type)) terminal = true;
    }
  }
  return terminal;
}

/**
 * Follows a run to completion across connection drops. A phone that locks the
 * screen suspends the stream without closing it, so the connection is also
 * recycled whenever the tab comes back to the foreground; the server's event
 * log is replayed from the last seq we saw, which makes that free.
 */
export async function followRun(runId: string, from: number, onEvent: RunEventHandler, signal: AbortSignal) {
  let cursor = from;
  let sseFailures = 0;
  const advance: RunEventHandler = (type, data, seq) => {
    if (seq && seq <= cursor) return;
    if (seq) cursor = Math.max(cursor, seq);
    onEvent(type, data, seq);
  };

  while (!signal.aborted) {
    const leg = new AbortController();
    const abortLeg = () => leg.abort();
    const onVisible = () => {
      if (document.visibilityState === "visible") leg.abort();
    };
    signal.addEventListener("abort", abortLeg, { once: true });
    document.addEventListener("visibilitychange", onVisible);

    let terminal = false;
    try {
      terminal = sseFailures >= 2
        ? await pollRun(runId, cursor, advance, leg.signal)
        : await streamRun(runId, cursor, advance, leg.signal);
      if (!terminal) sseFailures += 1;
    } catch (error) {
      if (permanentFailure(error)) throw error;
      if (!signal.aborted && !leg.signal.aborted) sseFailures += 1;
    } finally {
      signal.removeEventListener("abort", abortLeg);
      document.removeEventListener("visibilitychange", onVisible);
    }

    if (terminal || signal.aborted) return;

    // The stream ended without a verdict: either the run finished while we were
    // disconnected, or the connection dropped and should be re-established.
    const run = await request<{ status: string }>("GET", `/runs/${runId}`).catch(retryableFailure);
    if (run && SETTLED.has(run.status)) {
      const replayed = await pollRun(runId, cursor, advance, signal).catch(retryableFailure);
      if (replayed) return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(4000, 300 * 2 ** sseFailures)));
  }
}

/**
 * Follows one job to a verdict. Every frame carries the whole row, so a dropped
 * connection needs no cursor: reconnecting re-reads the job and continues. When
 * streaming is unavailable it falls back to polling the same row.
 */
export async function watchJob(id: string, onJob: (job: JobRecord) => void, signal: AbortSignal) {
  const settled = (job: JobRecord) => JOB_SETTLED.has(job.status);

  while (!signal.aborted) {
    try {
      const response = await fetch(`/v1/jobs/${id}/events`, { headers: authHeaders(), signal });
      if (!response.ok || !response.body) throw new ApiError(response.status, "stream_failed", "Cannot open the stream");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const raw = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
          if (!raw) continue;
          const job = JSON.parse(raw) as JobRecord;
          onJob(job);
          if (settled(job)) return job;
        }
      }
    } catch (error) {
      if (signal.aborted) return null;
      if (permanentFailure(error)) throw error;
    }
    // Either the stream dropped or the server closed it without a verdict; the
    // row itself is authoritative either way.
    if (signal.aborted) return null;
    const job = await request<JobRecord>("GET", `/jobs/${id}`).catch(retryableFailure);
    if (job) {
      onJob(job);
      if (settled(job)) return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  return null;
}

/** Long-poll fallback for networks that buffer or cut streaming responses. */
async function pollRun(runId: string, after: number, onEvent: RunEventHandler, signal: AbortSignal) {
  let cursor = after;
  for (;;) {
    if (signal.aborted) return false;
    const response = await fetch(`/v1/runs/${runId}/events?mode=poll&after=${cursor}`, {
      headers: authHeaders(),
      signal,
    });
    if (!response.ok) throw new ApiError(response.status, "poll_failed", "Cannot poll the run");
    adoptRotatedToken(response);
    const payload = (await response.json()) as {
      events: Array<{ seq: number; type: string; data: Record<string, unknown> }>;
      done: boolean;
    };
    for (const event of payload.events) {
      cursor = Math.max(cursor, event.seq);
      onEvent(event.type, event.data ?? {}, event.seq);
      if (TERMINAL_EVENTS.has(event.type)) return true;
    }
    if (payload.done) return false;
  }
}
