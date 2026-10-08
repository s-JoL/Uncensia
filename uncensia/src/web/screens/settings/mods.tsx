import { uiText } from "../../i18n.tsx";
import { useCallback, useEffect, useState } from "react";
import type { ModRecord } from "@shared/types.ts";
import { api } from "../../api.ts";
import { modsChanged } from "../../mods.ts";
import { Badge, Button, Modal, Section, SectionBody, Switch, Textarea, useAction, useToast } from "../../ui.tsx";

const TEMPLATE = {
  name: "my-mod",
  title: "我的模组",
  description: "这个模组添加了什么",
  contributes: {
    messageActions: [{ label: "精简", prompt: "把上面这段压缩到一半长度，保留关键信息。" }],
    starters: [{ label: "头脑风暴", prompt: "帮我头脑风暴：" }],
    panels: [{ title: "大纲", notes: ["outline"] }],
  },
};

/** What a mod adds, in a line: so many buttons, chips and panels. */
function summary(mod: ModRecord) {
  const c = mod.contributes;
  return [
    c.messageActions?.length ? uiText("{0} 个回复按钮", [c.messageActions.length]) : "",
    c.starters?.length ? uiText("{0} 个开场建议", [c.starters.length]) : "",
    c.panels?.length ? uiText("{0} 个侧边面板", [c.panels.length]) : "",
  ].filter(Boolean).join(" · ");
}

export function ModsSection() {
  const act = useAction();
  const toast = useToast();
  const [items, setItems] = useState<ModRecord[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [editing, setEditing] = useState<{ name: string; revision?: string } | null>(null);
  const [content, setContent] = useState("");
  const refresh = useCallback(async () => { const result = await api.mods(); setItems(result.items); setErrors(result.errors); }, []);
  useEffect(() => { void refresh().catch(error => toast(String(error), true)); }, [refresh, toast]);
  const changed = async () => { await refresh(); modsChanged(); };

  return <Section
    title={uiText("模组")}
    hint={uiText("模组给界面添加回复下方的按钮、空对话里的开场建议和显示对话笔记的侧边面板。模组只是声明，不运行代码；助手也可以按你的要求编写。")}
    actions={<Button size="sm" onClick={() => { setEditing({ name: "" }); setContent(JSON.stringify(TEMPLATE, null, 2)); }}>{uiText("添加模组")}</Button>}
  >
    <SectionBody>
      {errors.map(text => <p key={text} className="break-all text-xs text-destructive">{text}</p>)}
      {!items.length ? <p className="text-sm text-muted-foreground">{uiText("还没有模组。")}</p> : null}
      {items.map(mod => <div key={mod.name} className="space-y-2 rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <Switch label={uiText(mod.title)} checked={mod.enabled} onChange={enabled => void act(async () => { await api.setModEnabled(mod.name, enabled); await changed(); }, enabled ? uiText("模组已启用") : uiText("模组已停用"))} />
          {mod.origin === "learned" ? <Badge tone="outline">{uiText("助手所写")}</Badge> : null}
        </div>
        {mod.description ? <p className="text-sm text-muted-foreground">{uiText(mod.description)}</p> : null}
        <p className="text-xs text-muted-foreground">{mod.name} · {summary(mod)}</p>
        <div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={() => void act(async () => { const read = await api.readMod(mod.name); setContent(read.content); setEditing({ name: mod.name, revision: read.revision }); })}>{uiText("查看与编辑")}</Button>
          <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={() => void act(async () => { await api.deleteMod(mod.name); await changed(); }, uiText("模组已移除"))}>{uiText("移除")}</Button>
        </div>
      </div>)}
    </SectionBody>
    {editing ? <Modal open onOpenChange={open => { if (!open) setEditing(null); }} title={editing.name || uiText("添加模组")}>
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">{uiText("messageActions 的 prompt 可以用 {excerpt} 代表那段回复的开头；panels 的 notes 写对话笔记的键名。")}</p>
        <Textarea aria-label={uiText("模组内容")} rows={18} className="font-mono text-xs" value={content} onChange={event => setContent(event.target.value)} />
        <Button onClick={() => void act(async () => {
          let manifest: { name?: unknown };
          try { manifest = JSON.parse(content); } catch { throw new Error(uiText("不是有效的 JSON")); }
          const name = editing.name || String(manifest.name ?? "");
          await api.saveMod(name, manifest, editing.revision);
          setEditing(null);
          await changed();
        }, uiText("模组已保存"))}>{uiText("保存")}</Button>
      </div>
    </Modal> : null}
  </Section>;
}
