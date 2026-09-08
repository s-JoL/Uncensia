import { uiText } from "../i18n.tsx";
import { Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isMemoryKey } from "@shared/types.ts";
import { api, type MemorySnapshot } from "../api.ts";
import {
  Badge,
  Button,
  Empty,
  Field,
  formatTime,
  Input,
  Modal,
  PageBody,
  PageHeader,
  Section,
  SectionBody,
  Textarea,
  useAction,
  useToast,
} from "../ui.tsx";

export function Memory({ onOpenRail, navigation }: { onOpenRail: () => void; navigation?: React.ReactNode }) {
  const toast = useToast();
  const act = useAction();
  const refreshVersion = useRef(0);
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [loadError, setLoadError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** Keys the reader coined here; they become real once a value is saved. */
  const [added, setAdded] = useState<string[]>([]);
  const [naming, setNaming] = useState(false);
  const [newKey, setNewKey] = useState("");

  useEffect(() => {
    let active = true;
    setLoadError("");
    let pending = false;
    const refresh = async () => {
      if (pending || document.visibilityState === "hidden") return;
      pending = true;
      const version = ++refreshVersion.current;
      try { const value = await api.memory(); if (active && version === refreshVersion.current) { setSnapshot(value); setLoadError(""); } }
      catch (error) { if (active && version === refreshVersion.current) setLoadError(String(error)); }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [attempt]);

  if (!snapshot) return <>
    <PageHeader title={uiText("资料库")} onOpenRail={onOpenRail} />
    {navigation ? <div className="shrink-0 border-b px-4 py-2">{navigation}</div> : null}
    <Empty>{loadError ? <><p role="alert">{uiText("无法加载记忆：")}{loadError}</p><Button onClick={() => setAttempt(value => value + 1)}>{uiText("重试")}</Button></> : uiText("正在加载…")}</Empty>
  </>;

  const stored = new Map(snapshot.items.map((item) => [item.key, item]));
  const existingKeys = new Set([...stored.keys(), ...added, ...Object.keys(drafts)]);
  // Stored keys first, then anything just added here, so a subject the model or
  // the reader coined is never hidden behind the suggestions neither of them used.
  const keys = [...existingKeys];
  const usage = snapshot.limit ? Math.min(100, (snapshot.tokens / snapshot.limit) * 100) : 0;

  /** Drops the draft so the field falls back to what the server now holds. */
  const forget = (key: string) =>
    setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([name]) => name !== key)));

  const save = async (key: string) => {
    const value = (drafts[key] ?? stored.get(key)?.value ?? "").trim();
    if (!value) return;
    const ok = await act(async () => { const updated = await api.setMemory(key, value); refreshVersion.current++; setSnapshot(updated); }, uiText("已保存"));
    if (ok) forget(key);
  };

  return (
    <>
      <PageHeader title={uiText("资料库")} onOpenRail={onOpenRail}>
        <span className="text-xs text-muted-foreground">
          {snapshot.tokens} / {snapshot.limit} tokens
        </span>
        <Button size="sm" onClick={() => setNaming(true)}>
          <Plus />
          {uiText("新建条目")}</Button>
      </PageHeader>
      {navigation ? <div className="shrink-0 border-b px-4 py-2">{navigation}</div> : null}

      <PageBody>
        <div className="flex flex-col gap-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className={usage > 90 ? "h-full rounded-full bg-warning" : "h-full rounded-full bg-primary"}
              style={{ width: `${usage}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {uiText("这些记忆适用于所有对话。只有你明确要求时，助手才会保存或修改；你也可以在这里更正和删除。")}</p>
        </div>

        {keys.length === 0 ? (
          <Section>
            <SectionBody>
              <p className="text-sm text-muted-foreground">
                {uiText("还没有保存的记忆。你可以新建条目，或者在对话里说「请记住……」。")}</p>
            </SectionBody>
          </Section>
        ) : null}

        {keys.map((key) => {
          const item = stored.get(key);
          const value = drafts[key] ?? item?.value ?? "";
          const dirty = value !== (item?.value ?? "");
          return (
            <Section
              key={key}
              title={<span className="font-mono text-xs">{key}</span>}
              actions={
                item ? (
                  <span className="text-xs text-muted-foreground">
                    {item.tokens} tokens · {formatTime(item.updatedAt)}
                  </span>
                ) : (
                  <Badge tone="outline">{uiText("空")}</Badge>
                )
              }
            >
              <SectionBody className="gap-3">
                {item?.sourceConversationId ? <a className="text-xs text-primary underline" href={`/c/${item.sourceConversationId}`}>{uiText("查看保存这条记忆的对话")}</a> : <p className="text-xs text-muted-foreground">{uiText("手动维护或历史记录")}</p>}
                <Textarea
                  rows={Math.min(10, Math.max(3, value.split("\n").length + 1))}
                  value={value}
                  placeholder={uiText("尚未记录")}
                  onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
                />
                <div className="flex items-center gap-2">
                  <Button variant="primary" size="sm" disabled={!dirty || !value.trim()} onClick={() => void save(key)}>
                    {uiText("保存")}</Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    disabled={!item}
                    onClick={() =>
                      void act(async () => {
                        const updated = await api.deleteMemory(key);
                        refreshVersion.current++;
                        setSnapshot(updated);
                        forget(key);
                      }, uiText("已删除"))
                    }
                  >
                    {uiText("删除")}</Button>
                  <span
                    className={
                      value.length > snapshot.charLimit
                        ? "ml-auto text-xs text-destructive"
                        : "ml-auto text-xs text-muted-foreground"
                    }
                  >
                    {value.length} / {snapshot.charLimit}
                  </span>
                </div>
              </SectionBody>
            </Section>
          );
        })}
      </PageBody>

      <Modal
        open={naming}
        onOpenChange={(open) => {
          setNaming(open);
          if (!open) setNewKey("");
        }}
        title={uiText("新建记忆条目")}
        description={uiText("先起个名称，保存内容后才会真正写入")}
        footer={
          <Button
            variant="primary"
            disabled={Boolean(keyError(newKey, existingKeys))}
            onClick={() => {
              setAdded((current) => [...current, newKey.trim()]);
              setNaming(false);
              setNewKey("");
            }}
          >
            {uiText("创建")}</Button>
        }
      >
        <Field
          label={uiText("名称")}
          hint={uiText("字母、数字、下划线或连字符，最多 64 个字符")}
          error={newKey.trim() ? keyError(newKey, existingKeys) : undefined}
        >
          <Input
            value={newKey}
            autoFocus
            placeholder={uiText("例如 coffee_order")}
            onChange={(event) => setNewKey(event.target.value)}
          />
        </Field>
      </Modal>
    </>
  );
}

/** The server's own rule, so a key the API would refuse is never offered. */
function keyError(key: string, taken: Set<string>) {
  const name = key.trim();
  if (!name) return uiText("请输入名称");
  if (!isMemoryKey(name)) return uiText("只能使用字母、数字、下划线和连字符，长度 1–64");
  if (taken.has(name)) return uiText("这个名称已经存在");
  return "";
}
