import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { uiText } from "./i18n.tsx";
import type { DeliverableRecord, DeliverableComparison } from "@shared/evidence.ts";
import type { FileRecord } from "@shared/types.ts";

export function ResourcePreview({id}: {id:string}) {
  const [file,setFile] = useState<FileRecord>();
  const [error,setError] = useState("");
  useEffect(()=>{let active=true;setFile(undefined);setError("");void api.file(id).then(f=>{if(active)setFile(f);}).catch(e=>{if(active)setError(String(e));});return()=>{active=false;};},[id]);
  if (error) return <p role="alert">{error}</p>;
  if (!file) return <p>{uiText("加载中…")}</p>;
  return <div className="min-w-0 space-y-3">
    {file.mime.startsWith("image/") ? <img className="max-h-[60vh] w-full object-contain" src={`/v1/files/${id}/content`} alt={file.name} /> : file.mime.startsWith("video/") ? <video className="max-h-[60vh] w-full" controls preload="metadata" src={`/v1/files/${id}/content`} /> : null}
    <ResourceReader key={id} id={id} compact media={file.mime.startsWith("image/") || file.mime.startsWith("video/")} />
  </div>;
}

export function ConversationEvidence({ id, revision }: { id: string; revision?: string }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.conversationEvidence>>>();
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true, pending = false;
    const load = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      try { const value = await api.conversationEvidence(id); if (active) { setData(value); setError(""); } }
      catch (e) { if (active) setError(String(e)); }
      finally { pending = false; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    document.addEventListener("visibilitychange", load);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener("visibilitychange", load); };
  }, [id, open, revision, refresh]);
  return <details className="mt-4 rounded border p-3 text-sm" onToggle={event => setOpen(event.currentTarget.open)}><summary>{uiText("交付、反馈与执行记录")}</summary>
    {error ? <p role="alert">{error}</p> : !data ? <p>{uiText("加载中…")}</p> : <div className="mt-3 flex min-w-0 flex-col gap-3">
      {!data.deliverables.length && !data.feedback.length && !data.contexts.length ? <p>{uiText("暂无记录")}</p> : null}
      {data.deliverables.map(item => <DeliverableCard key={`${item.key}:${item.revision}`} id={id} item={item} onChange={() => setRefresh(n => n + 1)} />)}
      {data.feedback.map(item => <p key={item.entry_id} className="whitespace-pre-wrap">{uiText("反馈")}: {item.text}</p>)}
      {data.contexts.length ? <details><summary>{uiText("模型请求与工具（{0}）", [data.contexts.length])}</summary>{data.contexts.map(item => <details key={item.id} className="mt-2 break-words"><summary>{item.modelId} · {item.phase ? uiText("模型请求 {0}", [item.requestIndex]) : uiText("工具装配记录")}</summary>
        {item.phase ? <p>{uiText("文本 {0} 字符 · 内嵌图片 {1} · 远程图片链接 {2}", [item.textCharacters, item.embeddedImages, item.remoteImages])}</p> : null}
        <p className="text-muted-foreground">{uiText("记录请求准备时的内容；不代表模型已收到或理解。")}</p>
        <pre className="whitespace-pre-wrap break-all text-xs">{item.runId}{"\n"}{item.payloadHash}{"\n"}{item.tools.join("\n")}</pre>
      </details>)}</details> : null}
    </div>}
  </details>;
}

function DeliverableCard({ id, item, onChange }: { id: string; item: DeliverableRecord; onChange: () => void }) {
  const [preview,setPreview] = useState<string>();
  const [comparison,setComparison] = useState<DeliverableComparison>();
  const [versions, setVersions] = useState<DeliverableRecord[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const review = async (status: "accepted" | "rejected") => {
    setBusy(true); setError("");
    try { await api.reviewDeliverable(id, item.key, item.revision, status); setVersions(undefined); onChange(); }
    catch (e) { setError(String(e)); onChange(); }
    finally { setBusy(false); }
  };
  return <div className="min-w-0 break-words rounded border p-3">
    <b>{item.key} · {item.description}</b>
    <p>{uiText("版本 {0}", [item.revision ?? 0])} · {item.status === "verified" ? uiText("模型已检查") : item.status === "produced" ? uiText("已生成") : uiText("待完成")}
      {item.review ? ` · ${item.review.status === "accepted" ? uiText("用户已接受") : uiText("用户已退回")}` : ""}</p>
    {item.asset_id ? <a className="underline" href={`/v1/files/${item.asset_id}/content?download=1`}>{uiText("下载")}</a> : null}
    {item.asset_id ? <button className="ml-4 underline" onClick={()=>setPreview(current=>current === item.asset_id ? undefined : item.asset_id)}>{uiText("预览原件")}</button> : null}
    {preview ? <div className="mt-3 rounded border p-3"><p className="mb-2 text-xs">{uiText("预览版本 {0}",[preview === item.asset_id ? item.revision : versions?.find(v=>v.asset_id===preview)?.revision ?? ""] )}</p><ResourcePreview key={preview} id={preview} /></div> : null}
    {item.evidence ? <details className="mt-2"><summary>{uiText("检查依据")}</summary><p className="text-xs text-muted-foreground">{item.evidence}</p></details> : null}
    <div className="mt-2 flex flex-wrap gap-4">
      {item.asset_id && item.revision > 0 && item.status !== "pending" ? <>
        <button disabled={busy || item.review?.status === "accepted"} onClick={() => void review("accepted")}>{uiText("接受版本 {0}",[item.revision])}</button>
        <button disabled={busy || item.review?.status === "rejected"} onClick={() => void review("rejected")}>{uiText("退回版本 {0}",[item.revision])}</button>
      </> : null}
      <button onClick={() => void api.deliverableVersions(id, item.key).then(setVersions).catch(e => setError(String(e)))}>{uiText("查看版本")}</button>
    </div>
    {versions?.map(version => <div key={version.revision} className="mt-2 flex flex-wrap gap-3"><span>{uiText("版本 {0}", [version.revision])} · {version.description}</span>{version.asset_id ? <><a className="underline" href={`/v1/files/${version.asset_id}/content?download=1`}>{uiText("下载")}</a><button className="underline" onClick={()=>setPreview(version.asset_id)}>{uiText("预览原件")}</button>{item.asset_id && version.revision !== item.revision ? <button disabled={busy} className="underline" onClick={async()=>{setBusy(true);setError("");try {setComparison(await api.compareDeliverables(id,item.key,version.revision,item.revision));}catch(e){setError(String(e));}finally{setBusy(false);}}}>{uiText("与当前版本比较")}</button> : null}</> : null}</div>)}
    {comparison ? <section className="mt-3 min-w-0 rounded border p-3" aria-label={uiText("版本比较")}>
      <div className="mb-2 flex flex-wrap gap-3"><b>{uiText("版本 {0} → {1}",[comparison.from.revision,comparison.to.revision])}</b><button className="ml-auto underline" onClick={()=>setComparison(undefined)}>{uiText("关闭比较")}</button></div>
      {comparison.kind === "text" ? <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all text-xs">{comparison.patch.split("\n").map((line,index)=><span key={index} className={line.startsWith("+") ? "block bg-green-500/10" : line.startsWith("-") ? "block bg-red-500/10" : "block"}>{line || " "}</span>)}</pre> : <>
        <p className="mb-3 text-xs text-muted-foreground">{comparison.reason === "size" ? uiText("内容较大，请分别阅读原件；未生成完整文本差异。") : uiText("此格式使用原件并排预览。文档显示提取的文本。")}</p>
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">{[comparison.from,comparison.to].map(v=><div key={v.revision} className="min-w-0"><p>{uiText("版本 {0}",[v.revision])}</p><ResourcePreview id={v.asset_id!} /></div>)}</div>
      </>}
    </section> : null}
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
  </div>;
}

/** Original bytes are loaded by the client, never regenerated by the language model. */
export function ResourceQuote({ id }: { id: string }) {
  const [quote, setQuote] = useState<Awaited<ReturnType<typeof api.resourceQuote>>>();
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let active = true;
    setQuote(undefined); setError(""); setCopied(false);
    void api.resourceQuote(id).then(value => { if (active) setQuote(value); }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [id]);
  return <span className="my-2 block rounded-lg border bg-muted/30 p-3 not-italic" data-testid="resource-quote">
    {error ? <span role="alert">{error}</span> : !quote ? uiText("加载中…") : <>
      <span className="mb-2 block text-xs text-muted-foreground">{quote.title} · {quote.start_line}–{quote.end_line}</span>
      <span className="block max-h-96 overflow-auto whitespace-pre-wrap break-words">{quote.text}</span>
      <span className="mt-2 flex gap-3 text-xs">
        <button type="button" onClick={() => void navigator.clipboard.writeText(quote.text).then(() => setCopied(true)).catch(e => setError(String(e)))}>{copied ? uiText("已复制") : uiText("复制")}</button>
        <a href={`/v1/files/${quote.file_id}/content?download=1`}>{uiText("下载")}</a>
      </span>
    </>}
  </span>;
}

export function ResourceReader({ id, media = false, compact = false }: { id: string; media?: boolean; compact?:boolean }) {
  const [pages, setPages] = useState<Array<{line:number;character:number;version?:string}>>([{line:1,character:0}]);
  const cursor = pages.at(-1)!;
  const [encoding, setEncoding] = useState("");
  const [data, setData] = useState<Awaited<ReturnType<typeof api.resourceText>>>();
  const [sources, setSources] = useState<Awaited<ReturnType<typeof api.resourceSources>>>([]);
  const [error, setError] = useState("");
  useEffect(() => { setPages([{line:1,character:0}]); }, [id]);
  useEffect(() => { let active = true; void api.resourceSources(id).then(value => { if (active) setSources(value); }).catch(e => { if (active) setError(String(e)); }); return () => { active = false; }; }, [id]);
  useEffect(() => {
    if (media) return;
    let active = true; setData(undefined); setError("");
    void api.resourceText(id, cursor.line, encoding || undefined, cursor.character, cursor.version).then(value => { if (active) setData(value); }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [id, cursor, encoding, media]);
  return <div className="flex min-w-0 flex-col gap-3">
    <a className="text-sm underline" href={`/v1/files/${id}/content?download=1`}>{uiText("下载原件")}</a>
    {sources.map((source, index) => <a className="break-all text-xs underline" key={index} href={source.original_url} target="_blank" rel="noreferrer">{source.original_url}</a>)}
    {!media ? <><details open={!compact}><summary className={compact ? "text-xs" : "hidden"}>{uiText("文本编码")}</summary><select aria-label={uiText("文本编码")} className="w-full rounded border bg-background p-2" value={encoding} onChange={e => { setEncoding(e.target.value); setPages([{line:1,character:0}]); }}>
      <option value="">UTF-8 / PDF / DOCX / EPUB</option><option value="gb18030">GB18030</option><option value="big5">Big5</option><option value="utf-16le">UTF-16 LE</option>
    </select></details>
    {error ? <div><p role="alert" className="text-sm text-destructive">{error}</p><button onClick={() => setPages([{line:1,character:0}])}>{uiText("刷新")}</button></div> : data ? <>
      <p className="text-xs text-muted-foreground">{data.text_start_line} / {data.total_lines}{uiText(" · 第 {0} 页", [pages.length])}</p>
      <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words text-sm">{data.text}</pre>
      {!compact || pages.length > 1 || data.next_character !== null || data.next_line ? <div className="flex gap-4"><button disabled={pages.length === 1} onClick={() => setPages(current => current.slice(0,-1))}>{uiText("上一页")}</button><button disabled={data.next_character === null && !data.next_line} onClick={() => setPages(current => [...current, data.next_character !== null ? {...cursor,character:data.next_character,version:data.version} : {line:data.next_line!,character:0,version:data.version}])}>{uiText("下一页")}</button></div> : null}
    </> : <p>{uiText("加载中…")}</p>}</> : error ? <p role="alert">{error}</p> : null}
  </div>;
}
