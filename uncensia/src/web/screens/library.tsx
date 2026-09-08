import { uiText } from "../i18n.tsx";
import { useState } from "react";
import { Files } from "./files.tsx";
import { Memory } from "./memory.tsx";
import { cn } from "../ui.tsx";

/** Files and personal memory share a place, but retain their distinct controls. */
export function Library({ onOpenRail, initialTab = "files" }: { onOpenRail: () => void; initialTab?: "files" | "memory" }) {
  const [tab, setTab] = useState(initialTab);
  const navigation = (
    <div className="flex gap-1 rounded-lg bg-muted p-1" role="tablist" aria-label={uiText("资料库内容")}>
      {([['files', uiText("文件与作品")], ['memory', uiText("记忆")]] as const).map(([id, label]) => (
        <button key={id} role="tab" aria-selected={tab === id} className={cn("whitespace-nowrap rounded-md px-3 py-1.5 text-sm", tab === id ? "bg-background shadow-sm" : "text-muted-foreground")} onClick={() => { setTab(id); window.history.replaceState(null, "", id === "memory" ? "/library/memory" : "/library"); }}>{label}</button>
      ))}
    </div>
  );
  return tab === "files" ? <Files onOpenRail={onOpenRail} navigation={navigation} /> : <Memory onOpenRail={onOpenRail} navigation={navigation} />;
}
