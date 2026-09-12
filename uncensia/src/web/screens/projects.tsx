import { useCallback, useEffect, useState } from "react";
import type { Project } from "@shared/projects.ts";
import type { ConversationSummary, FileRecord } from "@shared/types.ts";
import { FILE_SOURCE_LABELS } from "@shared/types.ts";
import { api } from "../api.ts";
import { uiText } from "../i18n.tsx";
import { Button, Field, Input, Modal, PageBody, PageHeader, Textarea, formatBytes } from "../ui.tsx";
import { AssetPicker } from "../ui/asset-picker.tsx";
import { ResourcePreview } from "../resource-view.tsx";

export function Projects({projectId, modelId, onSelect, onConversation, onOpenRail}: {
  projectId?:string; modelId:string; onSelect:(id?:string)=>void; onConversation:(id:string)=>void; onOpenRail:()=>void;
}) {
  const [projects,setProjects] = useState<Project[]>([]);
  const [project,setProject] = useState<Project>();
  const [files,setFiles] = useState<FileRecord[]>([]);
  const [cursor,setCursor] = useState<string|null>(null);
  const [conversations,setConversations] = useState<ConversationSummary[]>([]);
  const [editing,setEditing] = useState(false);
  const [title,setTitle] = useState("");
  const [instructions,setInstructions] = useState("");
  const [picking,setPicking] = useState(false);
  const [preview,setPreview] = useState<FileRecord>();
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);
  const load = useCallback(async () => {
    if (projectId) {
      const [p,f,c] = await Promise.all([api.project(projectId),api.projectFiles(projectId),api.projectConversations(projectId)]);
      setProject(p); setFiles(f.items); setCursor(f.next_cursor); setConversations(c);
    } else setProjects(await api.projects());
  },[projectId]);
  useEffect(()=>{ void load().catch(e=>setError(String(e))); },[load]);
  const action = async (work:()=>Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch(e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <>
    <PageHeader title={project?.title ?? uiText("项目")} onOpenRail={onOpenRail}>
      {projectId ? <Button onClick={()=>onSelect()}>{uiText("所有项目")}</Button> : null}
      <Button disabled={!!projectId && !project} onClick={()=>{setTitle(project?.title ?? "");setInstructions(project?.instructions ?? "");setEditing(true);}}>{projectId ? uiText("编辑项目") : uiText("新建项目")}</Button>
    </PageHeader>
    <PageBody>
      {error ? <p role="alert" className="break-words text-destructive">{error}</p> : null}
      {!projectId ? <>
        <p className="text-sm text-muted-foreground">{uiText("将说明、参考资料和相关对话保存在一起。适用于小说、研究、代码或其他工作。")}</p>
        {!projects.length ? <p>{uiText("暂无项目")}</p> : <div className="grid gap-3 sm:grid-cols-2">{projects.map(p=><button key={p.id} onClick={()=>onSelect(p.id)} className="min-w-0 rounded-xl border p-5 text-left hover:bg-accent"><b className="break-words">{p.title}</b><p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">{p.instructions || uiText("尚未填写项目说明")}</p></button>)}</div>}
      </> : project ? <>
        <p className="text-sm text-muted-foreground">{uiText("本项目的说明和资料用于所属对话。记忆与工具权限仍由全局设置管理。")}</p>
        <details className="rounded-xl border p-4"><summary>{uiText("项目说明")}</summary><p className="mt-3 whitespace-pre-wrap break-words text-sm">{project.instructions || uiText("尚未填写项目说明")}</p></details>
        <section className="min-w-0 rounded-xl border p-4">
          <div className="mb-3 flex flex-wrap items-center gap-3"><h2 className="flex-1 font-medium">{uiText("项目资料")}</h2><Button disabled={busy} onClick={()=>setPicking(true)}>{uiText("从资料库引用")}</Button></div>
          <p className="mb-3 text-xs text-muted-foreground">{uiText("对话中新导入和生成的文件会自动加入。移除只解除关联，原件仍在资料库。")}</p>
          {files.map(file=><div key={file.id} className="flex min-w-0 items-center gap-3 border-t py-3"><button className="min-w-0 flex-1 text-left" onClick={()=>setPreview(file)}><span className="block truncate underline">{file.name}</span><span className="text-xs text-muted-foreground">{formatBytes(file.bytes)} · {uiText(FILE_SOURCE_LABELS[file.source] ?? file.source)}</span></button><Button disabled={busy} onClick={()=>void action(async()=>{await api.linkProjectFile(projectId,file.id,false);await load();})}>{uiText("移除关联")}</Button></div>)}
          {!files.length ? <p className="text-sm">{uiText("尚未添加资料")}</p> : null}
          {cursor ? <Button disabled={busy} onClick={()=>void action(async()=>{const page=await api.projectFiles(projectId,cursor);setFiles(current=>[...new Map([...current,...page.items].map(f=>[f.id,f])).values()]);setCursor(page.next_cursor);})}>{uiText("加载更多")}</Button> : null}
        </section>
        <section className="rounded-xl border p-4"><div className="mb-3 flex items-center gap-3"><h2 className="flex-1 font-medium">{uiText("项目对话")}</h2><Button disabled={busy || !modelId} onClick={()=>void action(async()=>onConversation((await api.createConversation(modelId,projectId)).id))}>{uiText("新对话")}</Button></div>
          {conversations.map(c=><button key={c.id} className="block w-full truncate border-t py-3 text-left hover:underline" onClick={()=>onConversation(c.id)}>{c.title}</button>)}
          {!conversations.length ? <p className="text-sm">{uiText("暂无对话")}</p> : null}
        </section>
      </> : <p>{uiText("加载中…")}</p>}
    </PageBody>
    <Modal open={editing} onOpenChange={setEditing} title={project ? uiText("编辑项目") : uiText("新建项目")} footer={<><Button disabled={busy} onClick={()=>void action(async()=>{await load();setEditing(false);})}>{uiText("取消并刷新")}</Button><Button variant="primary" disabled={busy || !title.trim()} onClick={()=>void action(async()=>{const saved=await api.saveProject({title,instructions},project);setEditing(false);setProject(saved);if(projectId)await load();else onSelect(saved.id);})}>{uiText("保存")}</Button></>}>
      <div className="flex flex-col gap-4"><Field label={uiText("项目名称")}><Input value={title} maxLength={120} onChange={e=>setTitle(e.target.value)} /></Field><Field label={uiText("项目说明")} hint={uiText("填写长期目标、背景和工作约定。修改后在下一次模型请求生效。") }><Textarea rows={10} maxLength={32000} value={instructions} onChange={e=>setInstructions(e.target.value)} /></Field>{error ? <p role="alert" className="break-words text-destructive">{error}</p> : null}</div>
    </Modal>
    {picking && projectId ? <AssetPicker includeVideos onClose={()=>setPicking(false)} onSelect={file=>{setPicking(false);void action(async()=>{await api.linkProjectFile(projectId,file.id);await load();});}} /> : null}
    <Modal open={!!preview} onOpenChange={open=>{if(!open)setPreview(undefined);}} title={preview?.name ?? uiText("预览")}>
      {preview ? <ResourcePreview key={preview.id} id={preview.id} /> : null}
    </Modal>
  </>;
}
