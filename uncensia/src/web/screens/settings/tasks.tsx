import { uiText } from "../../i18n.tsx";
import { TaskPanel } from "../../ui/task-panel.tsx";
import { Section, SectionBody } from "../../ui.tsx";

export function TasksSection() {
  return <Section title={uiText("任务")} hint={uiText("后台工作、持续推进和定期执行也可以从侧栏的任务入口管理。")}><SectionBody><TaskPanel /></SectionBody></Section>;
}
