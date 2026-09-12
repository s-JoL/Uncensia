import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type AgentMessage,
  type TruncationOptions,
} from "@earendil-works/pi-agent-core";
import type { ImageReferenceRole } from "@shared/types.ts";

/**
 * Pi promotes another model's thinking to assistant text during serialization.
 * That is useful for coding handoffs, but in a conversation it can make the
 * next model continue an old deliberation instead of the latest request.
 * Keep same-model reasoning/signatures for protocol replay; leave tool-call
 * signature and ID conversion to Pi. Never modify the durable transcript.
 */
export function omitForeignThinking(messages: AgentMessage[], model: { id: string; api: string; provider: string }): AgentMessage[] {
  return messages.flatMap(message => {
    if (message.role !== "assistant" ||
      (message.model === model.id && message.api === model.api && message.provider === model.provider) ||
      !message.content?.some(part => part.type === "thinking")) return [message];
    const content = message.content.filter(part => part.type !== "thinking");
    return content.length ? [{ ...message, content }] : [];
  });
}

export interface ImageRef {
  type: "image_ref";
  image_id: string;
  mime_type: string;
  width?: number | null;
  height?: number | null;
  parent_image_ids?: string[];
  provider?: string | null;
  model?: string | null;
  reference_role?: ImageReferenceRole;
}

export function imageRef(meta: unknown): ImageRef | undefined {
  const value = meta as Record<string, unknown> | null;
  const id = typeof value?.image_id === "string" ? value.image_id : "";
  if (!/^img_[0-9a-f]{32}$/i.test(id)) return undefined;
  return {
    type: "image_ref",
    image_id: id.toLowerCase(),
    mime_type: String(value?.mime_type ?? "image/png"),
    width: (value?.width as number | null) ?? null,
    height: (value?.height as number | null) ?? null,
    parent_image_ids: Array.isArray(value?.parent_image_ids) ? (value.parent_image_ids as string[]) : [],
    provider: (value?.provider as string | null) ?? null,
    model: (value?.model as string | null) ?? null,
    reference_role: value?.reference_role as ImageReferenceRole | undefined,
  };
}

export interface VideoRef {
  type: "video_ref";
  video_id: string;
  mime_type: string;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
  poster_image_id?: string | null;
  provider?: string | null;
  model?: string | null;
}

export function videoRef(meta: unknown): VideoRef | undefined {
  const value = meta as Record<string, unknown> | null;
  const id = typeof value?.video_id === "string" ? value.video_id : "";
  if (!/^vid_[0-9a-f]{32}$/i.test(id)) return undefined;
  return {
    type: "video_ref",
    video_id: id.toLowerCase(),
    mime_type: String(value?.mime_type ?? "video/mp4"),
    width: (value?.width as number | null) ?? null,
    height: (value?.height as number | null) ?? null,
    duration_ms: (value?.duration_ms as number | null) ?? null,
    poster_image_id: (value?.poster_image_id as string | null) ?? null,
    provider: (value?.provider as string | null) ?? null,
    model: (value?.model as string | null) ?? null,
  };
}

/**
 * A document attached to a turn: anything that is neither picture nor clip.
 *
 * It carries its name and size because there is nothing to recognise it by
 * otherwise — a client has no thumbnail for a PDF, and the model is being told
 * a file exists rather than shown its contents. The bytes themselves are never
 * here. Current attachments supply extracted text separately; later retrieval
 * uses this exact file id to scope `file_search`.
 */
export interface FileRef {
  type: "file_ref";
  file_id: string;
  name: string;
  mime_type: string;
  bytes?: number | null;
}

/**
 * Appends references to a persisted message's content. An image arrives as a
 * base64 part that `persistMessage` swaps for its ref, but a video and a
 * document have no inline binary part to replace. Attached document text is
 * supplied separately in the current turn's context.
 */
export function withAppendedRef(persisted: unknown, ref: VideoRef | ImageRef | FileRef) {
  return withAppendedRefs(persisted, [ref]);
}

export function withAppendedRefs(persisted: unknown, refs: Array<VideoRef | ImageRef | FileRef>) {
  const record = persisted as { content?: unknown } | null;
  if (!record || typeof record !== "object" || !refs.length) return persisted;
  const content = Array.isArray(record.content)
    ? [...record.content, ...refs]
    : [{ type: "text", text: String(record.content ?? "") }, ...refs];
  return { ...record, content };
}

/** Strips base64 payloads so an event can be logged or sent to a browser. */
export function transportSafe(value: unknown, replacement?: ImageRef): unknown {
  if (Array.isArray(value)) return value.map((item) => transportSafe(item, replacement));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.type === "image" && typeof record.data === "string") {
    return (
      replacement ?? {
        type: "image_omitted",
        mime_type: record.mimeType,
        byte_length: Math.floor(record.data.length * 0.75),
      }
    );
  }
  if (value instanceof Error) return { name: value.name, message: value.message };
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, transportSafe(item, replacement)]),
  );
}

/**
 * pi's ceiling on one tool output, reused rather than restated: whichever of
 * 2000 lines or 50 KB is hit first, always cut on a line boundary. Bytes matter
 * because the previous single character count let a Chinese result through at
 * roughly three times the byte cost of an English one of the same length.
 *
 * The two limits below start equal and are deliberately separate constants,
 * because they answer different questions. Bounding what the model re-reads is
 * recoverable — the next turn projects the same stored result again — while the
 * persisted bound must first save the original through the runtime's file
 * writer, so a bounded transcript never becomes the only copy.
 */
const PERSISTED_TOOL_RESULT: TruncationOptions = { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES };
const PROJECTED_TOOL_RESULT: TruncationOptions = { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES };

const truncate = (text: string, limits: TruncationOptions) => {
  const bounded = truncateHead(text, limits);
  if (!bounded.truncated) return text;
  const omitted = bounded.totalBytes - bounded.outputBytes;
  const reason = bounded.truncatedBy === "lines" ? `${bounded.maxLines} lines` : formatSize(bounded.maxBytes);
  return `${bounded.content}\n…[truncated at ${reason}, ${formatSize(omitted)} omitted]`;
};

export function compactToolText(value: unknown, limits: TruncationOptions, preserve?: (text: string) => string): unknown {
  if (Array.isArray(value)) return value.map((item) => compactToolText(item, limits, preserve));
  if (!value || typeof value !== "object") {
    if (typeof value !== "string") return value;
    const preview = truncate(value, limits);
    return preserve && preview !== value ? `${preserve(value)}\n${preview}` : preview;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, compactToolText(item, limits, preserve)]),
  );
}

/**
 * Bounds every tool result in the context sent to the model. Applied at
 * assembly rather than at the tool, so what the current turn streams to the
 * client is still the whole result.
 *
 * Only text is cut. An image part's base64 is not prose, and a truncated one is
 * a broken picture rather than a shorter one.
 */
export function boundToolResults(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if ((message as { role?: string }).role !== "toolResult") return message;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      return { ...message, content: truncate(content, PROJECTED_TOOL_RESULT) } as AgentMessage;
    }
    if (!Array.isArray(content)) return message;
    return {
      ...message,
      content: content.map((part) => {
        const record = part as Record<string, unknown>;
        return record?.type === "text" && typeof record.text === "string"
          ? { ...record, text: truncate(record.text, PROJECTED_TOOL_RESULT) }
          : part;
      }),
    } as AgentMessage;
  });
}

/** Converts an in-flight message into its durable form: no base64, ever. */
export function persistMessage(message: unknown, imageRefs: ImageRef[] = [], preserve?: (text: string) => string) {
  let imageIndex = 0;
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (record.type === "image" && typeof record.data === "string") {
      return (
        imageRefs[imageIndex++] ?? {
          type: "image_omitted",
          mime_type: record.mimeType,
          byte_length: Math.floor(record.data.length * 0.75),
        }
      );
    }
    return Object.fromEntries(
      Object.entries(record)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, visit(item)]),
    );
  };
  const persisted = visit(message);
  return (message as { role?: string } | null)?.role === "toolResult"
    ? compactToolText(persisted, PERSISTED_TOOL_RESULT, preserve)
    : persisted;
}

/** The readable text of a message, with images, tool payloads and markers dropped. */
export function messageText(message: unknown) {
  const record = message as { content?: unknown } | null;
  if (!Array.isArray(record?.content)) return typeof record?.content === "string" ? record.content : "";
  return record.content
    .filter((part) => (part as { type?: string })?.type === "text")
    .map((part) => (part as { text?: string }).text ?? "")
    .join("\n");
}

/** Model-only live data: preserve every SDK history entry and tool pairing. */
export function withRuntimeContext(messages: AgentMessage[], context: string): AgentMessage[] {
  if (!context) return messages;
  const suffix = '\n\n<uncensia-current-context>\n' + context + '\n</uncensia-current-context>';
  const lastUser = messages.findLastIndex(message => message.role === 'user');
  if (lastUser < 0) return [...messages, { role: 'user', content: suffix, timestamp: 0 }];
  return messages.map((message, index) => {
    if (index !== lastUser || message.role !== 'user') return message;
    return { ...message, content: typeof message.content === 'string' ? message.content + suffix : [...message.content, { type: 'text' as const, text: suffix }] };
  });
}

const dimensions = (width?: number | null, height?: number | null) =>
  width && height ? ` ${width}x${height}` : "";

/**
 * Renders the media a transcript carries as text the model can read.
 *
 * Pixels enter the context only when the model asks for them by id. The
 * alternative — deciding from the wording of a turn whether it is "about
 * images" and silently re-uploading the last few — was a keyword test that
 * chose wrong in both directions: it missed the request that never said the
 * word, and it paid for three pictures nobody had asked about. These lines are
 * what make asking possible, because they are the only way the model learns
 * that an image exists at all and what its id is.
 */
export function describeRefs(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return message;
    return {
      ...message,
      content: content.map((part) => {
        const record = part as Record<string, unknown>;
        if (record.type === "image_ref") {
          const ref = record as unknown as ImageRef;
          return {
            type: "text",
            text: `[image image_id=${ref.image_id}${dimensions(ref.width, ref.height)} ${ref.mime_type}${ref.reference_role ? ` user_assigned_role=${ref.reference_role}` : ""}]`,
          };
        }
        // A picture that reached the transcript without an id — a tool that
        // returned several images, or one whose id did not survive validation.
        // It cannot be looked at, and saying nothing would be worse: the model
        // would answer as though the turn had been text.
        if (record.type === "image_omitted") {
          return { type: "text", text: `[image unavailable ${String(record.mime_type ?? "image")}]` };
        }
        if (record.type === "video_ref") {
          const ref = record as unknown as VideoRef;
          const seconds = ref.duration_ms ? ` ${(ref.duration_ms / 1000).toFixed(1)}s` : "";
          return {
            type: "text",
            text: `[video video_id=${ref.video_id}${dimensions(ref.width, ref.height)}${seconds} ${ref.mime_type}]`,
          };
        }
        // The document's text is not here. On the turn it arrived, the text is
        // in the prompt; from the next turn on this line is what is left, and it
        // names the id `file_search` can be scoped to. It deliberately does not
        // tell the model to go and search: the earlier wording did, and the
        // model obeyed it on the very turn the document was already in front of
        // it, searching the whole library and reading back other files.
        if (record.type === "file_ref") {
          const ref = record as unknown as FileRef;
          return {
            type: "text",
            text: `[file file_id=${ref.file_id} ${JSON.stringify(ref.name)} ${ref.mime_type} — attached by the user to this message]`,
          };
        }
        return part;
      }),
    } as AgentMessage;
  });
}
