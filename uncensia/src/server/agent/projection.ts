import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { Store } from "../store/store.ts";
import type { Sessions } from "./sessions.ts";

/**
 * The transcript clients read is a projection of the conversation's tree. This
 * module is the only place that derives one from the other, so there is a single
 * answer to "what does the reader see" — the message entries on the current
 * branch, in branch order.
 *
 * Compaction and branch-summary entries are deliberately not projected: they
 * shape what the *model* is sent, and showing them as messages would tell the
 * reader their own history had been replaced when it is still all there.
 * Custom messages remain in the projection even when display=false: hiding
 * them is a client presentation choice, not deletion from the branch history.
 */

/** Re-derives the whole transcript from the current branch. */
export async function projectTranscript(store: Store, sessions: Sessions, conversationId: string) {
  const entries = await sessions.entries(conversationId);
  return store.replaceMessages(
    conversationId,
    entries.flatMap(entry => entry.type === "message" || entry.type === "custom_message"
      ? sessionEntryToContextMessages(entry).map(message => ({ message, entryId: entry.id }))
      : []),
  );
}

/**
 * Drops the turn at `fromSeq` and everything after it, which is what editing or
 * regenerating a message asks for.
 *
 * The branch is moved back to the entry before it rather than the entries being
 * deleted: the model then continues from that point, while the abandoned turn
 * stays in the tree where it can still be recovered.
 */
export async function rewindConversation(
  store: Store,
  sessions: Sessions,
  conversationId: string,
  fromSeq: number,
) {
  const entryId = store.messageEntryId(conversationId, fromSeq);
  const session = await sessions.session(conversationId);
  const entry = entryId ? await session.getEntry(entryId) : undefined;
  if (!entry) throw new Error("Message is not linked to a session entry");

  await sessions.rewind(conversationId, entry.parentId);
  return projectTranscript(store, sessions, conversationId);
}
