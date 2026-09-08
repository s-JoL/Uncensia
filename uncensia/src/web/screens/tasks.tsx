import { uiText } from "../i18n.tsx";
import { PageHeader, PageBody } from "../ui.tsx";
import { TaskPanel } from "../ui/task-panel.tsx";

export function Tasks({ onOpenRail }: { onOpenRail: () => void }) {
  return <><PageHeader title={uiText("任务")} onOpenRail={onOpenRail} /><PageBody>
    <p className="mb-5 text-sm text-muted-foreground">{uiText("安排后台工作、持续推进目标或定期执行。结果保留在所属对话，服务运行时会按计划继续。")}</p>
    <TaskPanel />
  </PageBody></>;
}
