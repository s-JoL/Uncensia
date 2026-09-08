import { uiText } from "../i18n.tsx";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { Button, Modal, Spinner } from "../ui.tsx";

export function ConversationTree({ id, onClose, onFork }: { id: string; onClose: () => void; onFork: (id: string) => Promise<void> }) {
  const [tree, setTree] = useState<Awaited<ReturnType<typeof api.conversationTree>>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { let active = true; api.conversationTree(id).then((tree) => { if (active) setTree(tree); }).catch((error) => { if (active) setError(error.message); }); return () => { active = false; }; }, [id]);
  const active = new Set<string>();
  let entry = tree?.entries.find((entry) => entry.id === tree.leafId);
  while (entry && !active.has(entry.id)) { active.add(entry.id); entry = tree?.entries.find((candidate) => candidate.id === entry!.parentId); }
  return <Modal open title={uiText("对话版本")} description={uiText("编辑和重新生成之前的内容仍保留。选择一个节点，在新对话中继续。")} onOpenChange={(open) => { if (!open) onClose(); }}>
    <a href={`/v1/conversations/${id}/export`} download className="mb-3 inline-block text-sm text-primary underline">{uiText("导出完整对话与版本")}</a>
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    {!tree && !error ? <Spinner /> : null}
    <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">{tree?.entries.filter((entry) => entry.type === "message" && entry.role !== "toolResult").map((entry) => <div key={entry.id} className="rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground"><span>{entry.role === "user" ? uiText("你") : uiText("助手")} · {active.has(entry.id) ? uiText("当前版本") : uiText("历史版本")}</span><Button size="sm" disabled={busy} onClick={async () => { setBusy(true); try { const fork = await api.forkConversation(id, entry.id); await onFork(fork.id); onClose(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }}>{uiText("从这里继续")}</Button></div>
      <p className="mt-2 whitespace-pre-wrap text-sm">{entry.preview || uiText("图片或工具调用")}</p>
    </div>)}</div>
  </Modal>;
}
