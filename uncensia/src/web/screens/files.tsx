import { uiText } from "../i18n.tsx";
import { Eye, FileText, Pencil, Play, RefreshCw, Search, Trash2, Upload, LayoutGrid, List, Plus, MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileFacets, FileKind, FileRecord } from "@shared/types.ts";
import { FILE_SOURCE_LABELS } from "@shared/types.ts";
import { api, type FileHit } from "../api.ts";
import { handToChat } from "../chat-draft.ts";
import { ResourceReader } from "../resource-view.tsx";
import {
  Badge,
  Button,
  cn,
  Field,
  formatBytes,
  formatTime,
  ImageThumb,
  Input,
  Lightbox,
  Modal,
  Menu,
  MenuItem,
  PageBody,
  PageHeader,
  Row,
  Section,
  SectionBody,
  Spinner,
  Textarea,
  useAction,
  useToast,
  VideoView,
} from "../ui.tsx";

const PAGE = 60;

const KIND_LABEL: Record<FileKind, string> = { all: uiText("全部"), docs: uiText("文档"), images: uiText("图片"), videos: uiText("视频") };
const MATCH_LABEL: Record<string, string> = { keyword: uiText("关键词匹配"), semantic: uiText("语义匹配"), hybrid: uiText("综合匹配") };

const STATUS: Record<string, { text: string; tone: "success" | "warning" | "danger" | "outline" }> = {
  ready: { text: uiText("已索引"), tone: "success" },
  indexed: { text: uiText("可检索"), tone: "success" },
  pending: { text: uiText("索引中"), tone: "warning" },
  failed: { text: uiText("失败"), tone: "danger" },
  none: { text: uiText("未索引"), tone: "outline" },
};

const EMPTY_FACETS: FileFacets = { kinds: { all: 0, docs: 0, images: 0, videos: 0 }, sources: [] };

const sourceLabel = (id: string) => uiText(FILE_SOURCE_LABELS[id] ?? id);

/** Text documents are the only ones that can be opened in the built-in editor. */
const isEditable = (file: FileRecord) => file.source !== "excerpt" && (file.mime.startsWith("text/") || file.mime === "application/json");

function Chip({ on, count, children, onClick }: { on: boolean; count?: number; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
        on ? "border-primary bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-accent",
      )}
      onClick={onClick}
    >
      {children}
      {count === undefined ? null : <span className="text-muted-foreground">{count}</span>}
    </button>
  );
}

export function Files({ onOpenRail, navigation }: { onOpenRail: () => void; navigation?: React.ReactNode }) {
  const toast = useToast();
  const act = useAction();
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [facets, setFacets] = useState<FileFacets>(EMPTY_FACETS);
  const [total, setTotal] = useState(0);
  const [kind, setKind] = useState<FileKind>("all");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [source, setSource] = useState("all");
  const [needle, setNeedle] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<FileHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string; text: string } | null>(null);
  const [zoom, setZoom] = useState("");
  /** The clip being watched. Separate from `zoom`, which is a still in a lightbox. */
  const [playing, setPlaying] = useState("");
  const [importUrl, setImportUrl] = useState<string | null>(null);
  const [importError, setImportError] = useState("");
  const [reading, setReading] = useState<FileRecord | null>(null);

  const filter = useMemo(() => ({ kind, source, q: needle.trim() }), [kind, source, needle]);
  const currentFilter = useRef(filter);
  currentFilter.current = filter;
  const loadSequence = useRef(0);

  const refresh = useCallback(
    async (limit = shown) => {
      if (currentFilter.current !== filter) return;
      const sequence = ++loadSequence.current;
      const library = await api.files({ ...filter, limit, offset: 0 });
      if (currentFilter.current !== filter || sequence !== loadSequence.current) return;
      setFiles(library.items);
      setFacets(library.facets);
      setTotal(library.total);
    },
    [filter, shown],
  );

  // A changed filter always restarts at the first page.
  useEffect(() => {
    let active = true;
    const sequence = ++loadSequence.current;
    setShown(PAGE);
    void api
      .files({ ...filter, limit: PAGE, offset: 0 })
      .then((library) => {
        if (!active || currentFilter.current !== filter || sequence !== loadSequence.current) return;
        setFiles(library.items);
        setFacets(library.facets);
        setTotal(library.total);
      })
      .catch((error: unknown) => { if (active && sequence === loadSequence.current) toast(String(error), true); });
    return () => { active = false; };
  }, [filter, toast]);

  // Indexing runs in the background, so poll while anything is pending.
  useEffect(() => {
    if (!files.some((file) => file.embeddingStatus === "pending")) return;
    const timer = setInterval(() => void refresh().catch(() => undefined), 1500);
    return () => clearInterval(timer);
  }, [files, refresh]);

  const upload = async (list: FileList | File[]) => {
    setBusy(true);
    for (const file of Array.from(list)) await act(() => api.upload(file));
    setBusy(false);
    await refresh();
  };

  const search = async () => {
    const text = query.trim();
    if (!text) {
      setHits(null);
      return;
    }
    setBusy(true);
    try {
      setHits((await api.searchFiles(text)).results);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title={uiText("资料库")} onOpenRail={onOpenRail}>
        <Button size="sm" onClick={() => { setImportError(""); setImportUrl(""); }}>{uiText("从链接导入")}</Button>
        {busy ? <Spinner className="text-muted-foreground" /> : null}
        <Button size="sm" onClick={() => setEditing({ id: "", name: "", text: "" })}>
          {uiText("新建文档")}</Button>
        <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90">
          <Upload className="size-3.5" />
          {uiText("上传")}<input
            type="file"
            multiple
            className="sr-only"
            aria-label={uiText("上传文件")}
            onChange={(event) => {
              if (event.target.files?.length) void upload(event.target.files);
              event.target.value = "";
            }}
          />
        </label>
      </PageHeader>
      <Modal open={importUrl !== null} onOpenChange={open => !open && setImportUrl(null)} title={uiText("从链接导入")}>
        <div className="flex flex-col gap-3">
          <Input value={importUrl ?? ""} onChange={e => setImportUrl(e.target.value)} placeholder="https://…" aria-label="URL" />
          {importError ? <p role="alert" className="break-words text-sm text-destructive">{importError}</p> : null}
          <Button disabled={busy || !importUrl?.trim()} onClick={() => void act(async () => {
            setBusy(true); setImportError("");
            try { const result = await api.acquireResource(importUrl!); await refresh(); setImportUrl(null); if (result.index_error) toast(result.index_error, true); }
            catch (error) { setImportError(String(error)); }
            finally { setBusy(false); }
          })}>{busy ? uiText("正在获取并索引…") : uiText("导入")}</Button>
        </div>
      </Modal>
      <Modal open={reading !== null} onOpenChange={open => !open && setReading(null)} title={reading?.name ?? ""}>
        {reading ? <ResourceReader key={reading.id} id={reading.id} media={reading.mime.startsWith("image/") || reading.mime.startsWith("video/")} /> : null}
      </Modal>
      {navigation ? <div className="shrink-0 border-b px-4 py-2">{navigation}</div> : null}

      <div
        className="flex min-h-0 flex-1 flex-col"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (event.dataTransfer.files.length) void upload(event.dataTransfer.files);
        }}
      >
        <PageBody>
          <details className="rounded-2xl border border-border/60 p-4">
            <summary className="cursor-pointer text-sm text-muted-foreground">{uiText("搜索文档内容")}</summary>
            <SectionBody>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-8"
                    value={query}
                    placeholder={uiText("关键词或一句话")}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void search();
                    }}
                  />
                </div>
                <Button onClick={() => void search()}>{uiText("搜索")}</Button>
              </div>
              {hits?.length === 0 ? (
                <p className="text-sm text-muted-foreground">{uiText("没有命中任何片段。")}</p>
              ) : null}
              {hits?.map((hit) => (
                <div key={hit.chunkId} className="flex flex-col gap-1 rounded-lg border bg-muted/30 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge tone="outline">{MATCH_LABEL[hit.matchType] ?? uiText("匹配")}</Badge>
                    <strong className="text-sm">{hit.name}</strong>
                    <span className="text-muted-foreground">
                      {uiText("片段")}{hit.chunk + 1}
                      {hit.page ? uiText(" · 第 {0} 页", [hit.page]) : ""}
                    </span>
                  </div>
                  <p className="text-sm whitespace-pre-wrap text-muted-foreground">
                    {hit.excerpt.slice(0, 320)}
                    {hit.excerpt.length > 320 ? "…" : ""}
                  </p>
                </div>
              ))}
            </SectionBody>
            </details>

          <Section
            title={uiText("文件（{0}）", [total])}
            actions={
              <Input
                className="h-8 max-w-50 text-sm"
                placeholder={uiText("按文件名筛选")}
                value={needle}
                onChange={(event) => setNeedle(event.target.value)}
              />
            }
          >
            <div className="flex flex-col gap-2 border-b px-4 py-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs text-muted-foreground">{uiText("类型")}</span>
                {(["all", "docs", "images", "videos"] as FileKind[]).map((option) => (
                  <Chip
                    key={option}
                    on={kind === option}
                    count={facets.kinds[option]}
                    onClick={() => setKind(option)}
                  >
                    {KIND_LABEL[option]}
                  </Chip>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-xs text-muted-foreground">{uiText("来源")}</span>
                <Chip on={source === "all"} onClick={() => setSource("all")}>
                  {uiText("全部")}</Chip>
                {facets.sources.map((entry) => (
                  <Chip
                    key={entry.id}
                    on={source === entry.id}
                    count={entry.count}
                    onClick={() => setSource(entry.id)}
                  >
                    {sourceLabel(entry.id)}
                  </Chip>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between px-4 pb-3 text-sm text-muted-foreground">
              <span>{total} {uiText("份资料与作品")}</span>
              <div className="flex gap-1" role="group" aria-label={uiText("资料库布局")}>
                <Button size="icon-sm" variant={view === "grid" ? "secondary" : "ghost"} aria-label={uiText("网格视图")} aria-pressed={view === "grid"} onClick={() => setView("grid")}><LayoutGrid /></Button>
                <Button size="icon-sm" variant={view === "list" ? "secondary" : "ghost"} aria-label={uiText("列表视图")} aria-pressed={view === "list"} onClick={() => setView("list")}><List /></Button>
              </div>
            </div>
            {files.length === 0 ? (
              <SectionBody>
                <p className="text-sm text-muted-foreground">
                  {uiText("没有符合条件的文件。拖拽到此页面可以上传，生成的图片和视频也会自动进入这里。")}</p>
              </SectionBody>
            ) : view === "grid" ? <div className="grid grid-cols-2 gap-4 px-4 pb-4 lg:grid-cols-3 xl:grid-cols-4">
              {files.map(file => <article key={file.id} className="group overflow-hidden rounded-2xl border border-border/60 bg-background transition-shadow hover:shadow-md">
                <button className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden bg-muted/50" aria-label={uiText("预览 {0}", [file.name])} onClick={async () => {
                  if (file.mime.startsWith("image/")) setZoom(`/v1/images/${file.id}`);
                  else if (file.mime.startsWith("video/")) setPlaying(file.id);
                  else setReading(file);
                }}>
                  {file.mime.startsWith("image/") ? <img src={`/v1/images/${file.id}?w=320`} alt="" loading="lazy" className="size-full object-cover transition-transform duration-200 group-hover:scale-[1.03]" /> : file.mime.startsWith("video/") ? <Play className="size-9 text-muted-foreground/60" /> : <FileText className="size-9 text-muted-foreground/60" />}
                </button>
                <div className="p-3">
                  <p className="truncate text-sm font-medium" title={file.name}>{file.name}</p>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{formatBytes(file.bytes)} · {sourceLabel(file.source)}</p>
                  <div className="mt-3 flex items-center justify-between">
                    {!file.mime.startsWith("video/") ? <Button size="sm" variant="ghost" className="h-8 rounded-full px-2 text-xs" onClick={() => handToChat(file)}><Plus />{uiText("加入对话")}</Button> : <span />}
                    <Menu trigger={<Button size="icon-sm" variant="ghost" aria-label={uiText("{0} 的操作", [file.name])}><MoreHorizontal /></Button>}>
                      <MenuItem onSelect={() => setReading(file)}>{uiText("查看原文与来源")}</MenuItem>
                      {isEditable(file) ? <MenuItem onSelect={() => void act(async () => { setEditing(await api.fileText(file.id)); })}>{uiText("编辑 {0}", [file.name])}</MenuItem> : null}
                      {file.mime.startsWith("image/") ? <MenuItem onSelect={() => handToChat(file,"base")}>{uiText("修改这张图片")}</MenuItem> : null}
                      <MenuItem onSelect={() => window.open(`/v1/files/${file.id}/content`, "_blank", "noopener")}>{uiText("下载原文件")}</MenuItem>
                      <MenuItem danger onSelect={() => void act(() => api.deleteFile(file.id)).then(() => refresh())}>{uiText("删除")}</MenuItem>
                    </Menu>
                  </div>
                </div>
              </article>)}
            </div> : (
              files.map((file) => {
                const status = STATUS[file.embeddingStatus] ?? STATUS.none!;
                const isImage = file.mime.startsWith("image/");
                const isVideo = file.mime.startsWith("video/");
                // What the row offers turns on this rather than on "is an image":
                // a clip is looked at, not indexed, and it used to land in the
                // document half of every one of these decisions — a filename with
                // a page icon, an index button, and no way to play it.
                const visual = isImage || isVideo;
                return (
                  // The row's default first-child width is meant for a label,
                  // and it stretched the thumbnail into a strip.
                  <Row key={file.id} className="[&>*:first-child]:min-w-0">
                    {isImage ? (
                      // A row thumbnail must never pull the full-size original.
                      <ImageThumb
                        className="size-12 cursor-zoom-in"
                        imageId={file.id}
                        label={uiText("查看 {0}", [file.name])}
                        onOpen={() => setZoom(`/v1/images/${file.id}`)}
                      />
                    ) : isVideo ? (
                      // No thumbnail exists for a clip, so this is the clip: the
                      // first frame, which `preload="metadata"` and a route that
                      // honours `Range` fetch the head of the file for.
                      <button
                        className="size-12 shrink-0 overflow-hidden rounded-md border"
                        aria-label={uiText("播放 {0}", [file.name])}
                        onClick={() => setPlaying(file.id)}
                      >
                        <video
                          className="size-full object-cover"
                          src={`/v1/videos/${file.id}`}
                          preload="metadata"
                          muted
                        />
                      </button>
                    ) : (
                      <span className="grid size-9 shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground">
                        <FileText className="size-4" />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{file.name}</div>
                      <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                        <Badge tone="outline">{sourceLabel(file.source)}</Badge>
                        {formatBytes(file.bytes)} · {formatTime(file.createdAt)}
                        {file.chunkCount ? uiText(" · {0} 片段", [file.chunkCount]) : ""}
                        {file.embeddingError ? ` · ${file.embeddingError}` : ""}
                      </div>
                    </div>
                    {visual ? null : <Badge tone={status.tone}>{status.text}</Badge>}
                    {visual ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={isVideo ? uiText("播放 {0}", [file.name]) : uiText("查看大图 {0}", [file.name])}
                        onClick={() => (isVideo ? setPlaying(file.id) : setZoom(`/v1/images/${file.id}`))}
                      >
                        {isVideo ? <Play /> : <Eye />}
                      </Button>
                    ) : null}
                    <Button variant="ghost" size="icon-sm" aria-label={uiText("查看原文与来源")} onClick={() => setReading(file)}><FileText /></Button>
                    {isEditable(file) ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={uiText("编辑 {0}", [file.name])}
                        onClick={async () => {
                          try {
                            setEditing(await api.fileText(file.id));
                          } catch (error) {
                            toast(error instanceof Error ? error.message : String(error), true);
                          }
                        }}
                      >
                        <Pencil />
                      </Button>
                    ) : null}
                    {visual ? null : (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={uiText("重建索引 {0}", [file.name])}
                        onClick={() =>
                          void act(() => api.reindexFile(file.id), uiText("已重新索引")).then(() => refresh())
                        }
                      >
                        <RefreshCw />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={uiText("删除 {0}", [file.name])}
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => void act(() => api.deleteFile(file.id)).then(() => refresh())}
                    >
                      <Trash2 />
                    </Button>
                  </Row>
                );
              })
            )}
            {total > files.length ? (
              <SectionBody>
                <Button
                  onClick={() => {
                    const next = shown + PAGE;
                    setShown(next);
                    void refresh(next).catch((error: unknown) => toast(String(error), true));
                  }}
                >
                  {uiText("加载更多（{0}/{1}）", [files.length, total])}
                </Button>
              </SectionBody>
            ) : null}
          </Section>
        </PageBody>
      </div>

      {editing ? (
        <NoteEditor
          note={editing}
          onCancel={() => setEditing(null)}
          onSave={async (name, text) => {
            const ok = await act(
              () => (editing.id ? api.saveFileText(editing.id, name, text) : api.createNote(name, text)),
              uiText("已保存"),
            );
            if (ok) {
              setEditing(null);
              await refresh();
            }
          }}
        />
      ) : null}

      {zoom ? <Lightbox src={zoom} onClose={() => setZoom("")} /> : null}

      {/* A dialog rather than the lightbox, which is built around an `<img>`, and
          a clip needs its controls reachable rather than a backdrop that closes
          on the first click near them. */}
      <Modal open={Boolean(playing)} onOpenChange={(open) => !open && setPlaying("")} title={uiText("播放")}>
        {playing ? <VideoView className="max-h-[70dvh]" videoId={playing} /> : null}
      </Modal>
    </>
  );
}

function NoteEditor({
  note,
  onCancel,
  onSave,
}: {
  note: { id: string; name: string; text: string };
  onCancel: () => void;
  onSave: (name: string, text: string) => Promise<void>;
}) {
  const [name, setName] = useState(note.name);
  const [text, setText] = useState(note.text);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => area.current?.focus(), []);

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onCancel()}
      title={note.id ? uiText("编辑文档") : uiText("新建文档")}
      description={uiText("保存到资料库；开启文档搜索时会更新检索内容。")}
      className="w-[min(44rem,calc(100vw-2rem))]"
      footer={
        <>
          <Button onClick={onCancel}>{uiText("取消")}</Button>
          <Button variant="primary" disabled={!text.trim()} onClick={() => void onSave(name, text)}>
            {uiText("保存")}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label={uiText("文件名")}>
          <Input value={name} placeholder={uiText("例如 项目笔记.md")} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={uiText("内容（Markdown）")}>
          <Textarea ref={area} rows={14} value={text} onChange={(event) => setText(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
