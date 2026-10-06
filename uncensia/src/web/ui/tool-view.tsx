import { uiText } from "../i18n.tsx";
import { Check, ChevronDown } from "lucide-react";
import { memo } from "react";
import type { Turn } from "../messages.ts";
import { Badge, Spinner } from "./controls.tsx";

export function toolSummary(name: string, args: Record<string, unknown>) {
  if (name === "read" && typeof args.path === "string") return args.path.split(/[\\/]/).slice(-2).join("/");
  if (typeof args.intent === "string") return args.intent;
  if (typeof args.query === "string") return args.query;
  if (typeof args.prompt === "string") return String(args.prompt).slice(0, 90);
  if ((name === "import_file" || name === "publish_file") && typeof args.path === "string") return args.path;
  return "";
}

function ToolBody({ name, args, result, onImageClick }: { name: string; args: Record<string, unknown>; result: string; onImageClick?: (url: string) => void }) {
  if (name === "view_image" && typeof args.image_id === "string" && /^img_[0-9a-f]{32}$/i.test(args.image_id)) {
    const src = `/v1/images/${args.image_id}`;
    return <div className="flex items-center gap-3">
      <button type="button" className="shrink-0 cursor-zoom-in rounded-lg focus-visible:ring-2" aria-label={uiText("打开已检查的参考图")} onClick={() => onImageClick?.(src)}>
        <img src={`${src}?w=160`} alt={uiText("已检查的参考图")} loading="lazy" className="h-24 w-20 rounded-lg object-contain" />
      </button>
      <p className="min-w-0 break-all text-xs text-muted-foreground">{args.image_id}</p>
    </div>;
  }
  if (/^(generate_image|edit_image|generate_video)/.test(name) && typeof args.prompt === "string") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-xs whitespace-pre-wrap">{args.prompt}</p>
        {typeof args.source_image_id === "string" ? (
          <p className="font-mono text-xs text-muted-foreground">source {args.source_image_id}</p>
        ) : null}
      </div>
    );
  }
  return (
    <>
      <pre className="overflow-x-auto text-xs text-muted-foreground">{JSON.stringify(args, null, 2)}</pre>
      {result ? <pre className="max-h-60 overflow-auto text-xs whitespace-pre-wrap">{result}</pre> : null}
    </>
  );
}

/** The skill a native `read` of a skill's own SKILL.md is loading, if it is one. */
function skillRead(name: string, args: Record<string, unknown>) {
  if (name !== "read" || typeof args.path !== "string") return "";
  const parts = args.path.split(/[\\/]/);
  return parts.at(-1) === "SKILL.md" && parts.length > 1 ? parts.at(-2)! : "";
}

export const ToolView = memo(function ToolView({ part, onImageClick, retried }: {
  part: Extract<Turn["parts"][number], { kind: "tool" }>;
  onImageClick?: (url: string) => void;
  /** A later call of the same tool in this turn succeeded, so this failure was recovered. */
  retried?: boolean;
}) {
  const args = (part.args ?? {}) as Record<string, unknown>;
  // Loading a skill is how the assistant reads its own procedure. It is worth
  // knowing which one shaped the answer, not worth a step with a status badge.
  const skill = skillRead(part.name, args);
  if (skill && !part.isError) {
    return (
      <details className="group/tool text-xs text-muted-foreground">
        <summary className="flex w-fit cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 select-none hover:bg-muted/50">
          {part.running ? <Spinner className="size-3" /> : <ChevronDown className="size-3 transition-transform group-open/tool:rotate-180" />}
          {uiText("使用技能")} · {skill}
        </summary>
        {part.result ? <pre className="mt-1 max-h-60 overflow-auto rounded-lg border px-3 py-2 whitespace-pre-wrap">{part.result}</pre> : null}
      </details>
    );
  }
  const summary = toolSummary(part.name, args);
  const resourceLabels: Record<string, string> = { acquire_resource: uiText("获取网页原件"), list_resources: uiText("查找资料"), read_resource: uiText("读取原文"), quote_resource: uiText("展示原文"), search_history: uiText("查找历史"), track_deliverables: uiText("记录交付进度") };
  const labels: Record<string,string> = {manage_skill:uiText("管理技能"),manage_prompt:uiText("修改长期指令"),save_knowledge:uiText("保存知识资料"),learning_history:uiText("查看改进记录"),set_memory:uiText("记住"),delete_memory:uiText("忘记"),update_conversation_notes:uiText("更新对话笔记"),fetch_url:uiText("读取网页"),move_path:uiText("移动文件"),delete_path:uiText("删除文件"),restore_file:uiText("恢复文件"),create_task:uiText("安排任务"),list_tasks:uiText("查看任务"),control_task:uiText("控制任务"),report_task_progress:uiText("保存任务进度"),read:uiText("读取资料"),write:uiText("写入文件"),edit:uiText("修改文件"),grep:uiText("搜索内容"),find:uiText("查找文件"),ls:uiText("查看目录"),bash:uiText("执行命令"),web_search:uiText("搜索网页"),file_search:uiText("查阅文件"),import_file:uiText("复制到工作区"),publish_file:uiText("保存工作成果"),view_image:uiText("查看图片"),generate_image:uiText("生成图片"),edit_image:uiText("编辑图片"),generate_video:uiText("生成视频"),inspect_generations:uiText("核对生成记录")};

  return (
    <details className="group/tool rounded-xl text-sm">
      <summary className="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-2 text-muted-foreground select-none hover:bg-muted/50">
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open/tool:rotate-180" />
        <span className="shrink-0 text-sm">{resourceLabels[part.name] ?? labels[part.name] ?? part.name}</span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{summary}</span>
        {part.running ? (
          <Spinner className="text-muted-foreground" />
        ) : part.cancelled ? (
          <Badge tone="neutral">{uiText("已停止")}</Badge>
        ) : part.isError ? (
          retried ? <Badge tone="neutral">{uiText("已重试")}</Badge> : <Badge tone="danger">{uiText("失败")}</Badge>
        ) : (
          <Check aria-label={uiText("完成")} className="size-3.5 shrink-0 text-muted-foreground" />
        )}
      </summary>
      <div className="flex flex-col gap-2 border-t px-3 py-2">
        <span className="font-mono text-xs text-muted-foreground">{part.name}</span>
        {part.name !== "view_image" || (!part.isError && !part.running) ? <ToolBody name={part.name} args={args} result={part.result} onImageClick={onImageClick} /> : null}
        {part.isError && !part.cancelled && part.result ? <p role="alert" className="whitespace-pre-wrap text-xs text-destructive">{part.result}</p> : null}
      </div>
    </details>
  );
});
