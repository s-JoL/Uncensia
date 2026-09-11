import { language, uiText } from "../../i18n.tsx";
import { useCallback, useEffect, useState } from "react";
import type { ManagedSkill } from "@shared/types.ts";
import { api } from "../../api.ts";
import { Button, Input, Modal, Section, SectionBody, Switch, Textarea, useAction, useToast } from "../../ui.tsx";

export function SkillsSection() {
  const [items, setItems] = useState<ManagedSkill[]>([]);
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<ManagedSkill | "new" | null>(null);
  const [content, setContent] = useState("");
  const [history, setHistory] = useState<Awaited<ReturnType<typeof api.learningHistory>>["items"]>([]);
  const act = useAction();
  const toast = useToast();
  const refresh = useCallback(async () => { const [result, changes] = await Promise.all([api.skills(), api.learningHistory()]); setItems(result.items); setDiagnostics(result.diagnostics); setHistory(changes.items); }, []);
  useEffect(() => { void refresh().catch(error => toast(String(error), true)); }, [refresh, toast]);
  return <Section title={uiText("技能")} hint={uiText("助手根据需求读取技能。停用后从下一次运行的技能列表中移除，正在进行的任务和旧历史保留原样。")} actions={<Button size="sm" onClick={() => { setEditing("new"); setContent(uiText("---\nname: my-skill\ndescription: 描述何时使用这项技能\n---\n\n在这里编写技能说明。\n")); }}>{uiText("添加技能")}</Button>}>
    <SectionBody>
      <Input aria-label={uiText("查找技能")} placeholder={uiText("按名称或用途查找技能")} value={search} onChange={event => setSearch(event.target.value)} />
      {diagnostics.map((text, i) => <p key={i} className="break-all text-xs text-amber-600">{text}</p>)}
      {items.filter(item => `${item.name} ${item.description}`.toLowerCase().includes(search.toLowerCase())).map(item => <div key={item.id} className="rounded-xl border p-4 space-y-3">
        <Switch label={item.name} checked={item.enabled} onChange={enabled => void act(async () => { await api.updateSkill(item.id, { enabled }); await refresh(); }, enabled ? uiText("技能已启用") : uiText("技能已停用"))} />
        <p className="text-sm text-muted-foreground">{item.description}</p>
        <p className="text-xs text-muted-foreground">{item.manualOnly ? uiText("仅手动调用") : uiText("按需自动加载")} · {item.editable ? uiText("本地技能，可编辑") : uiText("外部技能，正文只读")}</p>
        <Button size="sm" variant="outline" onClick={() => { setEditing(item); setContent(item.content); }}>{item.editable ? uiText("查看与编辑") : uiText("查看说明")}</Button>
      </div>)}
      {!items.length ? <p className="text-sm text-muted-foreground">{uiText("还没有技能，可以添加标准 SKILL.md 内容。")}</p> : null}
      <div className="space-y-3 border-t pt-4">
        <p className="font-medium">{uiText("助手改进记录")}</p>
        <p className="text-xs text-muted-foreground">{uiText("最近 50 次修改尝试，保留原因和修改前内容。可将旧内容复制回编辑器，或让助手恢复；是否生效以实际工具结果为准。")}</p>
        <Button size="sm" variant="outline" onClick={() => void act(refresh)}>{uiText("刷新记录")}</Button>
        {!history.length ? <p className="text-sm text-muted-foreground">{uiText("尚无记录。在工具与权限中允许修改技能后，可以让助手把已验证的经验整理成技能。")}</p> : null}
        {history.map(change => <details key={change.id} className="rounded-lg border p-3">
          <summary className="cursor-pointer break-words text-sm">{new Date(change.at).toLocaleString(language())} · {change.kind === "prompt" ? uiText("提示词") : uiText("技能")} · {change.reason}</summary>
          <p className="break-all text-xs text-muted-foreground">{change.target}</p>
          <p className="mt-2 text-xs">{uiText("修改前")}</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{change.before ?? uiText("新建")}</pre>
          <p className="mt-2 text-xs">{uiText("修改后")}</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">{change.after}</pre>
        </details>)}
      </div>
    </SectionBody>
    {editing ? <Modal open onOpenChange={open => { if (!open) setEditing(null); }} title={editing === "new" ? uiText("添加技能") : editing.name}>
      <div className="space-y-3">
        <Textarea aria-label={uiText("技能内容")} rows={18} className="font-mono text-xs" value={content} readOnly={editing !== "new" && !editing.editable} onChange={event => setContent(event.target.value)} />
        {editing !== "new" ? <p className="break-all text-xs text-muted-foreground">{editing.filePath}</p> : null}
        {editing === "new" || editing.editable ? <Button onClick={() => void act(async () => {
          if (editing === "new") await api.createSkill(content);
          else await api.updateSkill(editing.id, { content, revision: editing.revision });
          setEditing(null); await refresh();
        }, uiText("技能已保存，下一次运行生效"))}>{uiText("保存")}</Button> : null}
      </div>
    </Modal> : null}
  </Section>;
}
