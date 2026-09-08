import { language, uiText } from "../i18n.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BackgroundTask, ConversationSummary, RunSummary, TaskMode } from "@shared/types.ts";
import { taskSchedule } from "@shared/tasks.ts";
import { api } from "../api.ts";
import { Button, Field, Input, Textarea, Select, Switch, Badge, useToast } from "../ui.tsx";

const labels = { pending: uiText("等待执行"), running: uiText("执行中"), paused: uiText("已暂停"), completed: uiText("已完成"), failed: uiText("执行失败"), cancelled: uiText("已取消") };
const modes = { once: uiText("一次执行"), continuous: uiText("持续推进"), interval: uiText("定期执行") };
const activeRun = (task: BackgroundTask) => task.currentRun && ["queued", "running"].includes(task.currentRun.status);

export function TaskPanel({ conversationId, modelId, onCreated }: {
  conversationId?: string;
  modelId?: string;
  onCreated?: (task: BackgroundTask) => void;
}) {
  const toast = useToast();
  const [items, setItems] = useState<BackgroundTask[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selected, setSelected] = useState("");
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<TaskMode>("once");
  const [later, setLater] = useState(false);
  const [start, setStart] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [limit, setLimit] = useState("10");
  const [unlimited, setUnlimited] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");
  const refreshVersion = useRef(0);
  const refresh = useCallback(async () => {
    const version = ++refreshVersion.current;
    const data = conversationId ? await api.backgroundTasks(conversationId) : await api.allBackgroundTasks();
    if (version === refreshVersion.current) { setItems(data.items); setError(""); }
  }, [conversationId]);
  useEffect(() => {
    let gone = false;
    let pending = false;
    const inspect = async () => {
      if (pending) return;
      pending = true;
      try { await refresh(); }
      catch (e) { if (!gone) setError(e instanceof Error ? e.message : String(e)); }
      finally { pending = false; }
    };
    void inspect();
    const timer = setInterval(() => { if (!document.hidden) void inspect(); }, 2500);
    return () => { gone = true; refreshVersion.current++; clearInterval(timer); };
  }, [refresh]);
  useEffect(() => {
    if (conversationId || !showForm) return;
    let gone = false;
    void api.conversations().then(data => { if (!gone) setConversations(data.items); }).catch(e => toast(String(e), true));
    return () => { gone = true; };
  }, [conversationId, showForm, toast]);

  const create = async () => {
    setCreating(true);
    try {
      const schedule = taskSchedule({ mode, intervalMs: mode === "interval" ? Number(minutes) * 60_000 : null,
        maxRuns: mode === "once" ? 1 : unlimited ? null : Number(limit) });
      const runAt = later ? new Date(start).getTime() : Date.now();
      if (!Number.isFinite(runAt) || (later && runAt <= Date.now())) throw new Error(uiText("请选择未来的开始时间"));
      // A newly created conversation is retained on failure so retry does not
      // leave multiple empty conversations behind.
      let target = conversationId || selected;
      if (!target) { target = (await api.createConversation(modelId)).id; setSelected(target); }
      const task = await api.createBackgroundTask(target, prompt, runAt, schedule);
      refreshVersion.current++;
      setItems(current => [task, ...current]);
      setPrompt(""); setShowForm(false); setFilter("all");
      toast(uiText("任务已安排，结果会回到所属对话"));
      onCreated?.(task);
    } catch (e) { toast(e instanceof Error ? e.message : String(e), true); }
    finally { setCreating(false); }
  };
  const visible = items.filter(item => filter === "all" || !["completed", "cancelled"].includes(item.status));
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex gap-1">
        <Button size="sm" variant={filter === "active" ? "secondary" : "ghost"} onClick={() => setFilter("active")}>{uiText("进行中与待处理")}</Button>
        <Button size="sm" variant={filter === "all" ? "secondary" : "ghost"} onClick={() => setFilter("all")}>{uiText("全部")}</Button>
      </div>
      <Button size="sm" variant="primary" onClick={() => setShowForm(value => !value)}>{showForm ? uiText("收起") : uiText("新建任务")}</Button>
    </div>
    {showForm ? <div className="space-y-4 rounded-xl border bg-card p-4">
      {!conversationId && !modelId ? <Field label={uiText("所属对话")}><Select className="w-full" value={selected} onChange={setSelected}
        options={[{ value: "", label: uiText("新建对话") }, ...conversations.map(c => ({ value: c.id, label: c.title }))]} /></Field> : null}
      <Field label={uiText("任务目标")} hint={uiText("写明要完成什么、完成标准和需要保留的要求。也可以在聊天中直接安排。")}>
        <Textarea rows={4} value={prompt} maxLength={12000} onChange={e => setPrompt(e.target.value)} placeholder={uiText("例如：整理这些资料，分批补齐遗漏，完成后给我索引。")} />
      </Field>
      <Field label={uiText("执行方式")}><Select className="w-full" value={mode} onChange={setMode} options={Object.entries(modes).map(([value, label]) => ({ value: value as TaskMode, label }))} /></Field>
      <p className="text-xs text-muted-foreground">{mode === "continuous" ? uiText("每轮保存进度，未完成时继续。完成目标、遇到阻塞或达到轮数上限时停止推进。") : mode === "interval" ? uiText("按固定时间间隔执行；对话忙时等待，错过多次也只执行一次，不集中补跑。") : uiText("执行一次，关闭网页后仍会继续。")}</p>
      <Switch label={uiText("指定开始时间")} checked={later} onChange={setLater} />
      {later ? <Field label={uiText("开始时间")} hint={uiText("按本机时区：{0}", [Intl.DateTimeFormat().resolvedOptions().timeZone])}><Input type="datetime-local" value={start} onChange={e => setStart(e.target.value)} /></Field> : null}
      {mode === "interval" ? <Field label={uiText("重复间隔（分钟）")}><Input type="number" min={1} value={minutes} onChange={e => setMinutes(e.target.value)} /></Field> : null}
      {mode !== "once" ? <>
        <Switch label={uiText("不限执行轮数")} checked={unlimited} onChange={setUnlimited} />
        {!unlimited ? <Field label={uiText("最多执行轮数")} hint={uiText("一轮可能包含多次工具调用；这不是图片数量或费用上限。")}><Input type="number" min={1} max={10000} value={limit} onChange={e => setLimit(e.target.value)} /></Field> : <p className="text-xs text-muted-foreground">{uiText("将按此目标持续或定期运行，直到完成、遇到阻塞或你暂停、取消。")}</p>}
      </> : null}
      <Button variant="primary" disabled={creating || !prompt.trim()} onClick={() => void create()}>{creating ? uiText("正在安排…") : uiText("安排任务")}</Button>
    </div> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {visible.map(task => <TaskCard key={task.id} task={task} refresh={refresh} />)}
    {!visible.length && !error ? <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">{items.length ? uiText("没有正在推进或等待处理的任务，可切换到全部查看结果。") : uiText("还没有任务。可以新建，也可以在聊天中说“交给后台继续完成”或“每天这个时间检查一次”。")}</div> : null}
  </div>;
}

function TaskCard({ task, refresh }: { task: BackgroundTask; refresh: () => Promise<void> }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<RunSummary[] | null>(null);
  const { state } = task;
  const isActive = activeRun(task);
  const capped = state.maxRuns !== null && state.completedRuns >= state.maxRuns;
  const act = async (action: "pause" | "resume" | "cancel") => {
    setBusy(true);
    try {
      if (action === "cancel") await api.cancelBackgroundTask(task.id);
      else await api.controlBackgroundTask(task.id, action);
      await refresh();
    } catch (e) { toast(e instanceof Error ? e.message : String(e), true); }
    finally { setBusy(false); }
  };
  return <article className="space-y-3 rounded-xl border bg-card p-4" data-testid="task-card">
    <div className="flex flex-wrap items-center gap-2"><Badge>{modes[state.mode]}</Badge><Badge>{labels[task.status]}{task.status === "paused" && isActive ? uiText(" · 本轮仍在执行") : task.status === "cancelled" && isActive ? uiText(" · 正在停止") : ""}</Badge></div>
    <p className="whitespace-pre-wrap break-words text-sm">{task.prompt}</p>
    <p className="text-xs text-muted-foreground">{uiText("已完成 {0} 轮", [state.completedRuns])}{state.maxRuns !== null ? uiText(" / 最多 {0} 轮", [state.maxRuns]) : uiText(" · 不限轮数")}{state.mode === "interval" ? uiText(" · 每 {0} 分钟", [state.intervalMs! / 60_000]) : ""}</p>
    {task.status === "pending" ? <p className="text-xs text-muted-foreground">{task.runAt > Date.now() ? uiText("下次执行：{0}", [new Date(task.runAt).toLocaleString(language())]) : uiText("等待对话空闲后执行")}</p> : null}
    {isActive ? <p className="text-xs text-muted-foreground">{uiText("本轮开始于")}{new Date(task.currentRun!.createdAt).toLocaleString(language())}{uiText("；实时步骤与审批在对话中。")}</p> : null}
    {state.progress ? <div className="rounded-lg bg-muted/50 p-3 text-sm">
      <p className="mb-1 text-xs text-muted-foreground">{uiText("助手报告的进度")}{state.progress.completed !== undefined ? ` · ${state.progress.completed}${state.progress.total !== undefined ? ` / ${state.progress.total}` : ""}` : ""}</p>
      <p className="whitespace-pre-wrap break-words">{state.progress.summary}</p>
    </div> : null}
    {task.error ? <p className="break-words text-sm text-destructive">{task.error}</p> : null}
    <div className="flex flex-wrap items-center gap-2">
      <a className="px-2 text-sm text-primary underline" href={`/c/${task.conversationId}`}>{uiText("查看对话与结果")}</a>
      {["pending", "running"].includes(task.status) ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("pause")}>{isActive ? uiText("本轮后暂停") : uiText("暂停")}</Button> : null}
      {["paused", "failed"].includes(task.status) && !capped ? <Button size="sm" variant="outline" disabled={busy || !!isActive} onClick={() => void act("resume")}>{uiText("继续")}</Button> : null}
      {!["completed", "cancelled"].includes(task.status) ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("cancel")}>{uiText("取消任务")}</Button> : null}
      <Button size="sm" variant="ghost" onClick={() => { if (history) setHistory(null); else void api.taskRuns(task.id).then(data => setHistory(data.items)).catch(e => toast(String(e), true)); }}>{uiText("执行记录")}</Button>
    </div>
    {history ? <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">{history.length ? history.map(run => <p key={run.id}>{new Date(run.createdAt).toLocaleString(language())} · {({ queued: uiText("排队"), running: uiText("执行中"), completed: uiText("完成"), failed: uiText("失败"), cancelled: uiText("已停止") })[run.status]}{run.error ? ` · ${run.error}` : ""}</p>) : uiText("还没有开始执行")}</div> : null}
  </article>;
}
