/**
 * Extension dialogs as persisted rows. Pi's `ui.select/confirm/input/editor`
 * expect a person on the other end; here that person is on the web or iOS
 * client, possibly in a different tab from the one that started the run, and
 * possibly reconnecting later. The row is therefore the dialog, exactly as an
 * approval row is the decision, and the registry only wakes the parked call.
 */
import type { Question, QuestionKind, QuestionStatus } from "@shared/types.ts";
import type { Store } from "../store/store.ts";

/** Same default as approvals: long enough to step away, short enough that a forgotten run ends. */
const QUESTION_TIMEOUT_MS = 15 * 60 * 1000;

export interface QuestionInput {
  kind: QuestionKind;
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
}

/** The answer Pi's dialog API gets: chosen text, or `undefined` when the dialog was dismissed. */
export function dialogResult(question: Question): string | undefined {
  return question.status === "answered" && question.answer !== null ? question.answer : undefined;
}

export class QuestionRegistry {
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly timeoutMs = QUESTION_TIMEOUT_MS) {}

  notify(id: string) {
    for (const wake of [...(this.waiters.get(id) ?? [])]) wake();
  }

  get pending() {
    return this.waiters.size;
  }

  /**
   * Parks until the row leaves `pending`. Abort settles it as dismissed and a
   * timeout as expired, so a reconnecting client never sees a card that still
   * offers an answer nobody can receive.
   */
  async wait(store: Store, id: string, signal?: AbortSignal, timeoutMs = this.timeoutMs): Promise<Question> {
    const current = store.getQuestion(id);
    if (!current) throw new Error(`Unknown question ${id}`);
    if (current.status !== "pending") return current;

    return new Promise<Question>((resolve) => {
      const done = (question: Question) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const set = this.waiters.get(id);
        set?.delete(wake);
        if (set && !set.size) this.waiters.delete(id);
        resolve(question);
      };
      const settle = (status: Exclude<QuestionStatus, "pending" | "answered">) => {
        done(store.answerQuestion(id, status, null) ?? store.getQuestion(id)!);
      };
      const wake = () => {
        const latest = store.getQuestion(id);
        if (latest && latest.status !== "pending") done(latest);
      };
      const onAbort = () => settle("dismissed");
      const timer = setTimeout(() => settle("expired"), timeoutMs);
      timer.unref?.();

      if (signal?.aborted) {
        settle("dismissed");
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      const set = this.waiters.get(id) ?? new Set<() => void>();
      set.add(wake);
      this.waiters.set(id, set);
      wake();
    });
  }
}
