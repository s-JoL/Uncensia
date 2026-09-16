/**
 * Pi extensions and packages. Unlike a skill, an extension is code the agent
 * process runs on its own start-up, so every install path here says so before
 * the request goes out, and a package's origin stays visible next to its switch.
 */
import { language, uiText } from "../../i18n.tsx";
import { useCallback, useEffect, useState } from "react";
import type { AgentExtension, AgentResources } from "@shared/types.ts";
import { api } from "../../api.ts";
import { Button, Input, Modal, Section, SectionBody, Switch, Textarea, useAction, useToast } from "../../ui.tsx";

const EMPTY: AgentResources = { extensions: [], packages: [], diagnostics: [], status: null };

const TEMPLATE = `export default function (pi) {
  pi.registerTool({
    name: "hello",
    label: "hello",
    description: "Say hello.",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "Hello from an Uncensia extension." }] };
    },
  });
}
`;

export function ExtensionsSection() {
  const [resources, setResources] = useState<AgentResources>(EMPTY);
  const [source, setSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [editing, setEditing] = useState<AgentExtension | "new" | null>(null);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const act = useAction();
  const toast = useToast();
  const refresh = useCallback(async () => setResources(await api.extensions()), []);
  useEffect(() => { void refresh().catch(error => toast(String(error), true)); }, [refresh, toast]);

  const install = async () => {
    const trimmed = source.trim();
    if (!trimmed) return;
    if (!window.confirm(uiText("这个包里的代码会在助手启动时直接运行，权限与助手本身相同。请确认你信任它的来源：{0}", [trimmed]))) return;
    setInstalling(true);
    setLog([]);
    const ok = await act(async () => { const result = await api.installPackage(trimmed); setLog(result.log); }, uiText("已安装，下一次运行生效"));
    setInstalling(false);
    if (ok) { setSource(""); await refresh().catch(() => undefined); }
  };

  const { extensions, packages, diagnostics, status } = resources;
  return <Section title={uiText("扩展与包")} hint={uiText("扩展是随助手一起运行的代码，可以添加工具、命令和事件处理；包是从 npm、Git 或本地目录安装的一组扩展、技能和提示词。改动在下一次运行生效。")} actions={<Button size="sm" onClick={() => { setEditing("new"); setName("my-extension"); setContent(TEMPLATE); }}>{uiText("新建扩展")}</Button>}>
    <SectionBody>
      {diagnostics.map((text, i) => <p key={i} className="break-all text-xs text-amber-600">{text}</p>)}
      {status ? <div className="rounded-lg border p-3 text-xs text-muted-foreground space-y-1">
        <p>{uiText("上次加载：{0} · 成功 {1} 个", [new Date(status.at).toLocaleString(language()), String(status.loaded.length)])}{status.errors.length ? uiText(" · 失败 {0} 个", [String(status.errors.length)]) : ""}</p>
        {status.errors.map((item, i) => <p key={i} className="break-all text-destructive">{item.path}: {item.error}</p>)}
      </div> : null}

      <div className="space-y-3">
        <p className="font-medium">{uiText("安装包")}</p>
        <p className="text-xs text-muted-foreground">{uiText("支持 npm 包名（如 npm:@scope/pkg@1.0.0）、Git 地址（如 git:github.com/user/repo 或 https://github.com/user/repo）和本地目录路径。")}</p>
        <div className="flex gap-2">
          <Input aria-label={uiText("包来源")} placeholder={uiText("npm:pi-skills 或 https://github.com/user/repo")} value={source} disabled={installing} onChange={event => setSource(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void install(); }} />
          <Button disabled={installing || !source.trim()} onClick={() => void install()}>{installing ? uiText("安装中…") : uiText("安装")}</Button>
        </div>
        <p className="text-xs text-amber-600">{uiText("第三方包的代码会以助手的权限运行，只安装你信任的来源。")}</p>
        {log.length ? <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-2 text-xs">{log.join("\n")}</pre> : null}
      </div>

      {packages.length ? <div className="space-y-3">
        <p className="font-medium">{uiText("已安装的包")}</p>
        {packages.map(item => <div key={item.source} className="rounded-xl border p-4 space-y-2">
          <Switch label={item.source} checked={item.enabled} onChange={enabled => void act(async () => { await api.setPackageEnabled(item.source, enabled); await refresh(); }, enabled ? uiText("包已启用") : uiText("包已停用"))} />
          <p className="text-xs text-muted-foreground">
            {uiText("{0} 个扩展 · {1} 个技能 · {2} 个提示词", [String(item.resources.extensions), String(item.resources.skills), String(item.resources.prompts)])}
            {item.installedPath ? null : <> · <span className="text-destructive">{uiText("尚未安装到本地")}</span></>}
          </p>
          {item.installedPath ? <p className="break-all text-xs text-muted-foreground">{item.installedPath}</p> : null}
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void act(async () => { const result = await api.updatePackage(item.source); setLog(result.log); await refresh(); }, uiText("包已更新，下一次运行生效"))}>{uiText("更新")}</Button>
            <Button size="sm" variant="outline" onClick={() => { if (window.confirm(uiText("移除这个包？它提供的扩展、技能和提示词将不再加载。"))) void act(async () => { await api.removePackage(item.source); await refresh(); }, uiText("包已移除")); }}>{uiText("移除")}</Button>
          </div>
        </div>)}
      </div> : null}

      <div className="space-y-3">
        <p className="font-medium">{uiText("扩展")}</p>
        {extensions.map(item => <div key={item.id} className="rounded-xl border p-4 space-y-3">
          <Switch label={item.name} checked={item.enabled} onChange={enabled => void act(async () => { await api.updateExtension(item.id, { enabled }); await refresh(); }, enabled ? uiText("扩展已启用") : uiText("扩展已停用"))} />
          <p className="text-xs text-muted-foreground">{item.editable ? uiText("本地扩展，可编辑") : uiText("来自包 {0}，正文只读", [item.source])}</p>
          <p className="break-all text-xs text-muted-foreground">{item.filePath}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => { setEditing(item); setName(item.name); setContent(item.content); }}>{item.editable ? uiText("查看与编辑") : uiText("查看代码")}</Button>
            {item.editable ? <Button size="sm" variant="outline" onClick={() => { if (window.confirm(uiText("删除扩展 {0}？文件会移到回收目录，不会立刻销毁。", [item.name]))) void act(async () => { await api.deleteExtension(item.id); await refresh(); }, uiText("扩展已删除")); }}>{uiText("删除")}</Button> : null}
          </div>
        </div>)}
        {!extensions.length ? <p className="text-sm text-muted-foreground">{uiText("还没有扩展。可以新建一个本地扩展，或安装一个包。")}</p> : null}
      </div>
    </SectionBody>
    {editing ? <Modal open onOpenChange={open => { if (!open) setEditing(null); }} title={editing === "new" ? uiText("新建扩展") : editing.name}>
      <div className="space-y-3">
        {editing === "new" ? <Input aria-label={uiText("扩展名称")} value={name} onChange={event => setName(event.target.value)} placeholder="my-extension" /> : null}
        <Textarea aria-label={uiText("扩展代码")} rows={18} className="font-mono text-xs" value={content} readOnly={editing !== "new" && !editing.editable} onChange={event => setContent(event.target.value)} />
        {editing !== "new" ? <p className="break-all text-xs text-muted-foreground">{editing.filePath}</p> : null}
        {editing === "new" || editing.editable ? <>
          <p className="text-xs text-amber-600">{uiText("保存后这段代码会在助手下一次启动时运行。")}</p>
          <Button onClick={() => void act(async () => {
            if (editing === "new") await api.createExtension(name.trim(), content);
            else await api.updateExtension(editing.id, { content, revision: editing.revision });
            setEditing(null); await refresh();
          }, uiText("扩展已保存，下一次运行生效"))}>{uiText("保存")}</Button>
        </> : null}
      </div>
    </Modal> : null}
  </Section>;
}
