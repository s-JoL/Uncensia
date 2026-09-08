import { createHash } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { TaskProgress, TaskSchedule } from "@shared/types.ts";
import { taskSchedule, taskStartTime } from "@shared/tasks.ts";
import type { Store } from "../store/store.ts";

const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });

export function taskTools(store: Store, conversationId: string, modelId: string, runId: string, taskId?: string, stopRun?: (runId: string) => void): AgentTool[] {
  if (taskId) return [{
    name: "report_task_progress", label: "更新任务进度", executionMode: "sequential",
    description: "Finish this task turn and save evidence-based progress. First deliver the current work to the user, then call this tool ALONE after all work tools have finished. Its native SDK termination ends the tool batch; the scheduler owns the next turn. Summary must identify finished work, result IDs/paths and remaining work. Counts are your reported work units, not server-verified quality. continue requests another turn (continuous) or keeps the schedule (interval); complete ends the whole task; blocked pauses for input. Do not report complete merely because one batch finished.",
    parameters: Type.Object({
      summary: Type.String({ minLength: 1, maxLength: 6000 }),
      outcome: Type.Union([Type.Literal("continue"), Type.Literal("complete"), Type.Literal("blocked")]),
      completed: Type.Optional(Type.Integer({ minimum: 0 })),
      total: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    execute: async (_id, args) => {
      const progress = args as Omit<TaskProgress, "runId">;
      if (typeof progress.summary !== "string" || !progress.summary.trim() || progress.summary.length > 6000 || !["continue", "complete", "blocked"].includes(progress.outcome)) throw new Error("Invalid task progress");
      for (const [key, value] of [["completed", progress.completed], ["total", progress.total]] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < (key === "total" ? 1 : 0))) throw new Error("Invalid progress count");
      }
      if (progress.completed !== undefined && progress.total !== undefined && progress.completed > progress.total) throw new Error("Completed count exceeds total");
      return { ...result(store.reportTaskProgress(taskId, { runId, summary: progress.summary, outcome: progress.outcome,
        ...(progress.completed === undefined ? {} : { completed: progress.completed }),
        ...(progress.total === undefined ? {} : { total: progress.total }) })), terminate: true };
    },
  }];
  return [{
    name: "create_task", label: "安排任务", executionMode: "sequential",
    description: "Create a durable task in THIS conversation only when the user asks for background work, sustained iteration, scheduling or recurring work. It starts when the conversation is idle, uses the currently selected chat model and returns results here. once executes once; continuous resumes toward a goal until completed, blocked or the run limit; interval repeats at a fixed elapsed-time interval (not calendar/DST rules). Include scope, completion criteria and latest user constraints in prompt. Do not execute the same work here after scheduling. runAt is Unix milliseconds; omitted means now. maxRuns defaults to 10 for repeating work; null explicitly means no run limit and requires that user intent. This is a run-count limit, not an image/token/cost budget. The limit is a ceiling, never a target: do not add work or extra stages beyond the user goal to fill it. Describe the arrangement to the user in plain language. Do not create a duplicate of an existing task.",
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 12000 }),
      mode: Type.Union([Type.Literal("once"), Type.Literal("continuous"), Type.Literal("interval")]),
      runAt: Type.Optional(Type.Integer()),
      intervalMs: Type.Optional(Type.Integer()),
      maxRuns: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    }),
    execute: async (callId, args) => {
      const input = args as Partial<TaskSchedule> & { prompt: string; runAt?: number };
      if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 12000) throw new Error("Invalid task prompt");
      // Retrying the same tool call cannot schedule paid work twice.
      const id = `task_${createHash("sha256").update(`${conversationId}:${runId}:${callId}`).digest("hex").slice(0, 32)}`;
      const prior = store.getBackgroundTask(id);
      if (prior) return result(prior);
      return result(store.createBackgroundTask({ id, conversationId, modelId, prompt: input.prompt.trim(),
        runAt: taskStartTime(input.runAt), schedule: taskSchedule(input) }));
    },
  }, {
    name: "list_tasks", label: "查看任务",
    description: "List persisted tasks and their actual execution status in the current conversation. Use before creating potentially duplicate scheduled work or when asked about progress.",
    parameters: Type.Object({}),
    execute: async () => result(store.listBackgroundTasks(conversationId)),
  }, {
    name: "control_task", label: "控制任务", executionMode: "sequential",
    description: "Pause, resume or cancel an existing task in this conversation when the user requests it. Get its exact ID with list_tasks. Pause allows an active turn to finish; cancel requests stopping it and prevents later turns. Completed results are retained. Resume is allowed only for a paused/failed task below its run limit, and verifies existing work on its next turn.",
    parameters: Type.Object({ task_id: Type.String(), action: Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("cancel")]) }),
    execute: async (_id, args) => {
      const { task_id, action } = args as { task_id: string; action: "pause" | "resume" | "cancel" };
      const task = store.getBackgroundTask(task_id);
      if (!task || task.conversationId !== conversationId) throw new Error("Task not found in this conversation");
      if (!["pause", "resume", "cancel"].includes(action)) throw new Error("Invalid task action");
      const updated = store.controlBackgroundTask(task_id, action);
      if (action === "cancel" && task.runId) stopRun?.(task.runId);
      return result(updated);
    },
  }];
}
