import type { ConversationSearchHit } from "@shared/types.ts";
import type { Store } from "../store/store.ts";
import { messageText } from "./messages.ts";

const SNIPPET_MARGIN = 80;

/** Search the indexed current transcript without opening or caching SDK trees. */
export async function searchConversations(
  store: Store, query: string, limit: number, signal?: AbortSignal,
): Promise<ConversationSearchHit[]> {
  const text = query.trim();
  if (!text || signal?.aborted) return [];
  const needle = text.toLowerCase();
  return store.searchMessages(text, limit).flatMap(row => {
    const body = messageText(row.content);
    const at = body.toLowerCase().indexOf(needle);
    const conversation = store.getConversation(row.conversationId);
    if (at < 0 || !conversation || signal?.aborted) return [];
    const start = Math.max(0, at - SNIPPET_MARGIN);
    const end = Math.min(body.length, at + text.length + SNIPPET_MARGIN);
    const middle = body.slice(start, end).replace(/\s+/g, " ").trim();
    return [{
      conversationId: row.conversationId, title: conversation.title, seq: row.seq,
      role: row.role, createdAt: row.createdAt,
      snippet: `${start > 0 ? "…" : ""}${middle}${end < body.length ? "…" : ""}`,
    }];
  });
}
