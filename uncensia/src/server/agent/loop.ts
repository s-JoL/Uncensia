/**
 * Pi AgentSession integration: Runtime supplies product tools, persistence
 * transforms and provider configuration; the SDK owns the agent lifecycle.
 */
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore, type Model, type Provider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager, type AgentSession, type AgentSessionEvent, type SessionManager, type ToolDefinition, type Skill, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { paths } from "../env.ts";
import { describeRefs, omitForeignThinking } from "./messages.ts";
import { enabledSkills } from "../tools/skill-management.ts";

export type LoopImage = { type: "image"; data: string; mimeType: string };

/**
 * What a loop must emit. Named for what Runtime does with them. A second engine
 * produces this union; it does not re-export pi's `AgentEvent`.
 */
export type LoopEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: unknown }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_end"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: unknown }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean };

export type LoopListener = (event: LoopEvent) => Promise<void> | void;

export interface AgentLoop {
  sdk?: AgentSession;
  initialize?(): Promise<void>;
  dispose?(): void | Promise<void>;
  prompt(text: string, media: LoopImage[]): Promise<void>;
  continue(): Promise<void>;
  steer(text: string): Promise<void> | void;
  followUp(text: string): Promise<void> | void;
  abort(): void;
  subscribe(listener: LoopListener): (() => void) | void;
}

/**
 * Product configuration supplied to the SDK session factory.
 */
export interface LoopStart {
  manager: SessionManager;
  providers: readonly Provider[];
  workspace: string;
  persist: (message: AgentMessage) => AgentMessage;
  onSessionEvent?: (event: AgentSessionEvent) => void;
  onAbort?: () => void;
  onExtensionEvent: (event: { type: "extension_notify"; message: string; level: "info" | "warning" | "error" } | { type: "extension_status"; key: string; text?: string }) => void;
  systemPrompt: string;
  model: Model<never>;
  thinkingLevel: string;
  tools: AgentTool[];
  prepareTools?: (skills: Skill[], tools: AgentTool[]) => Promise<AgentTool[]>;
  transformContext: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  transformCompaction?: (messages: AgentMessage[]) => AgentMessage[];
  onPayload: (payload: unknown) => unknown;
  beforeToolCall: (
    context: { toolCall: { name: string; id: string }; args: unknown },
    signal?: AbortSignal,
  ) => Promise<{ block: true; reason: string } | undefined>;
}

export type LoopFactory = (start: LoopStart) => AgentLoop | Promise<AgentLoop>;

/** Host failures must not be presented as provider/model failures. */
export class HarnessHostError extends Error {
  override name = "HarnessHostError";
}

export async function createPiLoop(start: LoopStart): Promise<AgentLoop> {
  if (!start.onExtensionEvent) throw new HarnessHostError("The Pi host requires a notification/status event sink before advertising RPC UI support.");
  let registerTools: ((tools: AgentTool[]) => void) | undefined;
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  for (const provider of start.providers) modelRuntime.registerNativeProvider(provider);
  const settings = SettingsManager.inMemory({
    enableAnalytics: false, enableInstallTelemetry: false,
    steeringMode: "one-at-a-time", followUpMode: "one-at-a-time",
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 1000, provider: { maxRetries: 3 } },
    compaction: { enabled: true, reserveTokens: Math.min(Math.max(start.model.maxTokens, 16384), start.model.contextWindow / 2), keepRecentTokens: Math.min(20000, start.model.contextWindow / 4) },
  });
  const loader = new DefaultResourceLoader({
    cwd: start.workspace, agentDir: path.join(paths.data, "agent"), settingsManager: settings,
    additionalSkillPaths: [paths.skills], systemPrompt: start.systemPrompt,
    skillsOverride: enabledSkills,
    noThemes: true, noContextFiles: true,
    // Uncensia is a conversational product, not an implicit checkout session.
    // Repository instructions are read when working on that repository.
    extensionFactories: [(pi) => {
      registerTools = (tools) => { for (const tool of tools) pi.registerTool(tool as ToolDefinition); };
      pi.on("context", async (event, context) => ({ messages: await start.transformContext(omitForeignThinking(event.messages, context.model ?? start.model), context.signal) }));
      pi.on("before_provider_request", async (event) => start.onPayload(event.payload));
      pi.on("tool_call", async (event, context) => start.beforeToolCall({ toolCall: { name: event.toolName, id: event.toolCallId }, args: event.input }, context.signal));
      pi.on("message_end", async (event) => ({ message: start.persist(event.message) }));
      pi.on("session_before_compact", async (event, context) => {
        const transform = (messages: AgentMessage[]) => {
          const history = omitForeignThinking(messages, context.model ?? start.model);
          return describeRefs(start.transformCompaction?.(history) ?? history);
        };
        event.preparation.messagesToSummarize = transform(event.preparation.messagesToSummarize);
        event.preparation.turnPrefixMessages = transform(event.preparation.turnPrefixMessages);
      });
    }],
  });
  await loader.reload();
  const baseTools = [...start.tools];
  const tools = start.prepareTools ? await start.prepareTools(loader.getSkills().skills, baseTools) : baseTools;
  const { session, modelFallbackMessage, extensionsResult } = await createAgentSession({
    cwd: start.workspace, agentDir: path.join(paths.data, "agent"),
    model: start.model, modelRuntime, thinkingLevel: start.thinkingLevel as never,
    sessionManager: start.manager, settingsManager: settings, resourceLoader: loader,
    noTools: "builtin",
  });
  if (modelFallbackMessage || session.model?.id !== start.model.id || session.model.provider !== start.model.provider) {
    session.dispose();
    throw new Error(modelFallbackMessage || "The requested model could not be selected");
  }
  // registerTool is Pi's public dynamic tool API; it refreshes definitions and
  // the system prompt without replacing the agent or reaching into internals.
  try {
    registerTools?.(tools);
    session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), ...tools.map(tool => tool.name)])]);
  } catch (error) {
    session.dispose();
    throw error;
  }
  const agent = session.agent;
  const unsubscribeSessionEvents = start.onSessionEvent ? session.subscribe(start.onSessionEvent) : undefined;
  const subscriptions = new Map<LoopListener, () => void>();
  const operations = new Set<Promise<void>>();
  let closing = false;
  const assertOpen = () => {
    if (closing) throw new HarnessHostError("This Pi host is closing or disposed; no new operation was admitted.");
  };
  let hostError: HarnessHostError | undefined;
  let initialization: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  const customEvents: Promise<void>[] = [];
  const flushCustomEvents = async () => { await Promise.all(customEvents.splice(0)); };
  const checkHost = () => { if (hostError) throw hostError; };
  const unsupported = (action: string): never => {
    throw new HarnessHostError(`Uncensia harness does not support ${action}. No action was performed.`);
  };
  // This is a limited RPC UI: notifications/status have a real event sink.
  // hasUI means that a binding exists, not that terminal/dialog APIs work.
  // Tool approvals cannot stand in for arbitrary extension dialogs.
  const ui: ExtensionUIContext = {
    theme: session.extensionRunner.getUIContext().theme,
    select: async () => unsupported("ui.select"),
    confirm: async () => unsupported("ui.confirm"),
    input: async () => unsupported("ui.input"),
    editor: async () => unsupported("ui.editor"),
    custom: async () => unsupported("ui.custom"),
    notify: (message, level = "info") => {
      start.onExtensionEvent({ type: "extension_notify", message, level });
    },
    onTerminalInput: () => unsupported("ui.onTerminalInput"),
    setStatus: (key, text) => {
      start.onExtensionEvent({ type: "extension_status", key, text });
    },
    setWorkingMessage: () => unsupported("ui.setWorkingMessage"),
    setWorkingVisible: () => unsupported("ui.setWorkingVisible"),
    setWorkingIndicator: () => unsupported("ui.setWorkingIndicator"),
    setHiddenThinkingLabel: () => unsupported("ui.setHiddenThinkingLabel"),
    setWidget: () => unsupported("ui.setWidget"),
    setFooter: () => unsupported("ui.setFooter"),
    setHeader: () => unsupported("ui.setHeader"),
    setTitle: () => unsupported("ui.setTitle"),
    pasteToEditor: () => unsupported("ui.pasteToEditor"),
    setEditorText: () => unsupported("ui.setEditorText"),
    getEditorText: () => unsupported("ui.getEditorText"),
    addAutocompleteProvider: () => unsupported("ui.addAutocompleteProvider"),
    setEditorComponent: () => unsupported("ui.setEditorComponent"),
    getEditorComponent: () => unsupported("ui.getEditorComponent"),
    getAllThemes: () => unsupported("ui.getAllThemes"),
    getTheme: () => unsupported("ui.getTheme"),
    setTheme: () => unsupported("ui.setTheme"),
    getToolsExpanded: () => unsupported("ui.getToolsExpanded"),
    setToolsExpanded: () => unsupported("ui.setToolsExpanded"),
  };
  const initialize = () => {
    assertOpen();
    return initialization ??= (async () => {
    if (extensionsResult.errors.length) {
      throw new HarnessHostError(`Extension loading failed: ${extensionsResult.errors.map(error => `${error.path}: ${error.error}`).join("; ")}`);
    }
    await session.bindExtensions({
      mode: "rpc", uiContext: ui,
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        newSession: async () => unsupported("newSession"),
        fork: async () => unsupported("fork"),
        navigateTree: async () => unsupported("navigateTree"),
        switchSession: async () => unsupported("switchSession"),
        reload: async () => unsupported("reload"),
      },
      abortHandler: () => { if (start.onAbort) start.onAbort(); else void session.abort(); },
      shutdownHandler: () => unsupported("shutdown of the shared Uncensia service from an extension"),
      // Pi catches command/hook exceptions. Preserve that separate failure
      // channel even if the SDK prompt resolves or a later model call succeeds.
      onError: (error) => {
        const message = `Extension ${error.event} failed (${error.extensionPath}): ${error.error}`;
        if (hostError) hostError.message += `\n${message}`;
        else hostError = new HarnessHostError(message);
      },
    });
    await flushCustomEvents();
    checkHost();
    // resources_discover runs during bindExtensions. Its effective skill set
    // must also drive Uncensia's readers, aliases, explicit commands and budget.
    if (start.prepareTools) {
      const effectiveTools = await start.prepareTools(loader.getSkills().skills, baseTools);
      registerTools?.(effectiveTools);
      const added = effectiveTools.filter(tool => !tools.some(previous => previous.name === tool.name));
      session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), ...added.map(tool => tool.name)])]);
    }
    })();
  };
  const invoke = (operation: () => Promise<void>) => {
    // Admission happens before the first await. Shutdown seals the boundary
    // synchronously, then drains this set before extension cleanup.
    assertOpen();
    const work = (async () => {
      await initialize();
      assertOpen();
      try { await operation(); } finally { await flushCustomEvents(); checkHost(); }
    })();
    operations.add(work);
    // Both handlers consume the tracking branch's rejection; the caller still
    // receives the original failure from work.
    void work.then(() => operations.delete(work), () => operations.delete(work));
    return work;
  };
  return {
    sdk: session,
    initialize,
    dispose: () => {
      closing = true;
      return disposal ??= (async () => {
      try {
        await initialization?.catch(() => undefined);
        await session.abort();
        await Promise.allSettled([...operations]);
        if (initialization) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        await flushCustomEvents();
        checkHost();
      } finally {
        for (const unsubscribe of subscriptions.values()) unsubscribe();
        unsubscribeSessionEvents?.();
        session.dispose();
      }
      })();
    },
    prompt: (text, media) => invoke(() => session.prompt(text, { images: media })),
    continue: () => invoke(() => session.prompt("继续上面的任务，保留已完成的结果。")),
    steer: (text) => invoke(() => session.steer(text)),
    followUp: (text) => invoke(() => session.followUp(text)),
    abort: () => { void session.abort(); },
    subscribe: (listener) => {
      assertOpen();
      const existing = subscriptions.get(listener);
      if (existing) return existing;
      const isCustomMessage = (event: { type: string; message?: AgentMessage }) =>
        ["message_start", "message_end", "message_update"].includes(event.type) && event.message?.role === "custom";
      // Pi emits idle/startup custom messages only on AgentSession. Subscribe
      // there for all custom messages; skip their duplicate raw-Agent events.
      const unsubscribeCustom = session.subscribe(event => {
        if (!isCustomMessage(event)) return;
        try {
          const work = Promise.resolve(listener(event as LoopEvent)).catch(error => {
            hostError ??= new HarnessHostError(`Custom message projection failed: ${error instanceof Error ? error.message : String(error)}`);
          });
          customEvents.push(work);
        } catch (error) {
          hostError ??= new HarnessHostError(`Custom message projection failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      const unsubscribeAgent = agent.subscribe(async (event) => {
        if (isCustomMessage(event)) return;
        await listener(event as LoopEvent);
      });
      const unsubscribe = () => {
        unsubscribeCustom();
        unsubscribeAgent();
        subscriptions.delete(listener);
      };
      subscriptions.set(listener, unsubscribe);
      return unsubscribe;
    },
  };
}
