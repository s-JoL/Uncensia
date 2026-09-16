import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { isNoteKey, NOTE_LIMITS, type ConversationNote } from "@shared/types.ts";
import type { Store } from "../store/store.ts";
import { INTENT_DESCRIPTION, UPDATE_NOTES_DESCRIPTION } from "./descriptions.ts";

interface NoteWrite {
  key: string;
  label?: string;
  value: string;
}

/**
 * Per-conversation notes are the data slot behind `contexts: [notes:<key>]` in a
 * skill: the skill decides what state is worth keeping (a relationship ledger,
 * a chapter outline, a scene clock) and this tool lets the assistant keep it
 * current without a memory write or a backend change. The user edits the same
 * rows from the conversation settings sheet, so every write is a full replace
 * of the named keys and is echoed to connected clients.
 */
export function notesTools(store: Store, conversationId: string, onChange: (notes: ConversationNote[]) => void): AgentTool[] {
  const update: AgentTool = {
    name: "update_conversation_notes",
    label: "update_conversation_notes",
    description: UPDATE_NOTES_DESCRIPTION,
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        intent: { type: "string", description: INTENT_DESCRIPTION },
        notes: {
          type: "array",
          description: "Notes to create or replace. Each value replaces the whole note for that key; include everything that should remain.",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: `Stable lowercase slug, e.g. relationship, outline, scene-clock (up to ${NOTE_LIMITS.key} characters).` },
              label: { type: "string", description: "Short title shown to the user in settings; keep the existing label when omitted." },
              value: { type: "string", description: `The full note text (up to ${NOTE_LIMITS.value} characters).` },
            },
            required: ["key", "value"],
          },
        },
        remove: { type: "array", items: { type: "string" }, description: "Keys of notes to delete." },
      },
      required: ["intent"],
    }),
    executionMode: "sequential",
    execute: async (_callId, params) => {
      const { notes = [], remove = [] } = params as { notes?: NoteWrite[]; remove?: string[] };
      const invalid = [...notes.map((note) => note.key), ...remove].filter((key) => typeof key !== "string" || !isNoteKey(key));
      if (invalid.length) {
        return { content: [{ type: "text", text: `Invalid note key(s): ${invalid.join(", ")}. Keys are 1-${NOTE_LIMITS.key} lowercase letters, digits, '-' or '_'.` }], details: {} };
      }
      const oversized = notes.find((note) => typeof note.value !== "string" || note.value.length > NOTE_LIMITS.value);
      if (oversized) {
        return { content: [{ type: "text", text: `Note "${oversized.key}" exceeds ${NOTE_LIMITS.value} characters. Condense it; notes hold current state, not a transcript.` }], details: {} };
      }
      const conversation = store.getConversation(conversationId);
      if (!conversation) return { content: [{ type: "text", text: "This conversation no longer exists." }], details: {} };
      const removed = new Set(remove);
      const next = new Map(conversation.notes.filter((note) => !removed.has(note.key)).map((note) => [note.key, note]));
      for (const note of notes) {
        const existing = next.get(note.key);
        next.set(note.key, {
          key: note.key,
          label: (typeof note.label === "string" ? note.label : existing?.label ?? "").slice(0, NOTE_LIMITS.label),
          value: note.value,
        });
      }
      if (next.size > NOTE_LIMITS.count) {
        return { content: [{ type: "text", text: `A conversation holds at most ${NOTE_LIMITS.count} notes; merge or remove some first.` }], details: {} };
      }
      const saved = store.setConversationNotes(conversationId, [...next.values()]);
      onChange(saved);
      const summary = [
        notes.length ? `Saved: ${notes.map((note) => note.key).join(", ")}.` : "",
        remove.length ? `Removed: ${remove.join(", ")}.` : "",
        `${saved.length} note(s) now saved for this conversation.`,
      ].filter(Boolean).join(" ");
      return { content: [{ type: "text", text: summary }], details: { structuredContent: { notes: saved } } };
    },
  };
  return [update];
}
