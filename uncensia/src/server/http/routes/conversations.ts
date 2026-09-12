import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { StoredEvent } from "@shared/types.ts";
import { IMAGE_REFERENCE_ROLES, type ImageAttachmentReference } from "@shared/types.ts";
import type { RoleplayContext, VisualContinuityContext } from "@shared/types.ts";
import { rewindConversation, projectTranscript } from "../../agent/projection.ts";
import { searchConversations } from "../../agent/search.ts";
import type { Services } from "../../services.ts";
import { readJson } from "../body.ts";
import { fail, failFromError } from "../errors.ts";
import { roleplayInputError } from "@shared/roleplay.ts";
import { taskSchedule, taskStartTime } from "@shared/tasks.ts";
import { getProject } from "../../projects.ts";
import type { TaskSchedule } from "@shared/types.ts";

const HEARTBEAT_MS = 15_000;
const POLL_TIMEOUT_MS = 25_000;
const TERMINAL = new Set(["run.completed", "run.failed", "run.cancelled"]);

/**
 * Keyed replay so a phone retrying a dropped POST cannot start two runs. A
 * retry follows within seconds, so the window only has to outlive a reconnect;
 * the cap keeps a long-lived server from holding every key it has ever seen.
 */
const IDEMPOTENCY_LIMIT = 512;
const idempotency = new Map<string, { runId: string; seq: number }>();

function rememberIdempotency(key: string, response: { runId: string; seq: number }) {
  idempotency.set(key, response);
  while (idempotency.size > IDEMPOTENCY_LIMIT) {
    const oldest = idempotency.keys().next();
    if (oldest.done) break;
    idempotency.delete(oldest.value);
  }
}

export function conversationRoutes(services: Services) {
  const app = new Hono();
  const { store, config, runtime, bus } = services;

  app.get("/conversations", (context) => {
    const limit = Math.min(200, Math.max(1, Number(context.req.query("limit") ?? 50)));
    const cursor = context.req.query("cursor");
    const items = store.listConversations(limit, cursor ? Number(cursor) : undefined);
    const nextCursor = items.length === limit ? String(items.at(-1)!.updatedAt) : null;
    return context.json({ items, nextCursor });
  });

  app.post("/conversations", async (context) => {
    const body = await readJson<{ modelId: string; title: string; projectId: string | null }>(context);
    if (body.projectId !== undefined && body.projectId !== null && (typeof body.projectId !== "string" || !getProject(store,body.projectId))) return fail(context,400,"invalid_project","Choose an existing project");
    const wanted = typeof body.modelId === "string" ? body.modelId : "";
    const spec = wanted ? store.getModel(wanted) : undefined;
    if (wanted && (!spec?.enabled || !spec.configured || spec.kind !== "chat")) return fail(context, 422, "invalid_model", "The requested chat model is unavailable");
    const modelId = wanted || config.defaultModelId();
    if (!modelId) return fail(context, 422, "no_model", "Configure a model before starting a conversation");
    return context.json(store.createConversation(modelId, body.title || "New conversation", body.projectId), 201);
  });

  /**
   * Registered before `/conversations/:id`, which would otherwise claim the
   * literal path and read "search" as a conversation id.
   */
  app.get("/conversations/search", async (context) => {
    const query = (context.req.query("q") ?? "").trim();
    if (!query) return context.json({ items: [] });
    const limit = Number(context.req.query("limit") ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return fail(context, 400, "invalid", "limit must be an integer from 1 to 50");
    const items = await searchConversations(store, query, limit, context.req.raw.signal);
    return context.json({ items });
  });

  app.get("/conversations/:id", (context) => {
    const conversation = store.getConversation(context.req.param("id"));
    if (!conversation) return fail(context, 404, "not_found", "Conversation not found");
    const run = store.activeRun(conversation.id);
    return context.json({
      ...conversation,
      // Everything up to the last persisted message is already in the
      // transcript, so a reattaching client only replays from there.
      activeRun: run ? { ...run, resumeSeq: store.lastPersistedEventSeq(run.id) } : null,
    });
  });

  app.patch("/conversations/:id", async (context) => {
    const id = context.req.param("id");
    if (!store.getConversation(id)) return fail(context, 404, "not_found", "Conversation not found");
    const body = await readJson<{
      title: string;
      projectId: string | null;
      modelId: string;
      roleplay: RoleplayContext;
      visualContinuity: VisualContinuityContext;
    }>(context);
    if (body.projectId !== undefined) {
      if (body.projectId !== store.getConversation(id)?.projectId && (runtime.isActive(id) || store.activeRun(id))) return fail(context,409,"run_active","Stop the active run before moving this conversation");
      if (body.projectId !== null && (typeof body.projectId !== "string" || !getProject(store,body.projectId))) return fail(context,400,"invalid_project","Choose an existing project");
    }
    if (body.roleplay !== undefined) {
      const error = roleplayInputError(body.roleplay);
      if (error) return fail(context, 400, "invalid_roleplay", error);
    }
    if (body.visualContinuity !== undefined) {
      try {
        const visual = store.parseVisualContinuity(body.visualContinuity);
        const imageIds = [...visual.references.map(reference => reference.imageId), ...(visual.lastImageId ? [visual.lastImageId] : [])];
        for (const imageId of imageIds) {
          if (!store.getImageAsset(imageId)) return fail(context, 400, "invalid_visual_continuity", `Reference ${imageId} no longer exists; remove or replace it`);
        }
      } catch (error) { return failFromError(context, error); }
    }
    if (body.modelId) {
      const spec = store.getModel(body.modelId);
      if (!spec?.enabled || !spec.configured || spec.kind !== "chat") return fail(context, 422, "invalid_model", "The requested chat model is unavailable");
      store.setConversationModel(id, body.modelId);
    }
    if (typeof body.title === "string" && body.title.trim()) store.setConversationTitle(id, body.title.trim());
    if (body.projectId !== undefined && body.projectId !== store.getConversation(id)?.projectId) store.setConversationProject(id,body.projectId);
    if (body.roleplay !== undefined) store.setConversationRoleplay(id, body.roleplay);
    if (body.visualContinuity !== undefined) {
      store.setConversationVisualContinuity(id, body.visualContinuity);
    }
    return context.json(store.getConversation(id));
  });

  app.delete("/conversations/:id", async (context) => {
    const id = context.req.param("id");
    if (runtime.isActive(id)) return fail(context, 409, "run_active", "Stop the active run first");
    store.deleteConversation(id);
    // The transcript's source of truth lives in the session store, so deleting
    // the rows alone would leave the tree behind to grow forever.
    await services.sessions.forget(id);
    return context.body(null, 204);
  });

  /**
   * Two different questions share this path because clients ask both about the
   * same resource. `after` is "what changed since I last looked" and returns
   * everything newer, which is how the web client tops up a conversation it is
   * already showing. `limit` (with `before` to walk further) is "give me the
   * end of this transcript", which is how a client opens one it has never seen.
   */
  app.get("/conversations/:id/messages", (context) => {
    const id = context.req.param("id");
    if (!store.getConversation(id)) return fail(context, 404, "not_found", "Conversation not found");

    const limit = context.req.query("limit");
    const before = context.req.query("before");
    if (limit === undefined && before === undefined) {
      const after = Number(context.req.query("after") ?? -1);
      return context.json({ items: store.storedMessages(id, after), nextCursor: null });
    }

    const size = Number(limit ?? 50);
    if (!Number.isFinite(size) || size <= 0) return fail(context, 400, "invalid", "limit must be a positive number");
    const cursor = before === undefined ? null : Number(before);
    if (cursor !== null && !Number.isFinite(cursor)) return fail(context, 400, "invalid", "before must be a sequence");
    return context.json(store.messagePage(id, cursor, size));
  });

  app.post("/conversations/:id/runs", async (context) => {
    const conversationId = context.req.param("id");
    const conversation = store.getConversation(conversationId);
    if (!conversation) return fail(context, 404, "not_found", "Conversation not found");

    const key = context.req.header("idempotency-key");
    if (key && idempotency.has(key)) return context.json(idempotency.get(key), 202);

    const body = await readJson<{
      text: string;
      attachments: string[];
      imageReferences: ImageAttachmentReference[];
      modelId: string;
      /** Edit and regenerate replay a turn: drop it, then send this text in its place. */
      fromSeq: number;
    }>(context);
    const text = (body.text ?? "").trim();
    if (!text) return fail(context, 400, "empty_message", "Message text is required");
    if (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.some((id) => typeof id !== "string") || new Set(body.attachments).size !== body.attachments.length)) return fail(context, 400, "invalid_attachments", "Attachments must be unique file IDs");
    for (const id of body.attachments ?? []) if (!store.getFile(id)) return fail(context, 422, "missing_attachment", `Attachment ${id} no longer exists`);
    if (body.imageReferences !== undefined) {
      const refs = body.imageReferences;
      if (!Array.isArray(refs) || refs.some((ref) => !ref || typeof ref.imageId !== "string" || !Object.hasOwn(IMAGE_REFERENCE_ROLES, ref.role) || !body.attachments?.includes(ref.imageId) || !store.getFile(ref.imageId)?.mime.startsWith("image/")) || new Set(refs.map((ref) => ref.imageId)).size !== refs.length || refs.filter((ref) => ref.role === "base").length > 1) return fail(context, 400, "invalid_image_references", "Each reference must name an attached image and a supported role; choose at most one base");
    }
    if (runtime.isActive(conversationId)) {
      return fail(context, 409, "run_active", "This conversation already has an active run");
    }

    const asked = body.modelId ? store.getModel(body.modelId) : undefined;
    if (body.modelId && (!asked?.enabled || !asked.configured || asked.kind !== "chat")) return fail(context, 422, "invalid_model", "The requested chat model is unavailable");
    const modelId = body.modelId || conversation.modelId;
    try {
      services.registry.resolve(modelId);
    } catch (error) {
      return failFromError(context, error);
    }
    if (modelId !== conversation.modelId) store.setConversationModel(conversationId, modelId);

    // Only after the model resolves, so a rejected run leaves history intact.
    const fromSeq = body.fromSeq;
    if (typeof fromSeq === "number" && Number.isInteger(fromSeq) && fromSeq >= 0) {
      await rewindConversation(store, services.sessions, conversationId, fromSeq);
    }

    const run = store.createRun(conversationId, modelId);
    const seq = Number(store.db.get<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM events")?.seq ?? 0);
    const response = { runId: run.id, seq };
    if (key) rememberIdempotency(key, response);

    void runtime
      .start(run.id, conversationId, { message: text, modelId, attachments: body.attachments, imageReferences: body.imageReferences })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        store.setRunStatus(run.id, "failed", message);
        bus.publish(store.addEvent(run.id, conversationId, "run.failed", { message }));
      });

    return context.json(response, 202);
  });

  /**
   * Picks the answer back up where it stopped. A stopped or finished turn
   * leaves an assistant message last, which the agent loop cannot resume from,
   * so the nudge below is sent as an ordinary user message and shows up in the
   * transcript — the same thing the reader would have typed. Only a run that
   * died between a tool result and the next model call resumes silently.
   */
  app.post("/conversations/:id/continue", (context) => {
    const conversationId = context.req.param("id");
    const conversation = store.getConversation(conversationId);
    if (!conversation) return fail(context, 404, "not_found", "Conversation not found");
    if (runtime.isActive(conversationId)) {
      return fail(context, 409, "run_active", "This conversation already has an active run");
    }
    if (!store.messageCount(conversationId)) {
      return fail(context, 400, "empty_conversation", "Nothing to continue");
    }
    try {
      services.registry.resolve(conversation.modelId);
    } catch (error) {
      return failFromError(context, error);
    }

    const run = store.createRun(conversationId, conversation.modelId);
    const seq = Number(store.db.get<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM events")?.seq ?? 0);

    void runtime
      .start(run.id, conversationId, {
        message: "继续，接着上面写，不要重复。",
        modelId: conversation.modelId,
        continue: true,
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        store.setRunStatus(run.id, "failed", message);
        bus.publish(store.addEvent(run.id, conversationId, "run.failed", { message }));
      });

    return context.json({ runId: run.id, seq }, 202);
  });

  app.post("/conversations/:id/stop", (context) => {
    const stopped = runtime.stop(context.req.param("id"));
    if (!stopped) return fail(context, 409, "no_active_run", "Nothing is running");
    return context.body(null, 204);
  });

  app.post("/conversations/:id/steer", async (context) => {
    const body = await readJson<{ text: string }>(context);
    const text = (body.text ?? "").trim();
    if (!text) return fail(context, 400, "empty_message", "Steering text is required");
    if (!(await runtime.steer(context.req.param("id"), text))) {
      return fail(context, 409, "no_active_run", "Nothing is running");
    }
    return context.body(null, 204);
  });

  app.post("/conversations/:id/compact", (context) => {
    const id = context.req.param("id");
    const conversation = store.getConversation(id);
    if (!conversation) return fail(context, 404, "not_found", "Conversation not found");
    if (runtime.isActive(id)) return fail(context, 409, "run_active", "Stop the active run first");
    if (!store.messageCount(id)) return fail(context, 400, "empty_conversation", "Nothing to compact");
    services.registry.resolve(conversation.modelId);
    const run = store.createRun(id, conversation.modelId);
    const seq = Number(store.db.get<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM events")?.seq ?? 0);
    void runtime.start(run.id, id, { message: "整理上下文", compact: true }).catch((error) => {
      store.setRunStatus(run.id, "failed", String(error));
      bus.publish(store.addEvent(run.id, id, "run.failed", { message: String(error) }));
    });
    return context.json({ runId: run.id, seq }, 202);
  });

  app.get("/conversations/:id/export", async (context) => {
    const id = context.req.param("id");
    if (!store.getConversation(id)) return fail(context, 404, "not_found", "Conversation not found");
    const session = await services.sessions.session(id);
    context.header("Content-Disposition", `attachment; filename="${id}.jsonl"`);
    context.header("Content-Type", "application/x-ndjson; charset=utf-8");
    return context.body([session.getHeader(), ...session.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  });

  app.get("/conversations/:id/tree", async (context) => {
    const id = context.req.param("id");
    if (!store.getConversation(id)) return fail(context, 404, "not_found", "Conversation not found");
    const session = await services.sessions.session(id);
    return context.json({ leafId: session.getLeafId(), entries: session.getEntries().map((entry) => {
      const message = entry.type === "message" ? entry.message as { role: string; content?: unknown } : undefined;
      const content = message?.content;
      const preview = typeof content === "string" ? content : Array.isArray(content) ? content.filter((part) => part?.type === "text").map((part) => String(part.text)).join("\n") : entry.type === "compaction" || entry.type === "branch_summary" ? entry.summary : "";
      return { id: entry.id, parentId: entry.parentId, type: entry.type, timestamp: entry.timestamp, role: message?.role, preview: preview.slice(0, 240) };
    }) });
  });

  app.post("/conversations/:id/fork", async (context) => {
    const id = context.req.param("id");
    const source = store.getConversation(id);
    if (!source) return fail(context, 404, "not_found", "Conversation not found");
    if (runtime.isActive(id)) return fail(context, 409, "run_active", "Stop the active run first");
    const body = await readJson<{ entryId?: string }>(context);
    const session = await services.sessions.session(id);
    if (body.entryId && !session.getEntry(body.entryId)) return fail(context, 400, "invalid_entry", "Unknown session entry");
    const target = store.createConversation(source.modelId, `${source.title} · 分支`, source.projectId);
    try {
      await services.sessions.fork(id, target.id, body.entryId);
      store.setConversationRoleplay(target.id, source.roleplay);
      store.setConversationVisualContinuity(target.id, source.visualContinuity);
      await projectTranscript(store, services.sessions, target.id);
      return context.json(store.getConversation(target.id), 201);
    } catch (error) { store.deleteConversation(target.id); await services.sessions.forget(target.id); throw error; }
  });

  app.post("/conversations/:id/follow-up", async (context) => {
    const body = await readJson<{ text: string }>(context);
    const text = (body.text ?? "").trim();
    if (!text) return fail(context, 400, "empty_message", "Follow-up text is required");
    if (!(await runtime.followUp(context.req.param("id"), text))) {
      return fail(context, 409, "no_active_run", "Nothing is running");
    }
    return context.body(null, 204);
  });

  app.get("/conversations/:id/background-tasks", (context) => {
    const id = context.req.param("id");
    if (!store.getConversation(id)) return fail(context, 404, "not_found", "Conversation not found");
    return context.json({ items: store.listBackgroundTasks(id) });
  });

  app.post("/conversations/:id/background-tasks", async (context) => {
    const conversationId = context.req.param("id");
    const conversation = store.getConversation(conversationId);
    if (!conversation) return fail(context, 404, "not_found", "Conversation not found");
    const body = await readJson<Partial<TaskSchedule> & { prompt: string; modelId?: string; runAt?: number }>(context);
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return fail(context, 400, "empty_message", "Background task prompt is required");
    if (prompt.length > 12_000) return fail(context, 400, "invalid", "Background task prompt is too long");
    const modelId = body.modelId || conversation.modelId;
    try {
      services.registry.resolve(modelId);
    } catch (error) {
      return failFromError(context, error);
    }
    let schedule: TaskSchedule;
    let runAt: number;
    try { schedule = taskSchedule(body); runAt = taskStartTime(body.runAt); }
    catch (error) { return fail(context, 400, "invalid", String(error instanceof Error ? error.message : error)); }
    const task = store.createBackgroundTask({
      conversationId,
      prompt,
      modelId,
      runAt,
      schedule,
    });
    services.background.wake();
    return context.json(task, 202);
  });

  app.delete("/background-tasks/:id", (context) => {
    const task = store.getBackgroundTask(context.req.param("id"));
    if (!task) return fail(context, 404, "not_found", "Background task not found");
    const cancelled = store.cancelBackgroundTask(task.id);
    if (task.runId && cancelled?.status === "cancelled") runtime.stop(task.conversationId, task.runId);
    return context.json(cancelled);
  });

  app.patch("/background-tasks/:id", async context => {
    const task = store.getBackgroundTask(context.req.param("id"));
    if (!task) return fail(context, 404, "not_found", "Task not found");
    const body = await readJson<{ action: "pause" | "resume" }>(context);
    if (body.action !== "pause" && body.action !== "resume") return fail(context, 400, "invalid", "Invalid task action");
    try {
      const updated = store.controlBackgroundTask(task.id, body.action);
      services.background.wake();
      return context.json(updated);
    } catch (error) { return fail(context, 409, "task_state", error instanceof Error ? error.message : String(error)); }
  });

  app.get("/background-tasks/:id/runs", context => {
    const task = store.getBackgroundTask(context.req.param("id"));
    if (!task) return fail(context, 404, "not_found", "Task not found");
    return context.json({ items: store.taskRuns(task.id) });
  });

  app.get("/runs/:id", (context) => {
    const run = store.getRun(context.req.param("id"));
    if (!run) return fail(context, 404, "not_found", "Run not found");
    return context.json(run);
  });

  /**
   * What a client asks for after a refresh or a reconnect. The stream carries
   * the same information live, but a client that was away while the question
   * was asked has no event to replay it from.
   */
  app.get("/conversations/:id/approvals", (context) => {
    const id = context.req.param("id");
    if (!store.getConversation(id)) return fail(context, 404, "not_found", "Conversation not found");
    return context.json({
      items: context.req.query("status") === "all" ? store.conversationApprovals(id) : store.pendingApprovals(id),
    });
  });

  /** Every question waiting anywhere, so a cold app start can surface them. */
  app.get("/approvals", (context) => context.json({ items: store.pendingApprovals() }));

  /**
   * The only way a destructive coding call is ever authorised. Deciding twice
   * is not an error: the second caller is told the settled state, which is what
   * makes a double-tap and a retried request both harmless.
   */
  app.post("/approvals/:id", async (context) => {
    const id = context.req.param("id");
    const existing = store.getApproval(id);
    if (!existing) return fail(context, 404, "not_found", "Approval not found");

    const body = await readJson<{ approved: boolean }>(context);
    if (typeof body.approved !== "boolean") {
      return fail(context, 400, "invalid", "approved must be true or false");
    }

    // The row is the decision; notifying only wakes the parked tool call early
    // instead of letting it discover the change on its next read.
    const settled = store.decideApproval(id, body.approved ? "approved" : "rejected");
    runtime.approvals.notify(id);
    return context.json(settled ?? store.getApproval(id));
  });

  app.get("/runs/:id/events", async (context) => {
    const runId = context.req.param("id");
    const run = store.getRun(runId);
    if (!run) return fail(context, 404, "not_found", "Run not found");
    const after = Number(context.req.header("last-event-id") ?? context.req.query("after") ?? 0);

    if (context.req.query("mode") === "poll") {
      const events = await pollEvents(services, runId, after);
      return context.json({
        events,
        done: isSettled(store.getRun(runId)?.status) && !events.some((event) => !TERMINAL.has(event.type)),
      });
    }

    return streamSSE(context, async (stream) => {
      let cursor = after;
      let closed = false;
      const queue: StoredEvent[] = [];
      let wake: (() => void) | undefined;

      const push = (event: StoredEvent) => {
        if (event.runId !== runId || event.seq <= cursor) return;
        queue.push(event);
        wake?.();
      };
      const unsubscribe = bus.subscribe(run.conversationId, push);
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
        wake?.();
      });

      try {
        for (const event of store.eventsSince(runId, cursor)) queue.push(event);
        while (!closed) {
          while (queue.length) {
            const event = queue.shift()!;
            if (event.seq <= cursor) continue;
            cursor = event.seq;
            await stream.writeSSE({ id: String(event.seq), event: event.type, data: JSON.stringify(event) });
            if (TERMINAL.has(event.type)) return;
          }
          const status = store.getRun(runId)?.status;
          if (isSettled(status) && !store.eventsSince(runId, cursor).length) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, HEARTBEAT_MS);
          });
          wake = undefined;
          if (!closed && !queue.length) await stream.writeSSE({ data: "", event: "heartbeat" });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return app;
}

const isSettled = (status?: string) =>
  status === "completed" || status === "failed" || status === "cancelled";

/** Long-poll fallback for clients that cannot hold an SSE connection open. */
async function pollEvents(services: Services, runId: string, after: number) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const events = services.store.eventsSince(runId, after);
    if (events.length) return events;
    if (isSettled(services.store.getRun(runId)?.status)) return [];
    if (Date.now() >= deadline) return [];
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}
