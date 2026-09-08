import { uiText } from "../i18n.tsx";
import { useEffect, useState } from "react";
import type { FileRecord } from "@shared/types.ts";
import { api } from "../api.ts";
import { Button, Input, Modal, Spinner } from "../ui.tsx";

const PAGE_SIZE = 48;

export function AssetPicker({ onSelect, onClose }: { onSelect: (file: FileRecord) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setBusy(true);
    const timer = setTimeout(() => {
      api.files({ kind: "all", q: query, limit: PAGE_SIZE, offset }).then((result) => {
        if (active) {
          setFiles(previous => offset ? [...new Map([...previous, ...result.items].map(file => [file.id, file])).values()] : result.items);
          setTotal(result.total); setError("");
        }
      }).catch((error) => { if (active) setError(String(error.message ?? error)); }).finally(() => { if (active) setBusy(false); });
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [query, offset]);
  return <Modal open title={uiText("从资料库引用")} description={uiText("引用现有文件和作品，保留原来的文件身份。")} onOpenChange={(open) => { if (!open) onClose(); }}>
    <Input aria-label={uiText("搜索资料库")} placeholder={uiText("搜索文件名称")} value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); setFiles([]); }} />
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <div className="mt-3 grid max-h-[55vh] grid-cols-3 gap-2 overflow-y-auto">
      {files.filter((file) => !file.mime.startsWith("video/")).map((file) => <button key={file.id} className="min-w-0 rounded-lg border p-2 text-left hover:bg-accent" onClick={() => onSelect(file)} title={file.name}>
        {file.mime.startsWith("image/") ? <img src={`/v1/images/${file.id}?w=160`} alt={file.name} className="aspect-square w-full rounded-md object-contain" loading="lazy" /> : <div className="grid aspect-square place-content-center bg-muted text-sm">{uiText("文档")}</div>}
        <span className="mt-1 block truncate text-xs">{file.name}</span>
      </button>)}
    </div>
    {busy ? <Spinner /> : !files.length ? <p className="py-4 text-sm text-muted-foreground">{uiText("没有找到资料")}</p> : null}
    {offset + PAGE_SIZE < total ? <Button disabled={busy} onClick={() => setOffset((value) => value + PAGE_SIZE)}>{uiText("加载更多")}</Button> : null}
  </Modal>;
}
