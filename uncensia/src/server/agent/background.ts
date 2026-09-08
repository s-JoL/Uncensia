import type { Runtime } from "./runtime.ts";
import type { Store } from "../store/store.ts";
import type { BackgroundTask } from "@shared/types.ts";

/** A durable scheduler around the existing Runtime, not a second agent loop. */
export class BackgroundTasks {
  private readonly timer: ReturnType<typeof setInterval>;
  private closing = false;
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly store: Store, private readonly runtime: Runtime) {
    const interrupted = store.failInterruptedBackgroundTasks();
    if (interrupted) console.log(`[background] marked ${interrupted} interrupted task(s) failed`);
    this.timer = setInterval(() => this.wake(), 2_000);
    this.timer.unref();
    this.wake();
  }

  wake() {
    if (this.closing) return;
    for (const task of this.store.dueBackgroundTasks()) {
      if (this.pending.size >= 4) break;
      if (this.runtime.isActive(task.conversationId)) continue;
      // Claim before the first await. Busy conversations cannot starve others.
      const run = this.store.claimBackgroundTask(task.id);
      if (!run) continue;
      const work = this.execute(task, run.id).finally(() => this.pending.delete(work));
      this.pending.add(work);
    }
  }

  private async execute(task: BackgroundTask, runId: string) {
    try {
      await this.runtime.start(runId, task.conversationId, {
        message: taskMessage(task), modelId: task.modelId, taskId: task.id,
      });
    } catch (error) {
      this.store.setRunStatus(runId, "failed", error instanceof Error ? error.message : String(error));
    } finally {
      this.store.settleBackgroundTask(task.id, runId);
    }
  }

  async close() {
    this.closing = true;
    clearInterval(this.timer);
    await Promise.all([...this.pending]);
  }
}

function taskMessage(task: BackgroundTask) {
  const { mode, completedRuns, maxRuns, progress } = task.state;
  return [
    task.prompt,
    `【后台任务 · ${{ once: "一次执行", continuous: "持续推进", interval: "定期执行" }[mode]}】已完成 ${completedRuns} 轮；${maxRuns === null ? "用户选择不限轮数" : `最多 ${maxRuns} 轮`}。`,
    progress ? `上次保存的进度（助手报告，请结合历史和实际结果核对）：\n${progress.summary}` : "",
    "根据当前对话和实际结果继续，保留用户后续修正。恢复中断的工作时，先核对已经完成的部分。",
    mode === "continuous" ? "本轮推进一个有用且适量的部分，结束前保存任务进度。还有工作则报告继续，整个目标完成才报告完成，需要用户输入或外部变化则报告阻塞。之后会按进度继续下一轮，不要另建重复任务。" :
      mode === "interval" ? "执行本次安排。报告继续会保留后续计划；报告完成会结束整个计划。需要用户处理时报告阻塞。" : "完成本次指令，将结果留在这里。",
  ].filter(Boolean).join("\n\n");
}
