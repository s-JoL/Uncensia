import { uiText } from "../i18n.tsx";
import { useState } from "react";
import { CHARACTER_CARD_MAX_BYTES, previewCharacterCard, type CharacterCardPreview } from "@shared/character-card.ts";
import { Button } from "./button.tsx";
import { Textarea } from "./input.tsx";

export function CharacterCardImport({ onApply }: { onApply: (card: CharacterCardPreview) => void }) {
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<CharacterCardPreview>();
  const [error, setError] = useState("");
  const [applied, setApplied] = useState(false);
  const change = (text: string) => { setSource(text); setPreview(undefined); setError(""); setApplied(false); };
  return <details className="rounded-lg border p-3 text-sm">
    <summary className="cursor-pointer font-medium">{uiText("从角色卡导入设定")}</summary>
    <div className="mt-3 space-y-3">
      <p className="text-xs leading-relaxed text-muted-foreground">{uiText("读取 Character Card V2 JSON 的角色、场景和示例对白。预览后应用到草稿，保存对话设定才会生效。")}</p>
      <input type="file" accept=".json,application/json" aria-label={uiText("选择角色卡 JSON")} className="block w-full min-w-0 text-xs file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-2" onChange={async event => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        change("");
        if (file.size > CHARACTER_CARD_MAX_BYTES) { setError(uiText("角色卡 JSON 最大支持 1 MB")); return; }
        try { change(await file.text()); } catch { setError(uiText("无法读取文件，请重新选择")); }
      }} />
      <Textarea rows={4} value={source} aria-label={uiText("角色卡 JSON 内容")} placeholder={uiText("也可以在这里粘贴角色卡 JSON……")} onChange={event => change(event.target.value)} />
      <Button variant="outline" size="sm" disabled={!source.trim()} onClick={() => {
        try { setPreview(previewCharacterCard(source)); setError(""); setApplied(false); }
        catch (cause) { setPreview(undefined); setError(cause instanceof Error ? cause.message : String(cause)); }
      }}>{uiText("预览设定")}</Button>
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      {preview ? <div className="space-y-3 rounded-md bg-muted/40 p-3">
        <p className="font-medium">{preview.name}</p>
        {[[uiText("角色"), preview.character], [uiText("场景"), preview.scene], [uiText("示例对白"), preview.examples]].map(([label, value]) => <div key={label}>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="max-h-36 overflow-auto whitespace-pre-wrap break-words text-sm">{value || uiText("（空）")}</p>
        </div>)}
        {preview.creatorNotes ? <details><summary className="cursor-pointer text-xs">{uiText("作者说明（不用于生成）")}</summary><p className="mt-2 whitespace-pre-wrap break-words">{preview.creatorNotes}</p></details> : null}
        {preview.notices.length ? <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-muted-foreground">{preview.notices.map(notice => <li key={notice}>{notice}</li>)}</ul> : null}
        <Button variant="outline" size="sm" onClick={() => { onApply(preview); setApplied(true); }}>{uiText("替换角色、场景与示例草稿")}</Button>
        {applied ? <p role="status" className="text-xs">{uiText("已应用到下方草稿，检查后保存即可。")}</p> : null}
      </div> : null}
    </div>
  </details>;
}
