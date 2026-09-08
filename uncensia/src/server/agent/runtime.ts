import { type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { createReadTool, parseSkillBlock } from "@earendil-works/pi-coding-agent";
import fs from "node:fs/promises";
import path from "node:path";
import type { ImageAttachmentReference } from "@shared/types.ts";
import { SECRET, type Config } from "../config.ts";
import type { SecretVault } from "../crypto/secrets.ts";
import type { EventBus } from "../events/bus.ts";
import type { Jobs } from "../generation/jobs.ts";
import { encodeForModel, registerGeneratedImage, saveImageBytes } from "../images.ts";
import type { McpPool } from "../mcp/pool.ts";
import { ApprovalRegistry, describeRisk, rejectionMessage } from "./approvals.ts";
import { describeModelError } from "./errors.ts";
import { applyModelParameters } from "../models/params.ts";
import type { ModelRegistry } from "../models/registry.ts";
import {
  buildModelContext,
  composeStaticPrompt,
  countTokens,
  renderPromptIdentity,
  resolveModelSystemPrompt,
  type AttachedDocument,
} from "../prompts/context.ts";
import type { Retrieval } from "../rag/retrieval.ts";
import type { Store } from "../store/store.ts";
import { codingTools } from "../tools/coding.ts";
import { workspaceFileTools } from "../tools/workspace-files.ts";
import { fileSearchTool } from "../tools/file-search.ts";
import { generationTools, uploadedImageContext } from "../tools/generation.ts";
import { generationStatusTool } from "../tools/generation-status.ts";
import { memoryTools } from "../tools/memory.ts";
import { taskTools } from "../tools/tasks.ts";
import { learningTools } from "../tools/learning.ts";
import {
  omitSkillProceduresForCompaction,
  enrichDiscoveredSkills,
  transformExpandedSkillMessages,
  withSkillContext,
  type UncensiaSkill,
} from "../tools/skills.ts";
import { viewImageTool } from "../tools/vision.ts";
import { webSearchTool } from "../tools/web-search.ts";
import { createPiLoop, HarnessHostError, type AgentLoop, type LoopFactory } from "./loop.ts";
import { stringifyToolEnums } from "./tool-schema.ts";
import {
  boundToolResults,
  compactToolText,
  describeRefs,
  imageRef,
  persistMessage,
  withRuntimeContext,
  transportSafe,
  videoRef,
  withAppendedRefs,
  type FileRef,
  type ImageRef,
  type VideoRef,
} from "./messages.ts";
import { resolveGeneration } from "./defaults.ts";
import { type Sessions } from "./sessions.ts";
import { fallbackTitle, generateTitle } from "./title.ts";

/**
 * How long a settled run keeps its text deltas. Polling clients read in bursts,
 * so deltas must outlive the run itself or a short answer can finish and be
 * pruned between two polls.
 */
const DELTA_RETENTION_MS = 120_000;

export interface StartInput {
  message: string;
  /** Set by the scheduler only; never accepted from a chat HTTP request. */
  taskId?: string;
  modelId?: string;
  attachments?: string[];
  imageReferences?: ImageAttachmentReference[];
  compact?: boolean;
  /**
   * Continue an interrupted transcript with the loop's persisted continuation
   * prompt. After a settled assistant message, use `message` as the nudge.
   */
  continue?: boolean;
}

/**
 * How much of an attachment is handed to the model outright.
 *
 * Generous enough that an ordinary document — a contract, a report, a chapter —
 * arrives whole, and bounded because a turn's budget is shared with the history
 * and the tools. Past the ceiling the head is sent and the rest stays reachable
 * through `file_search` scoped to that file, which is a worse answer than the
 * whole document and a much better one than a library-wide search for text the
 * reader was holding out.
 */
const ATTACHMENT_TOKENS_PER_FILE = 8_000;
const ATTACHMENT_TOKENS_TOTAL = 20_000;

/**
 * The text of each attached document, from the chunks the upload already wrote.
 * Reading the chunks rather than re-extracting means PDFs and DOCX files need no
 * second parse here, and a file with no chunks — an unextractable format, or one
 * whose indexing failed — contributes nothing rather than an empty heading.
 */
function readAttachedDocuments(store: Store, documents: Array<{ id: string; name: string }>): AttachedDocument[] {
  const attached: AttachedDocument[] = [];
  let spent = 0;
  for (const document of documents) {
    if (spent >= ATTACHMENT_TOKENS_TOTAL) break;
    const chunks = store.chunks(document.id);
    if (!chunks.length) continue;
    const budget = Math.min(ATTACHMENT_TOKENS_PER_FILE, ATTACHMENT_TOKENS_TOTAL - spent);
    const kept: string[] = [];
    let used = 0;
    let truncated = false;
    for (const chunk of chunks) {
      const cost = countTokens(chunk.text);
      if (used + cost > budget) {
        truncated = true;
        break;
      }
      kept.push(chunk.text);
      used += cost;
    }
    // A single chunk over the per-file budget would otherwise send nothing at
    // all, which reads to the model as an empty document rather than a long one.
    if (!kept.length) {
      kept.push(chunks[0]!.text);
      used = countTokens(chunks[0]!.text);
      truncated = chunks.length > 1;
    }
    spent += used;
    attached.push({ id: document.id, name: document.name, text: kept.join("\n\n"), truncated });
  }
  return attached;
}

/**
 * A user/tool-result tail can be continued with the loop's standard nudge.
 * The Pi adapter writes that nudge as a user message so later replay retains it.
 */
function canResume(history: AgentMessage[]) {
  const role = (history.at(-1) as { role?: string } | undefined)?.role;
  return role === "user" || role === "toolResult";
}

interface ActiveRun {
  /**
   * Absent while the run is still preparing. Summarizing a long conversation is
   * itself a model call, so a run has to be stoppable before its loop exists.
   */
  agent?: AgentLoop;
  runId: string;
  /** `agent.abort()` unwinds cleanly, so the intent has to be recorded here. */
  aborted: boolean;
  /**
   * Signals work that outlives a single tool call. `agent.abort()` unwinds the
   * loop but cannot reach a preflight gate parked on a person's decision, which
   * would otherwise keep a stopped run alive for its full approval timeout.
   */
  cancel: AbortController;
}

export class Runtime {
  private readonly active = new Map<string, ActiveRun>();
  private readonly pending = new Set<Promise<void>>();
  private closing = false;
  /** Wakes a parked preflight the moment its decision is recorded. */
  readonly approvals = new ApprovalRegistry();

  constructor(
    private readonly store: Store,
    private readonly config: Config,
    private readonly vault: SecretVault,
    private readonly registry: ModelRegistry,
    private readonly retrieval: Retrieval,
    private readonly mcp: McpPool,
    private readonly bus: EventBus,
    private readonly sessions: Sessions,
    private readonly jobs: Jobs,
    private readonly createLoop: LoopFactory = createPiLoop,
  ) {}

  isActive(conversationId: string) {
    return this.active.has(conversationId);
  }

  activeCount() {
    return this.active.size;
  }

  private emit(runId: string, conversationId: string, type: string, data: unknown) {
    this.bus.publish(this.store.addEvent(runId, conversationId, type, data));
  }

  start(runId: string, conversationId: string, input: StartInput): Promise<void> {
    if (this.closing) return Promise.reject(new HarnessHostError("Uncensia runtime is shutting down; no new run was started."));
    if (this.active.has(conversationId)) return Promise.reject(new Error("Conversation already has an active run"));
    // Reserve before attachment/skill loading. Shutdown must also drain runs
    // that have not constructed their SDK session yet.
    const entry: ActiveRun = { runId, aborted: false, cancel: new AbortController() };
    this.active.set(conversationId, entry);
    const task = this.execute(runId, conversationId, input, entry).catch((error: unknown) => {
      // Preparation failures happen before execute's session-lifecycle try.
      const message = error instanceof Error ? error.message : String(error);
      const status = entry.aborted ? "cancelled" : "failed";
      this.store.setRunStatus(runId, status, message);
      this.emit(runId, conversationId, `run.${status}`, { message });
    }).finally(() => {
      this.active.delete(conversationId);
      entry.cancel.abort();
      this.pending.delete(task);
    });
    this.pending.add(task);
    return task;
  }

  async close() {
    this.closing = true;
    for (const id of this.active.keys()) this.stop(id);
    await Promise.all([...this.pending]);
  }

  private async execute(runId: string, conversationId: string, input: StartInput, entry: ActiveRun) {
    const conversation = this.store.getConversation(conversationId);
    if (!conversation) throw new Error("Conversation not found");
    const { cancel } = entry;

    const { spec, provider, model } = this.registry.resolve(input.modelId ?? conversation.modelId);
    const resolved = resolveGeneration(this.store, this.config);
    const capabilities = resolved.capabilities;
    const prompts = resolved.prompts;

    const uploadImageRefs: ImageRef[] = [];
    const media: Array<{ type: "image"; data: string; mimeType: string }> = [];
    const attachmentDocuments: Array<{ id: string; name: string }> = [];
    /**
     * Documents attached to this turn, as refs to append to the message that
     * carried them. A picture becomes part of the message on its own — the
     * base64 goes to the model and `persistMessage` swaps in the ref — but a
     * document has no such part, and naming it only in the system prompt's
     * searchable list left the turn itself with no record of the attachment: the
     * transcript could not show it, and editing the turn could not re-send it.
     */
    const uploadFileRefs: FileRef[] = [];
    for (const fileId of input.attachments ?? []) {
      const file = this.store.getFile(fileId);
      if (!file) continue;
      if (file.mime.startsWith("image/")) {
        const encoded = await encodeForModel(file.id, file.diskPath, file.mime);
        if (!encoded) continue;
        media.push({ type: "image", ...encoded });
        uploadImageRefs.push({
          type: "image_ref",
          image_id: file.id,
          reference_role: input.imageReferences?.find((ref) => ref.imageId === file.id)?.role,
          mime_type: file.mime,
          width: file.width,
          height: file.height,
          parent_image_ids: [],
          provider: file.source,
          model: null,
        });
      } else {
        attachmentDocuments.push({ id: file.id, name: file.name });
        uploadFileRefs.push({
          type: "file_ref",
          file_id: file.id,
          name: file.name,
          mime_type: file.mime,
          bytes: file.bytes,
        });
      }
    }

    const attachedText = readAttachedDocuments(this.store, attachmentDocuments);

    const staticPrompt = renderPromptIdentity(
      resolveModelSystemPrompt(composeStaticPrompt(prompts.globalPrompt, prompts.toolPrompt), spec.systemPrompt),
      spec.name,
      provider.name,
    );

    // A document whose text is already in the prompt is left out of the list of
    // things to search. Listing it there is an instruction, and the model obeyed
    // it: told "use file_search to find information within probe.md (just
    // attached by user)", it searched — library-wide — and summarised a
    // different file, with the attachment's own text sitting further down the
    // same prompt. What stays on the list is an attachment too large to inline,
    // which genuinely does have to be reached by searching.
    const inlined = new Set(attachedText.map((document) => document.id));
    const attachedIds = new Set(attachmentDocuments.map((file) => file.id));
    const searchableFiles = [
      ...attachmentDocuments.filter((file) => !inlined.has(file.id)).map((file) => ({ ...file, currentRequest: true })),
      ...this.store.searchableFiles().filter((file) => !attachedIds.has(file.id)).map((file) => ({
        ...file,
        currentRequest: false,
      })),
    ];

    // Populated from Pi's effective resources, not a second directory scan.
    let skills: UncensiaSkill[] = [];
    const visualContinuity = conversation.visualContinuity;
    const skillContext = { roleplay: conversation.roleplay, visualContinuity };

    const contextInput = {
      staticPrompt,
      memories: this.store.listMemories(),
      searchableFiles,
      attachments: attachedText,
      memoryEnabled: capabilities.memory.enabled,
      memoryTokenLimit: capabilities.memory.tokenLimit,
      filesEnabled: capabilities.files.enabled && capabilities.files.searchEnabled,
      webEnabled: capabilities.web.enabled,
    };
    const { systemPrompt } = buildModelContext(contextInput);

    const uploads = uploadImageRefs.map((image) => ({
      id: image.image_id,
      mime: image.mime_type,
      width: image.width ?? null,
      height: image.height ?? null,
    }));

    // Server order is stable, so tool order is too, which is what keeps the
    // provider's prompt cache warm across turns.
    const mcpTools = this.mcp.currentTools();

    const tools: AgentTool[] = [];
    if (capabilities.files.enabled && capabilities.files.searchEnabled) {
      tools.push(fileSearchTool(this.retrieval, capabilities.files.mode));
    }
    if (capabilities.web.enabled) {
      tools.push(
        webSearchTool({
          getApiKey: () => this.vault.get(SECRET.tavily),
          provider: capabilities.web.provider,
          baseUrl: capabilities.web.baseUrl,
        }),
      );
    }
    tools.push(...codingTools(capabilities.coding));
    tools.push(...learningTools(this.config, this.store, conversationId,
      capabilities.files.searchEnabled ? file => this.retrieval.indexFile(file) : undefined));
    if (capabilities.files.enabled) tools.push(...workspaceFileTools(this.store, capabilities.coding, conversationId,
      capabilities.files.searchEnabled ? file => this.retrieval.indexFile(file) : undefined));
    tools.push(
      ...generationTools({
        jobs: this.jobs,
        store: this.store,
        conversationId,
        image: resolved.image,
        edit: resolved.edit,
        video: resolved.video,
        extraGeneration: resolved.extraGeneration,
        uploads,
        onProgress: (job) => this.emit(runId, conversationId, "job.progress", job),
      }),
    );
    tools.push(...mcpTools);
    tools.push(generationStatusTool(this.store, conversationId));
    tools.push(...memoryTools(this.store, capabilities.memory, conversationId, () => this.config.capabilities().memory));
    tools.push(...taskTools(this.store, conversationId, spec.id, runId, input.taskId, target => { this.stop(conversationId, target); }));

    let modelCallIndex = 0;
    let toolBatchSize = 0;
    let toolCallIndex = 0;
    const toolIndexes = new Map<string, number>();
    const toolImages = new Map<string, ImageRef[]>();
    const toolVideos = new Map<string, VideoRef>();
    let terminalError = "";

    if (cancel.signal.aborted) throw new Error("Run stopped before execution");
    this.store.setRunStatus(runId, "running");
    this.emit(runId, conversationId, "run.started", { modelId: spec.id, model: spec.name });

    let titlePromise = Promise.resolve();
    let agent: AgentLoop | undefined;
    let unsubscribeRun: (() => void) | void = undefined;
    // Held outside the try so a failure after the tree opens can still close the
    // run's operation. Everything that can throw belongs inside, or a failure
    // would leave the conversation marked active with no run to stop.

    try {
      const session = await this.sessions.session(conversationId);
      const entries = await this.sessions.entries(conversationId);
      // What the model is sent: the branch, with everything before the newest
      // compaction replaced by its summary.
      const history = session.buildSessionContext().messages;
      const isFirstTurn = entries.length === 0;

      // Exact image IDs can come from memory or saved visual context as well
      // as history. The tool resolves the ID; availability follows the model.
      if (spec.input.includes("image")) tools.push(viewImageTool(this.store));
      const offered = tools.map((tool) => ({ ...tool, parameters: stringifyToolEnums(tool.parameters) }));

      const pendingImages = [...uploadImageRefs];
      const freshImageIds = new Set(uploadImageRefs.map((image) => image.image_id));
      agent = await this.createLoop({
        manager: session,
        onAbort: () => { this.stop(conversationId); },
        onExtensionEvent: event => {
          const { type, ...data } = event;
          this.emit(runId, conversationId, `agent.${type}`, transportSafe(data));
        },
        providers: this.registry.runtime.getProviders(),
        workspace: capabilities.coding.workspace,
        prepareTools: async (discovered, baseTools) => {
          skills = await enrichDiscoveredSkills(discovered);
          const assembled = [...baseTools];
          if (skills.length) {
            const reader = await discoveredSkillReader(skills, capabilities.coding.workspace);
            let index = assembled.findIndex(tool => tool.name === "read");
            if (index < 0) { index = assembled.length; assembled.push(reader); }
            // SDK/project/extension skills can live outside data/skills. Route
            // their supporting files through the same bounded native reader.
            const original = assembled[index]!;
            const contextual = withSkillContext(original, skills, skillContext, reader);
            const known = withSkillContext(reader, skills, skillContext, reader);
            assembled[index] = { ...contextual, execute: (id, args, signal, update) => {
              const file = path.resolve(capabilities.coding.workspace, String((args as { path?: string }).path ?? ""));
              const inSkill = skills.some(skill => withinDirectory(skill.baseDir, file));
              return (inSkill ? known : contextual).execute(id, { ...args as object, path: file }, signal, update);
            } };
          }
          return assembled.map(tool => ({ ...tool, parameters: stringifyToolEnums(tool.parameters) }));
        },
        persist: (message) => {
          const row = message as { role?: string; toolCallId?: string; isError?: boolean; stopReason?: string };
          const refs = row.role === "user" ? pendingImages.splice(0) : row.role === "toolResult" ? toolImages.get(String(row.toolCallId)) ?? [] : [];
          for (const ref of refs) freshImageIds.add(ref.image_id);
          const video = row.role === "toolResult" ? toolVideos.get(String(row.toolCallId)) : undefined;
          const documents = row.role === "user" ? uploadFileRefs.splice(0) : [];
          const persisted = withAppendedRefs(persistMessage(message, refs), [...documents, ...(video ? [video] : [])]) as AgentMessage;
          // Host provenance survives SDK cloning and compaction. A fixed
          // history-length offset cannot distinguish old/current messages once
          // compaction replaces the prefix or splits a turn.
          const wasCancelled = cancel.signal.aborted && (row.isError || row.stopReason === "error" || row.stopReason === "aborted");
          const tagged = { ...persisted, uncensiaRunId: runId, ...(wasCancelled ? { uncensiaCancelled: true } : {}) };
          if (message.role === "user") {
            const text = typeof message.content === "string" ? message.content : message.content.find(part => part.type === "text")?.text;
            const parsed = text ? parseSkillBlock(text) : null;
            // Presentation only: even a pasted SDK wrapper may collapse. The
            // exact effective skill match is not proof of invocation authority.
            if (parsed && skills.some(skill => skill.name === parsed.name && skill.filePath === parsed.location)) {
              return { ...tagged, uncensiaSkillInvocation: { name: parsed.name, userMessage: parsed.userMessage ?? "" } };
            }
          }
          return row.role === "user" || row.role === "toolResult" || wasCancelled ? tagged : persisted;
        },
        onSessionEvent: (event) => {
          if (event.type === "compaction_end" || event.type === "compaction_start" || event.type === "auto_retry_start" || event.type === "auto_retry_end" || event.type === "queue_update") {
            this.emit(runId, conversationId, `agent.${event.type}`, transportSafe(event));
          }
        },
        systemPrompt,
        model,
        thinkingLevel: spec.thinkingLevel ?? (spec.reasoning ? "medium" : "off"),
        tools: offered,
        // Keep media/tool payloads bounded, but leave history retention and
        // compaction to Pi. Refresh application data before each model call.
        transformContext: async (messages) => {
          const current = this.config.capabilities();
          const runtimeContext = buildModelContext({ ...contextInput,
            memories: this.store.listMemories(),
            memoryEnabled: current.memory.enabled,
            memoryTokenLimit: current.memory.tokenLimit,
            filesEnabled: current.files.enabled && current.files.searchEnabled,
            searchableFiles: [...searchableFiles.filter(file => file.currentRequest), ...this.store.searchableFiles().filter(file => !attachedIds.has(file.id)).map(file => ({ ...file, currentRequest: false }))],
          }).runtimeContext;
          return withRuntimeContext(await hydrateCurrentImages(
            boundToolResults(messages.flatMap(message => {
              const boundary = (message as { uncensiaRunId?: string }).uncensiaRunId === runId ? 0 : 1;
              return transformExpandedSkillMessages([message], boundary, skills, skillContext);
            })),
            spec.input.includes("image") ? freshImageIds : new Set(), this.store,
          ), runtimeContext + uploadedImageContext(uploads));
        },
        // Summaries outlive this run. Keep user arguments and exact asset IDs,
        // but do not bake temporary skill procedures/personas into a summary.
        transformCompaction: (messages) => omitSkillProceduresForCompaction(
          transformExpandedSkillMessages(messages, messages.length, skills, skillContext, true), messages.length,
        ),
        onPayload: (payload) => applyModelParameters(payload, spec),
        beforeToolCall: async ({ toolCall, args }, signal) => {
          if (toolCall.name === "report_task_progress" && toolBatchSize !== 1) {
            return { block: true, reason: "Report task progress in a separate tool batch after the work tools have finished. This call ends the task turn." };
          }
          return this.gate(runId, conversationId, capabilities.coding.workspace, toolCall, args, signal ?? cancel.signal);
        },
      });
      entry.agent = agent;

      // The agent awaits every listener, so tree writes stay in event order.
      unsubscribeRun = agent.subscribe(async (event) => {
        if (event.type === "message_start" && (event.message as { role?: string }).role === "assistant") {
          modelCallIndex += 1;
        }
        if (event.type === "tool_execution_start") {
          toolCallIndex += 1;
          toolIndexes.set(event.toolCallId, toolCallIndex);
        }

        let payload: unknown = event;
        if (event.type === "message_end") {
          const message = event.message as { role?: string; toolCallId?: string; content?: unknown };
          if (message.role === "assistant") {
            toolBatchSize = Array.isArray(message.content) ? message.content.filter(part => part.type === "toolCall").length : 0;
          }
          // Pi's awaited internal listener persisted the message before this
          // listener runs. The extension already replaced pixels with refs.
          const stored = event.message;
          const entryId = session.getLeafId();
          const messageId = this.store.addMessage(conversationId, stored, entryId ?? undefined);
          payload = { ...event, message: stored, messageId };
          if (message.role === "assistant") terminalError = "";
          if (message.role === "assistant" && (event.message as { stopReason?: string }).stopReason === "error") {
            // Kept raw: the catch below is the single place that turns a provider
            // failure into prose, and describing it twice throws the first
            // description away in favour of the generic fallback.
            terminalError = (event.message as { errorMessage?: string }).errorMessage || "模型请求失败";
          }
        }
        if (event.type === "tool_execution_end") {
          const meta = (event.result as { details?: { structuredContent?: unknown } } | undefined)?.details
            ?.structuredContent;
          const ref = imageRef(meta);
          const images = (event.result as { content?: Array<{ type: string; data?: string; mimeType?: string }> })?.content?.filter((part) => part.type === "image" && part.data) ?? [];
          const refs: ImageRef[] = [];
          for (const [index, image] of images.entries()) {
            if (index === 0 && ref) { refs.push(ref); continue; }
            const mime = image.mimeType ?? "image/png";
            const id = await saveImageBytes(this.store, Buffer.from(image.data!, "base64"), { mime, provider: "tool", model: event.toolName });
            refs.push({ type: "image_ref", image_id: id, mime_type: mime });
          }
          if (refs.length) toolImages.set(event.toolCallId, refs);
          const video = videoRef(meta);
          if (video) toolVideos.set(event.toolCallId, video);
          registerGeneratedImage(this.store, meta);
          // Third, smaller ceiling: what a browser is shown of a tool result,
          // which never has to be complete because the transcript row is.
          payload = compactToolText(transportSafe({ ...event, cancelled: cancel.signal.aborted && event.isError }, ref), { maxBytes: 6_000 });
        }

        const shouldStore =
          event.type === "message_update" ||
          event.type === "tool_execution_start" ||
          event.type === "tool_execution_update" ||
          event.type === "tool_execution_end" ||
          (event.type === "message_end" &&
            ["user", "assistant", "custom"].includes((event.message as { role?: string }).role ?? ""));
        if (!shouldStore) return;

        const type = event.type === "message_update" ? "message.delta" : event.type.replaceAll("_", ".");
        const safe =
          event.type === "message_update"
            ? { assistantMessageEvent: transportSafe(event.assistantMessageEvent) }
            : transportSafe(payload);
        this.emit(runId, conversationId, type, {
          ...(safe as Record<string, unknown>),
          modelCallIndex,
          toolCallIndex: "toolCallId" in event ? toolIndexes.get(event.toolCallId) : undefined,
        });
      });

      titlePromise = isFirstTurn && prompts.titleEnabled
        ? this.scheduleTitle(runId, conversationId, spec.id, prompts.titleModelId, input.message)
        : Promise.resolve();

      if (cancel.signal.aborted) throw new Error("Run stopped by the user");
      // Startup hooks may emit messages. Bind only after the projection
      // listener is installed, and check cancellation again after async hooks.
      await agent.initialize?.();
      if (cancel.signal.aborted) throw new Error("Run stopped by the user");
      if (input.compact) {
        if (!agent.sdk) throw new Error("This loop does not support session compaction");
        await agent.sdk.compact("Preserve exact asset IDs and user-assigned image roles, unfinished goals and the user's explicit choices. Do not invent completed work.");
      } else if (input.continue && canResume(history)) await agent.continue();
      else await agent.prompt(input.message.trim(), media);
      if (entry.aborted) throw new Error("Run stopped by the user");
      if (terminalError) throw new Error(terminalError);
      // The terminal event closes every client stream, so anything that still
      // needs to reach the client — the generated title — must land first.
      await titlePromise;
      // Cleanup is part of the run contract, before its terminal SSE event.
      // A failing shutdown hook must not follow a reported success.
      await agent.dispose?.();
      if (entry.aborted) throw new Error("Run stopped by the user");
      this.store.setRunStatus(runId, "completed");
      this.emit(runId, conversationId, "run.completed", {});
    } catch (error) {
      await titlePromise.catch(() => undefined);
      try { await agent?.dispose?.(); } catch (cleanupError) {
        if (!(error instanceof HarnessHostError)) error = cleanupError;
      }
      const raw = error instanceof Error ? error.message : String(error);
      // Cancellation is knowable from the run's own state and the error's type;
      // reading it out of the message text guessed wrong whenever a provider
      // happened to use the word.
      const cancelled =
        entry.aborted || cancel.signal.aborted || (error instanceof Error && error.name === "AbortError");
      const status = cancelled ? "cancelled" : "failed";
      const message = status === "cancelled" || error instanceof HarnessHostError ? raw : describeModelError(raw, spec.name, error);
      this.store.setRunStatus(runId, status, message);
      this.emit(runId, conversationId, `run.${status}`, { message });
    } finally {
      // Keep cleanup messages observable, then release this run's closures.
      // A future conversation-scoped host must not retain old run listeners.
      if (typeof unsubscribeRun === "function") unsubscribeRun();
      cancel.abort();
      // A run cannot end with a question still on screen: whatever was waiting
      // for a decision is gone, so the card has to stop offering one.
      for (const pending of this.store.pendingApprovals(conversationId)) {
        if (pending.runId !== runId) continue;
        const settled = this.store.decideApproval(pending.id, "expired");
        this.approvals.notify(pending.id);
        if (settled) this.emit(runId, conversationId, "tool.approval.resolved", { approval: settled });
      }
      this.store.pruneSettledTransientEvents(DELTA_RETENTION_MS);
      this.store.reclaimStorage();
    }
  }

  /**
   * Preflight for one tool call. Ordinary calls fall straight through; a
   * destructive one is held until a person answers. Returning a blocked result
   * rather than throwing is what turns a refusal into an ordinary tool result
   * the model can read and reason about, instead of an error it might retry.
   */
  private async gate(
    runId: string,
    conversationId: string,
    workspace: string,
    toolCall: { name: string; id: string },
    args: unknown,
    signal: AbortSignal,
  ) {
    const risk = describeRisk(toolCall.name, (args ?? {}) as Record<string, unknown>, workspace);
    if (!risk) return undefined;

    const approval = this.store.requestApproval({
      id: toolCall.id,
      runId,
      conversationId,
      toolName: toolCall.name,
      action: risk.action,
      summary: risk.summary,
      detail: risk.detail,
    });
    if (approval.status === "pending") {
      this.emit(runId, conversationId, "tool.approval.required", { approval });
    }

    const settled = await this.approvals.wait(this.store, approval.id, signal);
    this.emit(runId, conversationId, "tool.approval.resolved", { approval: settled });
    return settled.status === "approved" ? undefined : { block: true as const, reason: rejectionMessage(settled) };
  }

  /**
   * Fires the naming call alongside the main run so the sidebar updates while
   * the answer is still streaming. The call carries its own system prompt, not
   * the conversation's: the persona answers a naming request the way it answers
   * a turn, and what reached the sidebar was its preamble or its tool call.
   */
  private async scheduleTitle(
    runId: string,
    conversationId: string,
    conversationModelId: string,
    titleModelId: string,
    userText: string,
  ) {
    const modelId = titleModelId && this.store.getModel(titleModelId)?.enabled ? titleModelId : conversationModelId;
    try {
      const generated = await generateTitle({
        registry: this.registry,
        modelId,
        userText,
        assistantText: "",
      });
      const title = generated || fallbackTitle(userText);
      if (!title) return;
      this.store.setConversationTitle(conversationId, title);
      this.emit(runId, conversationId, "conversation.title", { title });
    } catch (error) {
      // A conversation without a generated title is harmless, but a silent
      // failure here is hard to notice, so it is logged.
      console.error("[title]", error instanceof Error ? error.message : error);
    }
  }

  stop(conversationId: string, expectedRunId?: string) {
    const entry = this.active.get(conversationId);
    if (!entry || (expectedRunId && entry.runId !== expectedRunId)) return false;
    entry.aborted = true;
    // Cancels preparation — summarizing a long conversation is itself a model
    // call — and then the loop, if it got that far.
    entry.cancel.abort();
    entry.agent?.abort();
    return true;
  }

  async steer(conversationId: string, text: string) {
    const entry = this.active.get(conversationId);
    if (!entry?.agent) return false;
    await entry.agent.steer(text);
    return true;
  }

  async followUp(conversationId: string, text: string) {
    const entry = this.active.get(conversationId);
    if (!entry?.agent) return false;
    await entry.agent.followUp(text);
    return true;
  }
}

function withinDirectory(directory: string, file: string) {
  const relative = path.relative(directory, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** SDK-native read restricted to effective skill directories, including
 * supporting files. Real paths prevent a skill symlink from escaping its root. */
async function discoveredSkillReader(skills: UncensiaSkill[], workspace: string): Promise<AgentTool> {
  const roots = await Promise.all([...new Set(skills.map(skill => skill.baseDir))].map(root => fs.realpath(root)));
  const resolve = async (file: string) => {
    const real = await fs.realpath(file);
    if (!roots.some(root => withinDirectory(root, real))) throw new Error(`Path is outside the discovered skill directories: ${file}`);
    return real;
  };
  const reader = createReadTool(workspace, { operations: {
    access: async file => { await fs.access(await resolve(file)); },
    readFile: async file => fs.readFile(await resolve(file)),
  } });
  reader.description = "Read a discovered skill's SKILL.md or its supporting files. Only discovered skill directories are accessible; use exact paths from the skill catalogue or a loaded skill. Workspace file reading is disabled. Library attachments are not filesystem paths: use their supplied text, or file_search with the exact file_id when that tool is available. Supports offset and limit for paginated text reading.";
  return reader;
}

/** Pixels are transient provider input. Their exact asset references are the
 * durable message, so reconnect and compaction never change image identity. */
async function hydrateCurrentImages(messages: AgentMessage[], freshIds: Set<string>, store: Store) {
  // A selected or inspected asset may also occur in older messages. Send its
  // pixels once, beside the latest reference; retain every historical ID.
  const lastReference = new Map<string, unknown>();
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type === "image_ref" && freshIds.has(part.image_id)) lastReference.set(part.image_id, part);
    }
  }
  const hydrated: AgentMessage[] = [];
  for (const message of messages) {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) { hydrated.push(message); continue; }
    const parts: unknown[] = [];
    for (const part of content) {
      parts.push(part);
      if (part.type !== "image_ref" || lastReference.get(part.image_id) !== part) continue;
      const file = store.getFile(part.image_id);
      if (!file) throw new Error(`Referenced image is missing: ${part.image_id}`);
      const encoded = await encodeForModel(file.id, file.diskPath, file.mime);
      if (!encoded) throw new Error(`Referenced image cannot be decoded: ${part.image_id}`);
      parts.push({ type: "image", ...encoded });
    }
    hydrated.push({ ...message, content: parts } as AgentMessage);
  }
  return describeRefs(hydrated);
}
