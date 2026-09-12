import { uiText } from "../../i18n.tsx";
/**
 * Settings, one section per file. The section lives in the path, so a link can
 * point at one — `/settings/security` — and the back button behaves.
 */
import { Boxes, KeyRound, Plug, Server, SlidersHorizontal, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import type { Bootstrap } from "@shared/types.ts";
import { cn, PageHeader, Section, SectionBody, Button, Field, Select, Input, useAction } from "../../ui.tsx";
import { api } from "../../api.ts";
import { CapabilitiesSection } from "./capabilities.tsx";
import { GenerationSection, ModelsSection, ProvidersSection } from "./models.tsx";
import { PromptsSection } from "./prompts.tsx";
import { SecuritySection } from "./security.tsx";
import { ToolsSection } from "./tools.tsx";
import { SkillsSection } from "./skills.tsx";
import { TasksSection } from "./tasks.tsx";

type Tab = "overview" | "providers" | "models" | "skills" | "tasks" | "tools" | "capabilities" | "prompts" | "security";

/**
 * Ordered the way a deployment is set up: an endpoint, then something to talk to,
 * then the things that do work. Conversation models and generation backends are
 * separate pages because they have almost no settings in common, and the old
 * single list showed every row the union of both. `mcp` is gone as a page of
 * its own: an MCP server and a local image model are both "something that does
 * work when asked", and which of them is implemented as a subprocess is our
 * business rather than the reader's.
 */
const TABS: Array<{ id: Tab; label: string; group: string; icon: typeof Boxes }> = [
  { id: "overview", label: uiText("常用设置"), group: uiText("连接"), icon: SlidersHorizontal },
  { id: "providers", label: uiText("连接服务"), group: uiText("连接"), icon: Plug },
  { id: "models", label: uiText("模型"), group: uiText("连接"), icon: Boxes },
  { id: "tools", label: uiText("扩展连接"), group: uiText("能力"), icon: Server },
  { id: "skills", label: uiText("技能"), group: uiText("能力"), icon: Boxes },
  { id: "capabilities", label: uiText("工具与权限"), group: uiText("能力"), icon: SlidersHorizontal },
  { id: "tasks", label: uiText("任务"), group: uiText("系统"), icon: SlidersHorizontal },
  { id: "prompts", label: uiText("个性化"), group: uiText("系统"), icon: Terminal },
  { id: "security", label: uiText("访问与登录"), group: uiText("系统"), icon: KeyRound },
];

/** Where a link to a page that no longer exists should land instead. */
const MOVED: Record<string, Tab> = { mcp: "tools", profiles: "tools" };

function tabFromPath(): Tab {
  const slug = window.location.pathname.replace(/^\/settings\/?/, "");
  if (TABS.some((tab) => tab.id === slug)) return slug as Tab;
  return MOVED[slug] ?? "overview";
}

export function Settings({
  bootstrap,
  reload,
  onOpenRail,
}: {
  bootstrap: Bootstrap;
  reload: () => Promise<void>;
  onOpenRail: () => void;
}) {
  const [tab, setTab] = useState<Tab>(tabFromPath);
  const [search, setSearch] = useState("");
  const act = useAction();

  useEffect(() => {
    const onPop = () => setTab(tabFromPath());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const open = (id: Tab) => {
    setTab(id);
    // Replace rather than push: flipping sections should not fill the back stack.
    window.history.replaceState({}, "", `/settings/${id}`);
  };

  return (
    <>
      <PageHeader title={uiText("设置")} onOpenRail={onOpenRail}>
        <span className="text-xs text-muted-foreground">Uncensia {bootstrap.version}</span>
      </PageHeader>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <nav className="flex shrink-0 gap-1 overflow-x-auto px-3 pb-3 lg:w-52 lg:flex-col lg:overflow-y-auto lg:px-4">
          {TABS.map(({ id, label, group, icon: Icon }, index) => (
            <div key={id} className="contents lg:block">
              {(index === 0 || TABS[index - 1]?.group !== group) && (
                <div className="mt-2 hidden px-3 pb-1 text-[11px] font-medium tracking-wider text-muted-foreground/70 first:mt-0 lg:block">
                  {group}
                </div>
              )}
              <button
                aria-current={tab === id ? "page" : undefined}
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors lg:w-full",
                  tab === id
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
                onClick={() => open(id)}
              >
                <Icon className="size-4" />
                {label}
              </button>
            </div>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
            <Input aria-label={uiText("查找设置")} placeholder={uiText("查找模型、记忆、提示词、连接…")} className="h-11 rounded-xl" value={search} onChange={event => setSearch(event.target.value)} />
            {search.trim() ? <div className="rounded-2xl border p-2">
              {TABS.filter(item => `${item.label} ${{overview:uiText("默认 记忆 文件 资料"),providers:uiText("提供方 API 密钥 服务"),models:uiText("模型 生成 参数 上下文 长度 输出 温度"),skills:uiText("skill 技能 安装 编辑 启用 停用"),tasks:uiText("任务 定时 后台 计划 取消"),tools:uiText("MCP 工具 扩展"),capabilities:uiText("搜索 权限 文件 编码 记忆 嵌入 embedding 分块"),prompts:uiText("提示词 身份 作家 人设"),security:uiText("访问码 登录 安全 数据")}[item.id]}`.toLowerCase().includes(search.trim().toLowerCase())).map(item => <Button key={item.id} variant="ghost" className="w-full justify-start rounded-lg" onClick={() => { open(item.id); setSearch(""); }}>{item.label}</Button>)}
              <p className="px-3 py-2 text-xs text-muted-foreground">{uiText("选择分组查看和修改设置。")}</p>
            </div> : null}
            {tab === "overview" ? <>
              <Section title={uiText("默认模型")} hint={uiText("对话里临时切换只影响当前对话。这里设置新对话和创作的默认选择。")}><SectionBody>
                {([
                  [uiText("对话"), bootstrap.defaultModelId, "chat", "chat"],
                  [uiText("生成图片"), bootstrap.defaultImageModelId, "image", "imageModelId"],
                  [uiText("编辑与合成"), bootstrap.defaultEditModelId, "image", "editModelId"],
                  [uiText("视频"), bootstrap.defaultVideoModelId, "video", "videoModelId"],
                ] as const).map(([label, selected, kind, key]) => {
                  const options = bootstrap.models
                    .filter((model) => model.enabled && model.configured && model.kind === kind && (key !== "editModelId" || model.ops.includes("image_to_image")))
                    .map((model) => ({ value: model.id, label: model.name }));
                  const unavailable = Boolean(selected && !options.some((option) => option.value === selected));
                  const currentName = bootstrap.models.find((model) => model.id === selected)?.name ?? selected;
                  return <Field key={key} label={label}>
                    <Select value={selected} disabled={!options.length} placeholder={uiText("未配置可用模型")}
                      triggerLabel={unavailable ? uiText("{0}（当前不可用）", [currentName]) : undefined}
                      options={options} onChange={(value) => {
                        void act(async () => {
                          if (key === "chat") await api.setDefaultModel(value);
                          else await api.setGenerationDefaults({ [key]: value });
                          await reload();
                        }, uiText("已更新默认模型"));
                      }} />
                    {!options.length ? <p className="text-xs text-muted-foreground">{uiText("未配置可用模型，请在下方管理模型与连接。")}</p> : null}
                  </Field>;
                })}
                <Button variant="ghost" onClick={() => open("models")}>{uiText("管理模型与生成参数")}</Button>
              </SectionBody></Section>
              <Section title={uiText("个性化与资料")} hint={uiText("写作方式、记忆和文件各自管理。")}><SectionBody>
                <Button variant="outline" onClick={() => open("skills")}>{uiText("技能与改进记录")}</Button>
                <Button variant="outline" onClick={() => open("tasks")}>{uiText("管理长任务与定时任务")}</Button>
                <Button variant="outline" onClick={() => open("prompts")}>{uiText("助手身份与通用指令")}</Button>
                <a href="/library/memory" className="rounded-md border px-3 py-2 text-sm hover:bg-accent">{uiText("查看和更正记忆")}</a>
                <a href="/library" className="rounded-md border px-3 py-2 text-sm hover:bg-accent">{uiText("管理文件与作品")}</a>
              </SectionBody></Section>
              <Section title={uiText("连接与能力")}><SectionBody><p className="text-sm text-muted-foreground">{bootstrap.providers.filter((provider) => provider.enabled).length} {uiText("个提供方 ·")}{bootstrap.models.filter((model) => model.enabled && model.configured).length} {uiText("个可用模型")}</p><Button variant="outline" onClick={() => open("providers")}>{uiText("管理连接")}</Button><Button variant="ghost" onClick={() => open("capabilities")}>{uiText("搜索、文件和工具权限")}</Button></SectionBody></Section>
            </> : null}
            {tab === "providers" ? <ProvidersSection reload={reload} /> : null}
            {tab === "models" ? (
              <>
                <ModelsSection reload={reload} />
                <GenerationSection reload={reload} />
              </>
            ) : null}
            {tab === "tools" ? <ToolsSection reload={reload} /> : null}
            {tab === "skills" ? <SkillsSection /> : null}
            {tab === "tasks" ? <TasksSection /> : null}
            {tab === "capabilities" ? <CapabilitiesSection reload={reload} /> : null}
            {tab === "prompts" ? <PromptsSection reload={reload} /> : null}
            {tab === "security" ? <SecuritySection /> : null}
          </div>
        </div>
      </div>
    </>
  );
}
