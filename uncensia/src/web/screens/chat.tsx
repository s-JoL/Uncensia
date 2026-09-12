import { uiText } from "../i18n.tsx";
import {
  Check,
  ListTodo,
  Copy,
  CornerDownLeft,
  ArrowUp,
  MoreHorizontal,
  Sparkles,
  FileText,
  ImageIcon,
  Menu as MenuIcon,
  Paperclip,
  Pencil,
  RefreshCw,
  SlidersHorizontal,
  Square,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TaskPanel } from "../ui/task-panel.tsx";
import { ConversationEvidence } from "../resource-view.tsx";
import type {
  Approval,
  BackgroundTask,
  Bootstrap,
  FileRecord,
  RoleplayContext,
  StoredMessage,
  VisualContinuityContext,
  VisualReferenceRole,
} from "@shared/types.ts";
import {
  EMPTY_ROLEPLAY_CONTEXT,
  EMPTY_VISUAL_CONTINUITY_CONTEXT,
  isChatKind,
  IMAGE_REFERENCE_ROLES,
} from "@shared/types.ts";
import type { ImageReferenceRole } from "@shared/types.ts";
import type { Project } from "@shared/projects.ts";
import { AssetPicker } from "../ui/asset-picker.tsx";
import { CharacterCardImport } from "../ui/character-card-import.tsx";
import { ConversationTree } from "../ui/conversation-tree.tsx";
import { api, followRun } from "../api.ts";
import { takeChatAttachment } from "../chat-draft.ts";
import { useChatDraft } from "../use-chat-draft.ts";
import { askToNotify, notifyFinished } from "../notify.ts";
import { assetIdOf, ProvenanceCard } from "../provenance.tsx";
import { Markdown, prefetchKatex } from "../markdown.tsx";
import {
  attachmentIdsOf,
  buildTurns,
  collectCitations,
  collectCitationsByTurn,
  LiveTurn,
  toolCallIds,
  turnText,
  type Citation,
  type FilePart,
  type Turn,
} from "../messages.ts";
import {
  Badge,
  Button,
  cn,
  Field,
  formatBytes,
  JobCard,
  Lightbox,
  Modal,
  Menu,
  MenuItem,
  Select,
  Spinner,
  Switch,
  ToolView,
  Textarea,
  Tooltip,
  useToast,
  useTouchPrimary,
  VideoView,
} from "../ui.tsx";

interface Props {
  bootstrap: Bootstrap;
  conversationId: string;
  /** A search hit's message: the transcript opens there instead of at the end. */
  focusSeq?: number;
  onConversationCreated: (id: string) => Promise<void>;
  onConversationChanged: () => Promise<unknown>;
  onOpenRail: () => void;
}

export function Chat({
  bootstrap,
  conversationId,
  focusSeq,
  onConversationCreated,
  onConversationChanged,
  onOpenRail,
}: Props) {
  const toast = useToast();
  const touch = useTouchPrimary();
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [live, setLive] = useState<Turn | null>(null);
  const [pendingUser, setPendingUser] = useState<Turn | null>(null);
  const [running, setRunning] = useState(false);
  const [feedbackRevision, setFeedbackRevision] = useState(0);
  const {draft,setDraft,attachments,setAttachments,referenceRoles,setReferenceRoles} = useChatDraft(conversationId);
  const [pickingAsset, setPickingAsset] = useState(false);
  const [showTree, setShowTree] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [zoom, setZoom] = useState("");
  const [title, setTitle] = useState("");
  const [modelId, setModelId] = useState(bootstrap.defaultModelId);
  const [picking, setPicking] = useState(false);
  const [projectId,setProjectId] = useState<string|null>(null);
  const [projects,setProjects] = useState<Project[]>([]);
  useEffect(()=>{if (picking) void api.projects().then(setProjects).catch(e=>toast(String(e),true));},[picking,toast]);
  const [roleplay, setRoleplay] = useState<RoleplayContext>({ ...EMPTY_ROLEPLAY_CONTEXT });
  const [visualContinuity, setVisualContinuity] = useState<VisualContinuityContext>({
    ...EMPTY_VISUAL_CONTINUITY_CONTEXT,
    references: [],
  });
  const [savingContext, setSavingContext] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([]);
  const [editingSeq, setEditingSeq] = useState<number | null>(null);
  const [runningInstruction, setRunningInstruction] = useState<"steer" | "follow-up">("steer");

  const threadRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * Creating a conversation navigates onto its id, which re-runs the load
   * effect. Without this flag that effect would drop the optimistic user turn
   * and flash the empty state while the first run is already in flight.
   */
  const seedingRef = useRef(false);
  /** The turn currently being streamed, so a late fetch can tell if it is stale. */
  const liveTurnRef = useRef<LiveTurn | null>(null);
  const stickyRef = useRef(true);
  /** Highest message seq already rendered, so reloads only fetch the tail. */
  const messageSeqRef = useRef(-1);
  /** Conversation the transcript on screen belongs to, for late-arriving fetches. */
  const openConversationRef = useRef(conversationId);
  const messagesRef = useRef<StoredMessage[]>([]);
  const syncedRevisionRef = useRef<string | null>(null);
  messagesRef.current = messages;

  useEffect(prefetchKatex, []);

  const chatModels = useMemo(
    () => bootstrap.models.filter((model) => model.enabled && model.configured && isChatKind(model.kind)),
    [bootstrap.models],
  );
  /**
   * The switcher lists pinned models only — the dropdown is for the few you
   * actually reach for. With nothing pinned that list is empty and there would
   * be no way to choose at all, so it falls back to everything usable.
   */
  const listedModels = useMemo(() => {
    const pinned = chatModels.filter((model) => model.pinned);
    return pinned.length ? pinned : chatModels;
  }, [chatModels]);
  const current = bootstrap.models.find((model) => model.id === modelId);

  const syncMessages = useCallback(async (id: string, incremental: boolean, isCurrent: () => boolean = () => true) => {
    const from = incremental ? messageSeqRef.current : -1;
    const log = await api.messages(id, from);
    // Switching conversations quickly leaves the previous fetch in flight, and
    // it resolves after the new one. Without this guard the old transcript is
    // painted under the new conversation's title and stays until a reload.
    if (openConversationRef.current !== id || !isCurrent()) return messagesRef.current;
    messageSeqRef.current = Math.max(from, ...log.items.map((item) => item.seq));
    const merged = from >= 0
      ? [...new Map([...messagesRef.current, ...log.items].map((item) => [item.seq, item])).values()].sort((a, b) => a.seq - b.seq)
      : log.items;
    messagesRef.current = merged;
    setMessages(merged);
    return merged;
  }, []);

  /**
   * Picks up a run that is still going on the server — after a reload, or on a
   * second device. The transcript already holds the settled messages, so the
   * stream is replayed from the run's resume point.
   */
  const follow = useCallback(
    async (id: string, runId: string, from: number, known: Set<string>) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const turn = new LiveTurn(known);
      let completed = false;
      liveTurnRef.current = turn;
      setRunning(true);
      setLive(turn.snapshot());
      // A question asked while this client was closed has no event left to
      // replay if the run resumes past it, so it is fetched rather than waited
      // for. Seeding is idempotent with the stream.
      void api
        .approvals(id)
        .then(({ items }) => {
          if (liveTurnRef.current !== turn || !items.length) return;
          turn.seedApprovals(items.filter((item) => item.runId === runId));
          setLive(turn.snapshot());
        })
        .catch(() => undefined);
      try {
        await followRun(
          runId,
          from,
          (type, data) => {
            if (controller.signal.aborted || abortRef.current !== controller || openConversationRef.current !== id) return;
            if (type === "run.completed") completed = true;
            turn.apply(type, data);
            if (type === "conversation.title") {
              setTitle(String(data.title ?? ""));
              void onConversationChanged();
            }
            if (type === "run.failed") toast(String(data.message ?? uiText("运行失败")), true);
            if (type === "agent.extension_notify" && typeof data.message === "string") {
              toast(`${data.level === "warning" ? uiText("提醒：") : ""}${data.message}`, data.level === "error");
            }
            setLive(turn.snapshot());
          },
          controller.signal,
        );
      } finally {
        // Another conversation may have been opened while this leg was running;
        // its own effect owns the screen now.
        if (abortRef.current === controller && openConversationRef.current === id) {
          abortRef.current = null;
          setRunning(false);
          // A turn that drew three pictures took minutes, and the reader has
          // usually gone elsewhere by the time it lands.
          if (completed) notifyFinished(uiText("回复完成"), turnText(turn.snapshot()).trim().slice(0, 120));
          // The live turn is only swapped for the stored transcript once that
          // transcript is actually in hand; dropping it while the network is
          // down would blank an answer the reader was in the middle of.
          const synced = await syncMessages(id, true).then(
            () => true,
            () => false,
          );
          if (synced) {
            setPendingUser(null);
            setLive(null);
          }
          await onConversationChanged().catch(() => undefined);
        }
      }
    },
    [onConversationChanged, syncMessages, toast],
  );

  useEffect(() => {
    if (!seedingRef.current) {
      abortRef.current?.abort();
      abortRef.current = null;
      setLive(null);
      setPendingUser(null);
      setRunning(false);
      messageSeqRef.current = -1;
      syncedRevisionRef.current = null;
      messagesRef.current = [];
      setMessages([]);
    }
    openConversationRef.current = conversationId;
    setEditingSeq(null);
    if (!conversationId) {
      setTitle("");
      setModelId(bootstrap.defaultModelId);
      setRoleplay({ ...EMPTY_ROLEPLAY_CONTEXT });
      setProjectId(null);
      setVisualContinuity({ ...EMPTY_VISUAL_CONTINUITY_CONTEXT, references: [] });
      return;
    }
    if (seedingRef.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const [summary, log] = await Promise.all([
          api.conversation(conversationId),
          syncMessages(conversationId, false),
        ]);
        if (cancelled) return;
        setTitle(summary.title);
        setModelId(summary.modelId);
        setRoleplay(summary.roleplay);
        setProjectId(summary.projectId ?? null);
        setVisualContinuity(summary.visualContinuity);
        if (summary.activeRun) {
          void follow(
            conversationId,
            summary.activeRun.id,
            summary.activeRun.resumeSeq ?? 0,
            toolCallIds(buildTurns(log)),
          );
        }
      } catch (error) {
        if (!cancelled) toast(error instanceof Error ? error.message : String(error), true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootstrap.defaultModelId, conversationId, follow, syncMessages, toast]);

  /**
   * A phone can be asleep long enough for the stream loop to give up, and it
   * wakes with no network for a moment. Every return to the foreground — and
   * every reconnect — re-reads the transcript and reattaches to a run that is
   * still going, so recovery never depends on the dropped connection. A cheap
   * visible-page poll also discovers work started on another device. Changed
   * transcripts are replaced because another device may have moved branches.
   */
  useEffect(() => {
    if (!conversationId || picking) return;
    let cancelled = false;
    let inFlight = false;
    const isCurrent = () => !cancelled && openConversationRef.current === conversationId && !abortRef.current;
    const resync = () => {
      if (document.visibilityState !== "visible" || !isCurrent() || inFlight) return;
      inFlight = true;
      void (async () => {
        try {
          const [summary, tasks] = await Promise.all([api.conversation(conversationId), api.backgroundTasks(conversationId)]);
          if (isCurrent()) setBackgroundTasks(tasks.items);
          if (!isCurrent()) return;
          const revision = `${conversationId}:${summary.updatedAt}:${summary.activeRun?.id ?? ""}`;
          if (revision === syncedRevisionRef.current) return;
          const log = await syncMessages(conversationId, false, isCurrent);
          if (!isCurrent()) return;
          syncedRevisionRef.current = revision;
          setTitle(summary.title);
          setModelId(summary.modelId);
          setRoleplay(summary.roleplay);
          setProjectId(summary.projectId ?? null);
          setVisualContinuity(summary.visualContinuity);
          if (summary.activeRun) {
            void follow(
              conversationId,
              summary.activeRun.id,
              summary.activeRun.resumeSeq ?? 0,
              toolCallIds(buildTurns(log)),
            );
          } else {
            setPendingUser(null);
            setLive(null);
            setRunning(false);
          }
        } catch {
          // Still offline; the next foreground poll or reconnect tries again.
        } finally {
          inFlight = false;
        }
      })();
    };
    const timer = window.setInterval(resync, 5_000);
    document.addEventListener("visibilitychange", resync);
    window.addEventListener("online", resync);
    window.addEventListener("focus", resync);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resync);
      window.removeEventListener("online", resync);
      window.removeEventListener("focus", resync);
    };
  }, [conversationId, follow, syncMessages, picking]);

  // Keep the view pinned to the newest output unless the reader scrolled up.
  useEffect(() => {
    const thread = threadRef.current;
    if (thread && stickyRef.current) thread.scrollTop = thread.scrollHeight;
  }, [messages, live, pendingUser]);

  /**
   * An image decodes after the turn holding it has rendered, and the height it
   * then claims shoves the newest output back off screen: the effect above has
   * already run, and a layout change is not a state change that would run it
   * again. A transcript records image ids and no dimensions, so there is nothing
   * to reserve the space with in advance — the correction is made when the
   * content resizes, which is the moment the picture takes its place.
   */
  const contentResize = useRef<ResizeObserver | null>(null);
  const watchContent = useCallback((node: HTMLDivElement | null) => {
    contentResize.current?.disconnect();
    if (!node) return;
    const observer = new ResizeObserver(() => {
      const thread = threadRef.current;
      if (thread && stickyRef.current) thread.scrollTop = thread.scrollHeight;
    });
    observer.observe(node);
    contentResize.current = observer;
  }, []);

  const turns = useMemo(() => buildTurns(messages), [messages]);

  /**
   * Opening a conversation from a search hit lands on the matching message
   * instead of at the end. A turn owns the sequence of its first message, so the
   * hit belongs to the last turn that starts at or before it.
   */
  useEffect(() => {
    if (focusSeq === undefined) return;
    const target = turns.filter((turn) => turn.seq <= focusSeq).at(-1);
    const element = target ? threadRef.current?.querySelector(`[data-seq="${target.seq}"]`) : undefined;
    if (!element) return;
    // Otherwise the pin-to-newest effect drags the view straight back down.
    stickyRef.current = false;
    element.scrollIntoView({ block: "center" });
    element.classList.add("ring-2", "ring-ring/60", "rounded-lg");
    const timer = setTimeout(() => element.classList.remove("ring-2", "ring-ring/60", "rounded-lg"), 2_000);
    return () => clearTimeout(timer);
  }, [focusSeq, turns]);

  /**
   * Citations only ever come out of tool results, but `live` is a new object on
   * every token. Keying the merge on the live tool results alone keeps this Map
   * referentially stable through a stream, which is what stops every settled
   * turn in the transcript from re-parsing its Markdown on each delta.
   */
  const citationsByTurn = useMemo(() => collectCitationsByTurn(turns), [turns]);
  const settledCitations = useMemo(() => citationsByTurn.get(turns.at(-1)!) ?? new Map<string, Citation>(), [citationsByTurn, turns]);
  const liveRef = useRef<Turn | null>(null);
  liveRef.current = live;
  const liveToolState = live
    ? live.parts.map((part) => (part.kind === "tool" ? `${part.callId}:${part.result.length}` : "")).join("|")
    : "";
  const citations = useMemo(() => {
    const turn = liveRef.current;
    if (!turn || !liveToolState.replace(/\|/g, "")) return settledCitations;
    return new Map([...settledCitations, ...collectCitations([turn])]);
  }, [settledCitations, liveToolState]);

  const attach = async (files: FileList | File[]) => {
    // The cap is on the message, not on one drop, so what is already attached
    // has to come off the budget before anything else is uploaded.
    const cap = bootstrap.limits.maxAttachmentsPerMessage;
    const room = cap - attachments.length;
    const incoming = Array.from(files);
    if (room <= 0) {
      toast(uiText("一条消息最多附带 {0} 个附件，请先移除一些", [cap]), true);
      return;
    }
    if (incoming.length > room) {
      toast(uiText("一条消息最多附带 {0} 个附件，其余 {1} 个未添加", [cap, incoming.length - room]), true);
    }
    setUploading(true);
    try {
      for (const file of incoming.slice(0, room)) {
        if (file.size > bootstrap.limits.maxUploadBytes) {
          toast(uiText("{0} 超过上传大小上限", [file.name]), true);
          continue;
        }
        const record = await api.upload(file, conversationId || undefined);
        setAttachments((current) => [...current, record]);
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true);
    } finally {
      setUploading(false);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || running) return;
    if (!chatModels.length) {
      toast(uiText("先在设置里配置一个可用模型"), true);
      return;
    }

    let targetId = conversationId;
    setRunning(true);
    // Sending is the gesture a permission prompt needs behind it.
    askToNotify();
    stickyRef.current = true;
    setPendingUser({
      id: "pending",
      seq: -1,
      role: "user",
      parts: [
        { kind: "text", text },
        ...attachments.map((file) =>
          file.mime.startsWith("image/")
            ? ({ kind: "image", imageId: file.id } as const)
            : ({ kind: "file", fileId: file.id, name: file.name, bytes: file.bytes } as const),
        ),
      ],
    });
    setDraft("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    const attachmentIds = attachments.map((file) => file.id);
    setAttachments([]);
    try {
      if (!targetId) {
        seedingRef.current = true;
        const created = await api.createConversation(modelId);
        targetId = created.id;
        await onConversationCreated(created.id);
        seedingRef.current = false;
      }

      const run = await api.startRun(targetId, text, attachmentIds, modelId, undefined, attachments.filter((file) => file.mime.startsWith("image/") && referenceRoles[file.id] && referenceRoles[file.id] !== "context").map((file) => ({ imageId: file.id, role: referenceRoles[file.id]! })));
      await follow(targetId, run.runId, run.seq, new Set());
    } catch (error) {
      seedingRef.current = false;
      setRunning(false);
      setPendingUser(null);
      setDraft(text);
      setAttachments(attachments);
      toast(error instanceof Error ? error.message : String(error), true);
    }
  };

  /**
   * Pi has two distinct live queues. Steering changes the next model turn;
   * follow-up waits until the current answer naturally finishes. Neither queue
   * accepts attachments, so running mode presents text-only actions explicitly.
   */
  const queueDuringRun = async (mode = runningInstruction) => {
    const text = draft.trim();
    if (!conversationId || !running || !text) return;
    setDraft("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    try {
      if (mode === "steer") await api.steerRun(conversationId, text);
      else await api.followUpRun(conversationId, text);
      toast(mode === "steer" ? uiText("已加入转向，当前回合结束后生效") : uiText("已排在当前回答之后"));
    } catch (error) {
      // A fast answer can settle between the click and the request. Put the
      // instruction back rather than losing words the reader already wrote.
      setDraft((current) => current || text);
      toast(error instanceof Error ? error.message : String(error), true);
    }
  };

  /**
   * Replays a user turn: the server drops it and everything after, then runs
   * the text below in its place. Regenerating passes the original text, so the
   * two actions are the same operation with a different string.
   */
  const replay = async (turn: Turn, text: string) => {
    if (!conversationId || running || !text.trim()) return;
    setRunning(true);
    setEditingSeq(null);
    stickyRef.current = true;
    // The rewind invalidates every seq the client has cached.
    messageSeqRef.current = -1;
    messagesRef.current = messagesRef.current.filter((message) => message.seq < turn.seq);
    setMessages(messagesRef.current);
    const attached = turn.parts.filter((part) => part.kind !== "text" && part.kind !== "thinking");
    setPendingUser({
      ...turn,
      id: "pending",
      parts: [{ kind: "text", text }, ...attached],
    });
    try {
      const run = await api.startRun(conversationId, text, attachmentIdsOf(turn), modelId, turn.seq, turn.parts.flatMap((part) => part.kind === "image" && part.referenceRole ? [{ imageId: part.imageId, role: part.referenceRole }] : []));
      await follow(conversationId, run.runId, run.seq, new Set());
    } catch (error) {
      setRunning(false);
      setPendingUser(null);
      toast(error instanceof Error ? error.message : String(error), true);
      await syncMessages(conversationId, false).catch(() => undefined);
    }
  };

  const resume = async () => {
    if (!conversationId || running) return;
    setRunning(true);
    stickyRef.current = true;
    try {
      const run = await api.continueRun(conversationId);
      await follow(conversationId, run.runId, run.seq, new Set());
    } catch (error) {
      setRunning(false);
      toast(error instanceof Error ? error.message : String(error), true);
    }
  };

  const stop = async () => {
    if (!conversationId) return;
    try {
      await api.stopRun(conversationId);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true);
    }
  };

  const visibleTurns = [...turns, ...(pendingUser ? [pendingUser] : []), ...(live ? [live] : [])];
  // Rewinding mid-run would race the run that is writing the transcript, and
  // only the newest answer has anything meaningful to continue from.
  const lastUserTurn = turns.filter((turn) => turn.role === "user").at(-1);
  const canAct = Boolean(conversationId) && !running && !pendingUser && !live;

  // The conversation's own model is always an option, even when it is unpinned
  // or no longer in the catalogue, so the control never shows a blank trigger.
  const modelOptions = [
    ...(modelId && !listedModels.some((model) => model.id === modelId)
      ? [{ value: modelId, label: current?.name ?? modelId, hint: current ? uiText("未固定") : uiText("当前模型") }]
      : []),
    ...listedModels.map((model) => ({
      value: model.id,
      label: model.name,
      hint: `${model.providerId} · ${model.input.includes("image") ? uiText("可看图") : uiText("仅文字")}`,
    })),
  ];

  const chooseModel = async (next: string) => {
    try {
      if (conversationId) await api.setConversationModel(conversationId, next);
      if (openConversationRef.current === conversationId) setModelId(next);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true);
    }
  };

  const saveConversationContext = async () => {
    if (!conversationId) {
      toast(uiText("先发送第一条消息，创建对话后再设置角色"), true);
      return;
    }
    setSavingContext(true);
    try {
      const saved = await api.setConversationContext(conversationId, { roleplay, visualContinuity, projectId });
      setProjectId(saved.projectId ?? null);
      setRoleplay(saved.roleplay);
      setVisualContinuity(saved.visualContinuity);
      setPicking(false);
      toast(uiText("对话设定已保存"));
      await onConversationChanged();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true);
    } finally {
      setSavingContext(false);
    }
  };

  const pinLastVisual = (role: VisualReferenceRole) => {
    const imageId = visualContinuity.lastImageId;
    if (!imageId) return;
    const labels: Record<VisualReferenceRole, string> = {
      subject: uiText("主体参考"),
      scene: uiText("场景参考"),
      style: uiText("风格参考"),
    };
    setVisualContinuity((current) => {
      if (current.references.some((reference) => reference.imageId === imageId && reference.role === role)) {
        return current;
      }
      if (current.references.length >= 3) {
        toast(uiText("最多固定 3 个参考；请先移除一个"), true);
        return current;
      }
      return {
        ...current,
        enabled: true,
        references: [...current.references, { imageId, role, label: labels[role] }],
      };
    });
  };

  const openConversationSettings = () => {
    setPicking(true);
    if (!conversationId) return;
    void api.backgroundTasks(conversationId).then(({ items }) => setBackgroundTasks(items)).catch(() => undefined);
  };

  useEffect(() => {
    if (conversationId) return;
    const pending = takeChatAttachment();
    if (!pending) return;
    setAttachments([pending.file]);
    setReferenceRoles({ [pending.file.id]: pending.role });
    textareaRef.current?.focus();
  }, [conversationId]);

  const modelSelect = (className: string) => (
    <Select
      value={modelId}
      className={className}
      placeholder={uiText("未配置模型")}
      options={modelOptions}
      onChange={(next) => void chooseModel(next)}
    />
  );

  const useViewedImage = async (role: ImageReferenceRole) => {
    const id = assetIdOf(zoom);
    if (!id) return;
    if (!attachments.some(file => file.id === id) && attachments.length >= bootstrap.limits.maxAttachmentsPerMessage) { toast(uiText("已达到本条消息附件上限"), true); return; }
    try {
      const file = await api.file(id);
      setAttachments(current => current.some(item => item.id === id) ? current : [...current, file]);
      setReferenceRoles(current => ({ ...Object.fromEntries(Object.entries(current).map(([key,value]) => [key, role === "base" && value === "base" ? "context" : value])), [id]: role }));
      setZoom("");
      textareaRef.current?.focus();
    } catch (error) { toast(error instanceof Error ? error.message : String(error), true); }
  };

  return (
    <>
      <header className="flex h-16 shrink-0 items-center gap-2 px-3 md:px-6">
        <Button variant="ghost" size="icon" className="md:hidden" aria-label={uiText("菜单")} onClick={onOpenRail}>
          <MenuIcon />
        </Button>
        <div className="min-w-0 flex-1">
          {modelSelect("max-w-full border-0 bg-transparent text-base font-medium shadow-none sm:max-w-72")}
        </div>
        {conversationId ? <Menu trigger={<Button variant="ghost" size="icon" aria-label={uiText("对话操作")}><MoreHorizontal /></Button>}>
          <MenuItem disabled={running} onSelect={() => setShowTree(true)}>{uiText("查看版本与分支")}</MenuItem>
          <MenuItem disabled={running} onSelect={async () => { try { setRunning(true); const run = await api.compactConversation(conversationId); await follow(conversationId, run.runId, run.seq, new Set()); } catch (error) { setRunning(false); toast(error instanceof Error ? error.message : String(error), true); } }}>{uiText("整理上下文")}</MenuItem>
        </Menu> : null}
        <Button variant="ghost" size="sm" aria-label={uiText("任务与成果")} onClick={() => setShowTasks(true)}><ListTodo />{uiText("任务与成果")}{backgroundTasks.some(task => ["pending", "running"].includes(task.status)) ? " ·" : ""}</Button>
        {showTree && conversationId ? <ConversationTree id={conversationId} onClose={() => setShowTree(false)} onFork={onConversationCreated} /> : null}

        <Button
          variant="ghost"
          size="icon"
          aria-label={uiText("本次对话的设置")}
          onClick={openConversationSettings}
        >
          <SlidersHorizontal />
        </Button>

        {running ? (
          <Button variant="danger" size="sm" onClick={() => void stop()}>
            <Square />
            {uiText("停止")}</Button>
        ) : null}
      </header>

      <div
        className={cn("min-h-0 overflow-y-auto overscroll-contain", visibleTurns.length ? "flex-1" : "mt-[clamp(2rem,16vh,10rem)] shrink-0")}
        ref={threadRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickyRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
        }}
      >
        {visibleTurns.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 px-6 pb-8 text-center">
            <h1 className="text-3xl font-medium tracking-tight sm:text-4xl">{uiText("今天，想做点什么？")}</h1>
            <p className="max-w-md text-sm text-muted-foreground">{uiText("从一个想法、一张图片，或一句话开始。")}</p>
          </div>
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-5 py-6 sm:px-6" ref={watchContent}>
            {title ? <p className="text-center text-xs text-muted-foreground">{title}</p> : null}
            {visibleTurns.map((turn, index) => (
              <TurnView
                key={`${turn.id}-${index}`}
                turn={turn}
                citations={turn === live ? citations : citationsByTurn.get(turn) ?? settledCitations}
                onFeedback={conversationId && turn.role === "assistant" ? async text => { await api.saveFeedback(conversationId, turn.seq, text); setFeedbackRevision(n => n + 1); } : undefined}
                streaming={running && turn === live}
                onImageClick={setZoom}
                editing={turn.role === "user" && turn.seq === editingSeq}
                onEdit={canAct && turn.role === "user" ? () => setEditingSeq(turn.seq) : undefined}
                onCancelEdit={() => setEditingSeq(null)}
                onSubmitEdit={(text) => void replay(turn, text)}
                onRegenerate={
                  canAct && lastUserTurn && turn === visibleTurns.at(-1) && turn.role === "assistant"
                    ? () => void replay(lastUserTurn, turnText(lastUserTurn))
                    : undefined
                }
                onContinue={canAct && turn === visibleTurns.at(-1) && turn.role === "assistant" ? resume : undefined}
              />
            ))}
          </div>
        )}
      </div>

      <div className={cn("shrink-0 bg-background px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6", !visibleTurns.length && "mb-auto")}>
        <div
          className={cn(
            "mx-auto flex w-full max-w-3xl flex-col gap-3 rounded-[28px] border border-border/60 bg-card p-3 shadow-[0_4px_24px_#00000008] transition-colors sm:p-4",
            dragging && "border-primary bg-accent/40",
          )}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (event.dataTransfer.files.length) void attach(event.dataTransfer.files);
          }}
        >
          {attachments.length ? (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {attachments.map((file) => (
                <span
                  key={file.id}
                  className="relative flex w-60 shrink-0 flex-wrap items-center gap-2 rounded-2xl bg-secondary p-2 pr-7 text-xs"
                >
                  {file.mime.startsWith("image/") ? (
                    <img src={`/v1/images/${file.id}?w=160`} alt={file.name} className="size-14 rounded object-contain" />
                  ) : (
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="max-w-32 truncate">{file.name}</span>
                  {file.mime.startsWith("image/") && referenceRoles[file.id] && referenceRoles[file.id] !== "context" ? (
                    <span className="text-muted-foreground">{IMAGE_REFERENCE_ROLES[referenceRoles[file.id]!]}</span>
                  ) : null}
                  <span className="text-muted-foreground">{formatBytes(file.bytes)}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="absolute top-1 right-1 size-5 rounded-full"
                    aria-label={uiText("移除 {0}", [file.name])}
                    onClick={() => setAttachments((current) => current.filter((item) => item.id !== file.id))}
                  >
                    <X />
                  </Button>
                </span>
              ))}
            </div>
          ) : null}

          <Textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            data-testid="composer-input"
            enterKeyHint={touch ? "enter" : "send"}
            className="max-h-55 min-h-12 resize-none border-0 bg-transparent px-1.5 py-2 text-base shadow-none focus-visible:ring-0"
            placeholder={
              running
                ? runningInstruction === "steer"
                  ? uiText("补充方向，当前回合结束后立即生效")
                  : uiText("写下当前回答结束后要继续做的事")
                : uiText("向 Uncensia 提问，或描述你想创作的内容")
            }
            onChange={(event) => {
              setDraft(event.target.value);
              const element = event.target;
              element.style.height = "auto";
              element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files);
              if (files.length) {
                event.preventDefault();
                void attach(files);
              }
            }}
            onKeyDown={(event) => {
              // On a touch keyboard Enter is the only way to reach a newline,
              // so it must never be stolen; sending is the button's job there.
              if (touch) return;
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (running) void queueDuringRun();
                else void send();
              }
            }}
          />

          <div className="flex items-center gap-2">
            {running ? (
              <>
                <div className="flex rounded-md bg-secondary p-0.5" role="group" aria-label={uiText("运行中指令类型")}>
                  <Button
                    variant={runningInstruction === "steer" ? "outline" : "ghost"}
                    size="sm"
                    className="h-7 border-0 px-2"
                    aria-pressed={runningInstruction === "steer"}
                    onClick={() => setRunningInstruction("steer")}
                  >
                    {uiText("转向")}</Button>
                  <Button
                    variant={runningInstruction === "follow-up" ? "outline" : "ghost"}
                    size="sm"
                    className="h-7 border-0 px-2"
                    aria-pressed={runningInstruction === "follow-up"}
                    onClick={() => setRunningInstruction("follow-up")}
                  >
                    {uiText("回答后")}</Button>
                </div>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {runningInstruction === "steer" ? uiText("改变接下来的方向") : uiText("排队下一条指令")}
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  data-testid="composer-queue"
                  disabled={!draft.trim()}
                  onClick={() => void queueDuringRun()}
                >
                  <CornerDownLeft />
                  {uiText("加入")}</Button>
              </>
            ) : (
              <>
                <Tooltip label={uiText("添加附件")}>
                  <label className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
                    <Paperclip className="size-4" />
                    {/* `sr-only` rather than `hidden`: a hidden input is out of the
                        accessibility tree, which leaves the control unreachable by
                        keyboard since the label cannot take focus itself. */}
                    <input
                      type="file"
                      multiple
                      className="sr-only"
                      aria-label={uiText("添加附件")}
                      onChange={(event) => {
                        if (event.target.files?.length) void attach(event.target.files);
                        event.target.value = "";
                      }}
                    />
                  </label>
                </Tooltip>
                <Button variant="ghost" size="sm" onClick={() => setPickingAsset(true)}>{uiText("引用资料")}</Button>
                {pickingAsset ? <AssetPicker onClose={() => setPickingAsset(false)} onSelect={(file) => {
                  if (attachments.length >= bootstrap.limits.maxAttachmentsPerMessage) { toast(uiText("已达到本条消息附件上限"), true); return; }
                  setAttachments((current) => current.some((item) => item.id === file.id) ? current : [...current, file]);
                  setPickingAsset(false);
                }} /> : null}
                {uploading ? <Spinner className="text-muted-foreground" /> : null}
                <span className="flex-1" />
                <Button
                  variant="primary"
                  size="sm"
                  data-testid="composer-send"
                  aria-label={uiText("发送消息")}
                  className="size-9 rounded-full p-0"
                  disabled={!draft.trim()}
                  onClick={() => void send()}
                >
                  <ArrowUp />
                </Button>
              </>
            )}
          </div>
        </div>

        {!visibleTurns.length ? <div className="mx-auto mt-5 flex max-w-3xl flex-wrap justify-center gap-2">
          {[{label:uiText("写点东西"), text:uiText("帮我把一个故事想法写成开场：")}, {label:uiText("创作图片"), text:uiText("生成一张图片：")}].map(item => <Button key={item.label} variant="outline" className="rounded-full px-4 text-sm text-muted-foreground" onClick={() => { setDraft(item.text); textareaRef.current?.focus(); }}><Sparkles />{item.label}</Button>)}
          <Button variant="outline" className="rounded-full px-4 text-sm text-muted-foreground" onClick={() => setPickingAsset(true)}><FileText />{uiText("使用我的资料")}</Button>
        </div> : <p className="mx-auto mt-2 max-w-3xl text-center text-[11px] text-muted-foreground">{running ? uiText("你可以随时停止，或继续补充要求") : uiText("重要内容请核对。图片与文件可在资料库中继续使用。")}</p>}
      </div>

      <Modal open={showTasks} onOpenChange={setShowTasks} title={uiText("任务与成果")} description={uiText("安排时间、持续推进，随时查看进度和结果。")}>
        {conversationId ? <ConversationEvidence key={conversationId} id={conversationId} revision={`${messages.length}:${running}:${feedbackRevision}`} /> : null}
        <TaskPanel key={conversationId || "new"} conversationId={conversationId || undefined} modelId={modelId} onCreated={task => {
          setBackgroundTasks(current => [task, ...current]);
          if (!conversationId) onConversationCreated(task.conversationId);
        }} />
      </Modal>

      <Modal open={picking} onOpenChange={setPicking} title={uiText("本次对话")} description={uiText("直接说出需求即可开始。这里的资料可选，只用于这段对话。")} footer={
        <Button variant="primary" disabled={!conversationId || savingContext} onClick={() => void saveConversationContext()}>
          {savingContext ? <Spinner /> : null}
          {uiText("保存对话设定")}</Button>
      }>
        <div className="flex max-h-[75dvh] flex-col gap-4 overflow-y-auto pr-1">
          <Field label={uiText("模型")}>{modelSelect("w-full")}</Field>
          <Field label={uiText("所属项目")} hint={uiText("切换后使用所选项目的说明与资料；已有对话历史保留。工具的文件系统工作目录不受影响。") }>
            <select aria-label={uiText("所属项目")} className="w-full rounded border bg-background p-2 text-sm" disabled={running || !conversationId} value={projectId ?? ""} onChange={e=>setProjectId(e.target.value || null)}>
              <option value="">{uiText("普通对话（未归属项目）")}</option>
              {projects.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
            {projectId ? <a className="text-sm underline" href={`/projects/${projectId}`}>{uiText("打开项目")}</a> : null}
          </Field>
          <Switch
            label={uiText("使用保存的故事资料")}
            hint={uiText("需要复用人物、背景或文风时再填写。聊天中也能直接开始写作或角色互动，随时可以问普通问题。")}
            checked={roleplay.enabled}
            onChange={(enabled) => setRoleplay((current) => ({ ...current, enabled }))}
          />
          {roleplay.enabled ? (
            <>
              <CharacterCardImport onApply={card => setRoleplay(current => ({ ...current, character: card.character, scene: card.scene, examples: card.examples }))} />
              <Field label={uiText("角色")} hint={uiText("身份、性格、说话方式与关系")}>
                <Textarea
                  rows={4}
                  value={roleplay.character}
                  placeholder={uiText("她是谁，怎样说话，与你是什么关系……")}
                  onChange={(event) => setRoleplay((current) => ({ ...current, character: event.target.value }))}
                />
              </Field>
              <Field label={uiText("你的身份")} hint={uiText("你在这段对话或故事中的身份")}>
                <Textarea
                  rows={2}
                  value={roleplay.persona}
                  placeholder={uiText("我是谁，与角色有什么关系……")}
                  onChange={(event) => setRoleplay((current) => ({ ...current, persona: event.target.value }))}
                />
              </Field>
              <Field label={uiText("世界设定")} hint={uiText("长期稳定的地点、规则、人物与背景")}>
                <Textarea
                  rows={4}
                  value={roleplay.world}
                  placeholder={uiText("世界的长期事实……")}
                  onChange={(event) => setRoleplay((current) => ({ ...current, world: event.target.value }))}
                />
              </Field>
              <Field label={uiText("场景笔记")} hint={uiText("保存时间、地点和未完成的事。后续对话发生的变化优先于这里的旧笔记；可随时手动更新。")}>
                <Textarea
                  rows={4}
                  value={roleplay.scene}
                  placeholder={uiText("此刻在哪里，正在发生什么……")}
                  onChange={(event) => setRoleplay((current) => ({ ...current, scene: event.target.value }))}
                />
              </Field>
              <Field label={uiText("写作方式")} hint={uiText("视角、篇幅、对白比例、格式与节奏")}>
                <Textarea
                  rows={3}
                  value={roleplay.style}
                  placeholder={uiText("例如：第二人称、对白为主、每次推进一个动作……")}
                  onChange={(event) => setRoleplay((current) => ({ ...current, style: event.target.value }))}
                />
              </Field>
              <Field label={uiText("示例对白")} hint={uiText("只用来示范语气，不会作为已经发生的剧情。")}>
                <Textarea
                  rows={3}
                  value={roleplay.examples ?? ""}
                  placeholder={uiText("放一小段能体现角色说话方式的对白……")}
                  onChange={(event) => setRoleplay((current) => ({ ...current, examples: event.target.value }))}
                />
              </Field>
            </>
          ) : null}

          <div className="border-t pt-4">
            <Switch
              label={uiText("使用固定的图片参考")}
              hint={uiText("按需保存喜欢的人物、场景和风格。也可以直接在聊天中选择参考图，每次以你当前的要求为准。")}
              checked={visualContinuity.enabled}
              onChange={(enabled) => setVisualContinuity((current) => ({ ...current, enabled }))}
            />
          </div>
          {visualContinuity.enabled ? (
            <>
              <Field label={uiText("视觉圣经")} hint={uiText("只写需要长期保持的外貌、服装、场景与镜头事实；每一镜的变化仍在聊天里说")}>
                <Textarea
                  rows={4}
                  value={visualContinuity.description}
                  placeholder={uiText("例如：黑色齐耳短发；银色雨衣；暖色夜市灯；写实 35mm 纪录片质感……")}
                  onChange={(event) =>
                    setVisualContinuity((current) => ({ ...current, description: event.target.value }))
                  }
                />
              </Field>
              {visualContinuity.lastImageId ? (
                <div className="rounded-lg border p-3">
                  <p className="text-sm font-medium">{uiText("上一张成功图片")}</p>
                  <div className="mt-2 flex items-start gap-3">
                    <img
                      className="size-20 shrink-0 cursor-zoom-in rounded-md border object-cover"
                      src={`/v1/images/${visualContinuity.lastImageId}?w=240`}
                      alt={uiText("上一张成功图片")}
                      loading="lazy"
                      decoding="async"
                      onClick={() => setZoom(`/v1/images/${visualContinuity.lastImageId}`)}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-3 text-xs text-muted-foreground">
                        {visualContinuity.lastPrompt || uiText("提示词未记录")}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <Button size="sm" variant="secondary" onClick={() => pinLastVisual("subject")}>{uiText("固定主体")}</Button>
                        <Button size="sm" variant="secondary" onClick={() => pinLastVisual("scene")}>{uiText("固定场景")}</Button>
                        <Button size="sm" variant="secondary" onClick={() => pinLastVisual("style")}>{uiText("固定风格")}</Button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                  {uiText("还没有成功图片。先生成开场图；之后“继续上一张”会自动使用这里的状态。")}</p>
              )}
              {visualContinuity.references.length ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm font-medium">{uiText("固定参考（{0}/3）", [visualContinuity.references.length])}</p>
                  {visualContinuity.references.map((reference) => (
                    <div key={`${reference.role}:${reference.imageId}`} className="flex items-center gap-2 rounded-md bg-muted/50 p-2">
                      <img
                        className="size-12 shrink-0 cursor-zoom-in rounded object-cover"
                        src={`/v1/images/${reference.imageId}?w=160`}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        onClick={() => setZoom(`/v1/images/${reference.imageId}`)}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">{reference.label}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setVisualContinuity((current) => ({
                            ...current,
                            references: current.references.filter(
                              (item) => !(item.imageId === reference.imageId && item.role === reference.role),
                            ),
                          }))
                        }
                      >
                        {uiText("移除")}</Button>
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}

        </div>
      </Modal>

      {zoom ? (
        <Lightbox
          src={zoom}
          onClose={() => setZoom("")}
          aside={assetIdOf(zoom) ? <ProvenanceCard assetId={assetIdOf(zoom)} /> : undefined}
          actions={assetIdOf(zoom) ? <>
            <Button variant="ghost" className="rounded-full hover:bg-white/15" disabled={running} onClick={() => void useViewedImage("base")}><Pencil />{uiText("修改")}</Button>
            <Button variant="ghost" className="rounded-full hover:bg-white/15" disabled={running} onClick={() => void useViewedImage("subject")}><ImageIcon />{uiText("作为参考")}</Button>
            <a href={zoom} download className="rounded-full px-4 py-2 text-sm hover:bg-white/15">{uiText("保存")}</a>
          </> : undefined}
        />
      ) : null}
    </>
  );
}

const TurnView = memo(function TurnView({
  turn,
  citations,
  streaming,
  onImageClick,
  editing,
  onEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  onContinue,
  onFeedback,
}: {
  turn: Turn;
  citations: Map<string, Citation>;
  streaming: boolean;
  onImageClick: (src: string) => void;
  editing: boolean;
  onEdit?: () => void;
  onCancelEdit: () => void;
  onSubmitEdit: (text: string) => void;
  onRegenerate?: () => void;
  onContinue?: () => void;
  onFeedback?: (text: string) => Promise<void>;
}) {
  const [feedback, setFeedback] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState("");
  const [feedbackSaved, setFeedbackSaved] = useState(false);
  if (turn.role === "user") {
    const images = turn.parts.filter((part) => part.kind === "image");
    const documents = turn.parts.filter((part) => part.kind === "file");
    const text = turnText(turn);
    return (
      <div className="group flex flex-col items-end gap-2" data-seq={turn.seq} data-testid="turn">
        {images.length ? (
          <div className="flex flex-wrap justify-end gap-2">
            {images.map((part) => (
              <figure key={part.imageId}><img
                className="max-h-50 max-w-50 cursor-zoom-in rounded-lg border object-cover"
                src={`/v1/images/${part.imageId}?w=320`}
                alt=""
                loading="lazy"
                decoding="async"
                onClick={() => onImageClick(`/v1/images/${part.imageId}`)}
              />
              {part.referenceRole ? <figcaption className="mt-1 text-center text-xs text-muted-foreground">{IMAGE_REFERENCE_ROLES[part.referenceRole]}</figcaption> : null}</figure>
            ))}
          </div>
        ) : null}
        {documents.length ? (
          <div className="flex flex-wrap justify-end gap-1.5">
            {documents.map((part) => (
              <FileChip key={part.fileId} part={part} />
            ))}
          </div>
        ) : null}
        {editing ? (
          <MessageEditor text={text} onCancel={onCancelEdit} onSubmit={onSubmitEdit} />
        ) : (
          <>
            {text ? (
              <div className="max-w-[85%] rounded-3xl bg-muted px-5 py-3 whitespace-pre-wrap text-foreground">
                {text}
              </div>
            ) : null}
            {onEdit ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                onClick={onEdit}
              >
                <Pencil />
                {uiText("编辑")}</Button>
            ) : null}
          </>
        )}
      </div>
    );
  }

  const empty = turn.parts.length === 0;
  return (
    <div className="group flex flex-col gap-3" data-seq={turn.seq} data-testid="turn">
      {turn.parts.map((part, index) => {
        if (part.kind === "text") {
          return (
            <Markdown
              key={index}
              text={part.text}
              citations={citations}
              streaming={streaming && index === turn.parts.length - 1}
              onImageClick={onImageClick}
            />
          );
        }
        if (part.kind === "thinking") {
          return (
            <details key={index} className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              <summary className="cursor-pointer text-muted-foreground select-none">{uiText("思考过程")}</summary>
              <div className="mt-2 whitespace-pre-wrap text-muted-foreground">{part.text}</div>
            </details>
          );
        }
        if (part.kind === "image") {
          return (
            <button
              key={index}
              type="button"
              className="w-fit max-w-full cursor-zoom-in rounded-lg focus-visible:outline-2 focus-visible:outline-ring"
              aria-label={uiText("打开生成的图片")}
              onClick={() => onImageClick(`/v1/images/${part.imageId}`)}
            ><img
              className="max-h-150 h-auto w-auto max-w-full object-contain rounded-lg border"
              src={`/v1/images/${part.imageId}?w=1280`}
              alt=""
              loading="lazy"
              decoding="async"
            /></button>
          );
        }
        if (part.kind === "video") {
          return (
            <VideoView
              key={index}
              className="max-h-150"
              videoId={part.videoId}
              posterImageId={part.posterImageId}
              durationMs={part.durationMs}
            />
          );
        }
        if (part.kind === "file") {
          return <FileChip key={index} part={part} />;
        }
        if (part.kind === "approval") {
          return <ApprovalView key={part.approval.id} approval={part.approval} />;
        }
        // Cancelling here would fail the tool call that is waiting on the job,
        // so the card watches without offering a way out of the turn.
        if (part.kind === "job") {
          return <JobCard key={part.jobId} job={part.job} onZoom={onImageClick} />;
        }
        return <ToolView key={index} part={part} onImageClick={onImageClick} />;
      })}

      {turn.cancelled ? <p role="status" className="text-sm text-muted-foreground">{uiText("已停止")}</p> : turn.status ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{turn.status}</p> : null}
      {empty && streaming && !turn.status ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {uiText("正在思考…")}</div>
      ) : null}
      {turn.error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {turn.error}
        </p>
      ) : null}

      {onRegenerate || onContinue || onFeedback ? (
        <div className="flex flex-wrap items-center gap-1 text-muted-foreground">
          {onFeedback ? <Button variant="ghost" size="sm" onClick={() => setFeedback("")}>{feedbackSaved ? uiText("反馈已保存") : uiText("反馈")}</Button> : null}
          {onRegenerate ? (
            <Button variant="ghost" size="sm" onClick={onRegenerate}>
              <RefreshCw />
              {uiText("重新生成")}</Button>
          ) : null}
          {onContinue ? (
            <Button variant="ghost" size="sm" onClick={onContinue}>
              {uiText("继续")}</Button>
          ) : null}
          <CopyButton text={turnText(turn)} />
        </div>
      ) : null}
      {feedback !== null && onFeedback ? <div className="flex flex-col gap-2 rounded-lg border p-3">
        <Textarea aria-label={uiText("反馈")} value={feedback} onChange={e => setFeedback(e.target.value)} maxLength={4000} />
        {feedbackError ? <p role="alert">{feedbackError}</p> : null}
        <div className="flex gap-2"><Button size="sm" disabled={!feedback.trim()} onClick={() => void onFeedback(feedback).then(() => { setFeedback(null); setFeedbackSaved(true); }).catch(e => setFeedbackError(String(e)))}>{uiText("保存")}</Button><Button size="sm" variant="ghost" onClick={() => setFeedback(null)}>{uiText("取消")}</Button></div>
      </div> : null}
    </div>
  );
});

/**
 * An attachment with nothing to preview. The name is all there is to recognise
 * it by, and the link is the only way back to the bytes the turn was given.
 */
function FileChip({ part }: { part: FilePart }) {
  return (
    <a
      className="flex w-fit items-center gap-1.5 rounded-md bg-secondary px-2 py-1 text-xs transition-colors hover:bg-secondary/70"
      href={`/v1/files/${part.fileId}/content`}
      download={part.name}
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="max-w-50 truncate">{part.name}</span>
      {part.bytes ? <span className="text-muted-foreground">{formatBytes(part.bytes)}</span> : null}
    </a>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1_200);
      }}
    >
      {copied ? <Check /> : <Copy />}
      {copied ? uiText("已复制") : uiText("复制")}
    </Button>
  );
}

function MessageEditor({
  text,
  onCancel,
  onSubmit,
}: {
  text: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(text);
  const touch = useTouchPrimary();

  return (
    <div className="flex w-full flex-col gap-2">
      <Textarea
        value={draft}
        autoFocus
        rows={Math.min(12, draft.split("\n").length + 1)}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onCancel();
          if (touch) return;
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onSubmit(draft);
          }
        }}
      />
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto text-xs text-muted-foreground">{uiText("这条之后的回答会被重新生成")}</span>
        <Button size="sm" onClick={onCancel}>
          {uiText("取消")}</Button>
        <Button variant="primary" size="sm" disabled={!draft.trim()} onClick={() => onSubmit(draft)}>
          {uiText("保存并重新生成")}</Button>
      </div>
    </div>
  );
}

const ACTION_LABELS: Record<string, string> = {
  delete: uiText("删除文件"),
  delete_recursive: uiText("递归删除"),
  overwrite: uiText("覆盖文件"),
  move: uiText("移动文件"),
  move_overwrite: uiText("移动并覆盖"),
  shell: uiText("运行命令"),
};

const DETAIL_LABELS: Record<string, string> = {
  path: uiText("路径"),
  from: uiText("源"),
  to: uiText("目标"),
  files: uiText("文件数"),
  bytes: uiText("大小"),
  currentBytes: uiText("当前大小"),
  newBytes: uiText("写入大小"),
  command: uiText("命令"),
  workspace: uiText("工作区"),
  reason: uiText("原因"),
};

/**
 * The question itself. It is deliberately not a modal: the reader needs the
 * tool calls above it to judge what the model is doing, and a dialog that
 * covers them turns the decision into a guess.
 */
function ApprovalView({ approval }: { approval: Approval }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const pending = approval.status === "pending";

  const decide = async (approved: boolean) => {
    setBusy(true);
    try {
      // The row is the source of truth, so nothing is set locally; the run's
      // own `tool.approval.resolved` event repaints this card.
      await api.decideApproval(approval.id, approved);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
    }
  };

  const entries = Object.entries(approval.detail ?? {}).filter(
    ([key, value]) => DETAIL_LABELS[key] && value !== "" && value !== undefined && value !== null,
  );
  const recoverable = approval.detail?.recoverable === true;

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border p-3",
        pending ? "border-warning/50 bg-warning/8" : "bg-muted/40",
      )}
      data-approval={approval.id}
      data-status={approval.status}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={pending ? "warning" : "neutral"}>{ACTION_LABELS[approval.action] ?? approval.action}</Badge>
        <span className="text-sm">{approval.summary}</span>
      </div>

      {entries.length ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {entries.map(([key, value]) => (
            <div key={key} className="col-span-2 grid grid-cols-subgrid">
              <dt className="text-muted-foreground">{DETAIL_LABELS[key]}</dt>
              {/* The command wraps rather than clipping: this card is the only
                  thing standing between the model and an arbitrary shell, and a
                  reader cannot approve what the column cut off. */}
              <dd className="min-w-0 whitespace-pre-wrap break-all font-mono">
                {key === "bytes" || key === "currentBytes" || key === "newBytes"
                  ? formatBytes(Number(value))
                  : String(value)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {pending ? (
        <div className="flex items-center gap-2">
          <span className="mr-auto text-xs text-muted-foreground">
            {recoverable ? uiText("可通过 restore_file 恢复") : uiText("无法自动恢复")}
          </span>
          <Button size="sm" disabled={busy} onClick={() => void decide(false)}>
            {uiText("拒绝")}</Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void decide(true)}>
            {uiText("批准执行")}</Button>
        </div>
      ) : (
        <span className={cn("text-xs", approval.status === "approved" ? "text-success" : "text-muted-foreground")}>
          {approval.status === "approved"
            ? uiText("已批准")
            : approval.status === "expired"
              ? uiText("已超时，未执行")
              : uiText("已拒绝，未执行")}
        </span>
      )}
    </div>
  );
}
