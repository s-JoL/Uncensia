import type { TaskSchedule } from "./types.ts";

/** HTTP and agent tools share one schedule contract; intent stays with the model. */
export function taskSchedule(input: Partial<TaskSchedule>): TaskSchedule {
  const mode = input.mode === undefined ? "once" : input.mode;
  if (!["once", "continuous", "interval"].includes(mode)) throw new Error("Unknown task mode");
  const intervalMs = input.intervalMs ?? null;
  const maxRuns = input.maxRuns === undefined ? (mode === "once" ? 1 : 10) : input.maxRuns;
  if (maxRuns !== null && (!Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 10_000)) {
    throw new Error("执行轮数须为 1–10000，或明确选择不限轮数");
  }
  if (mode === "interval" && (intervalMs === null || !Number.isSafeInteger(intervalMs) || intervalMs < 60_000 || intervalMs > 366 * 86400_000)) {
    throw new Error("重复间隔须在 1 分钟至 366 天之间");
  }
  if (mode !== "interval" && intervalMs !== null) throw new Error("只有定期执行可以设置重复间隔");
  if (mode === "once" && maxRuns !== 1) throw new Error("一次执行的轮数必须为 1");
  return { mode, intervalMs, maxRuns };
}

export function taskStartTime(value: unknown, now = Date.now()): number {
  if (value === undefined) return now;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > now + 366 * 86400_000) {
    throw new Error("开始时间须为一年内的有效时间");
  }
  return Math.max(now, value);
}
