import { uiText } from "../../i18n.tsx";
import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { Capabilities } from "@shared/types.ts";
import { SEARCH_PROVIDERS } from "@shared/types.ts";
import { api } from "../../api.ts";
import {
  Badge,
  Button,
  cn,
  Empty,
  Field,
  Input,
  Section,
  SectionBody,
  Select,
  Spinner,
  Switch,
  useAction,
  useToast,
} from "../../ui.tsx";

interface ReindexProgress {
  done: number;
  total: number;
  failed: number;
}

export function CapabilitiesSection({ reload }: { reload: () => Promise<void> }) {
  const act = useAction();
  const toast = useToast();
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [tavilyKey, setTavilyKey] = useState("");
  const [embeddingKey, setEmbeddingKey] = useState("");
  const [reindexing, setReindexing] = useState(false);
  const [progress, setProgress] = useState<ReindexProgress | null>(null);

  useEffect(() => {
    api.capabilities()
      .then((caps) => {
        setCapabilities(caps);
      })
      .catch((error: unknown) => toast(String(error), true));
  }, [toast]);

  if (!capabilities) return <Empty>{uiText("正在加载…")}</Empty>;

  const patch = async (input: Parameters<typeof api.updateCapabilities>[0]) => {
    await act(async () => {
      setCapabilities(await api.updateCapabilities(input));
      await reload();
    });
  };

  /**
   * Re-slices and re-embeds every document with the parameters that are saved
   * now. One file at a time: the count is the only progress the reader gets,
   * and firing the whole library at the embedding provider at once would trade
   * it for rate limits. A file that fails is counted, not fatal — the rest have
   * no reason to stay on stale chunks.
   */
  const reindexAll = async () => {
    setReindexing(true);
    setProgress({ done: 0, total: 0, failed: 0 });
    const ok = await act(async () => {
      const { items } = await api.files({ limit: 500 });
      const docs = items.filter((file) => !file.mime.startsWith("image/") && !file.mime.startsWith("video/"));
      setProgress({ done: 0, total: docs.length, failed: 0 });
      let failed = 0;
      for (const [index, file] of docs.entries()) {
        try {
          await api.reindexFile(file.id);
        } catch {
          failed += 1;
        }
        setProgress({ done: index + 1, total: docs.length, failed });
      }
    });
    if (!ok) setProgress(null);
    setReindexing(false);
  };

  return (
    <>
      <Section
        title={uiText("联网搜索")}
        actions={
          <Badge
            tone={
              capabilities.web.provider === "searxng"
                ? capabilities.web.baseUrl
                  ? "success"
                  : "warning"
                : capabilities.web.hasTavilyKey
                  ? "success"
                  : "warning"
            }
          >
            {capabilities.web.provider === "searxng"
              ? capabilities.web.baseUrl
                ? uiText("已配置实例")
                : uiText("缺少实例地址")
              : capabilities.web.hasTavilyKey
                ? uiText("已配置")
                : uiText("缺少密钥")}
          </Badge>
        }
      >
        <SectionBody>
          <Switch
            label={uiText("启用 web_search 工具")}
            checked={capabilities.web.enabled}
            onChange={(value) => void patch({ web: { enabled: value } })}
          />
          <Field label={uiText("后端")}>
            <Select
              value={capabilities.web.provider}
              options={SEARCH_PROVIDERS.map((item) => ({ value: item.id, label: item.label }))}
              onChange={(value) => void patch({ web: { provider: value } })}
            />
          </Field>
          {capabilities.web.provider === "searxng" ? (
            <Field label={uiText("SearXNG 地址")} hint={uiText("自托管实例的根地址，不需要密钥。")}>
              <Input
                defaultValue={capabilities.web.baseUrl}
                placeholder="http://127.0.0.1:8080"
                onBlur={(event) => void patch({ web: { baseUrl: event.target.value } })}
              />
            </Field>
          ) : (
          <Field label="Tavily API Key">
            <div className="flex gap-2">
              <Input
                className="flex-1"
                type="password"
                placeholder={capabilities.web.hasTavilyKey ? uiText("替换密钥") : "tvly-…"}
                value={tavilyKey}
                onChange={(event) => setTavilyKey(event.target.value)}
              />
              <Button
                disabled={!tavilyKey.trim()}
                onClick={async () => {
                  const ok = await act(
                    async () => setCapabilities(await api.setSecret("tavily", tavilyKey.trim())),
                    uiText("已保存"),
                  );
                  if (ok) setTavilyKey("");
                }}
              >
                {uiText("保存")}</Button>
              <Button
                variant="ghost"
                className="text-destructive"
                disabled={!capabilities.web.hasTavilyKey}
                onClick={() => void act(async () => setCapabilities(await api.clearSecret("tavily")), uiText("已清除"))}
              >
                {uiText("清除")}</Button>
            </div>
          </Field>
          )}
          <Field label={uiText("下载 DNS（可选）")} hint={uiText("系统使用代理虚拟地址时，填写 DNS-over-HTTPS JSON 地址；留空使用系统 DNS。") }>
            <Input defaultValue={capabilities.web.downloadDnsUrl ?? ""} placeholder="https://cloudflare-dns.com/dns-query" onBlur={event => void patch({ web: { downloadDnsUrl: event.target.value } })} />
          </Field>
        </SectionBody>
      </Section>

      <Section title={uiText("文件检索")}>
        <SectionBody>
          <Switch
            label={uiText("允许上传文件")}
            checked={capabilities.files.enabled}
            onChange={(value) => void patch({ files: { enabled: value } })}
          />
          <Switch
            label={uiText("启用 file_search 工具")}
            checked={capabilities.files.searchEnabled}
            onChange={(value) => void patch({ files: { searchEnabled: value } })}
          />
          <Field label={uiText("检索方式")}>
            <Select
              value={capabilities.files.mode}
              options={[
                { value: "hybrid", label: uiText("混合"), hint: uiText("语义加关键词") },
                { value: "semantic", label: uiText("仅语义") },
                { value: "keyword", label: uiText("仅关键词") },
              ]}
              onChange={(value) => void patch({ files: { mode: value as Capabilities["files"]["mode"] } })}
            />
          </Field>
        </SectionBody>
      </Section>

      <Section
        title={uiText("嵌入模型")}
        actions={
          <Badge tone={capabilities.embedding.hasKey ? "success" : "warning"}>
            {capabilities.embedding.hasKey ? uiText("已配置") : uiText("缺少密钥")}
          </Badge>
        }
      >
        <SectionBody>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Base URL">
              <Input
                defaultValue={capabilities.embedding.baseUrl}
                onBlur={(event) => void patch({ embedding: { baseUrl: event.target.value } })}
              />
            </Field>
            <Field label={uiText("模型")}>
              <Input
                defaultValue={capabilities.embedding.model}
                onBlur={(event) => void patch({ embedding: { model: event.target.value } })}
              />
            </Field>
            <Field label={uiText("切片大小")} hint={uiText("按字符计，一般 1000–1500。")}>
              <Input
                type="number"
                defaultValue={capabilities.embedding.chunkSize}
                onBlur={(event) => void patch({ embedding: { chunkSize: Number(event.target.value) } })}
              />
            </Field>
            <Field label={uiText("切片重叠")} hint={uiText("大约切片大小的一成到两成。")}>
              <Input
                type="number"
                defaultValue={capabilities.embedding.chunkOverlap}
                onBlur={(event) => void patch({ embedding: { chunkOverlap: Number(event.target.value) } })}
              />
            </Field>
          </div>
          <Field
            label={uiText("重建索引")}
            hint={uiText("改切片只影响新文件。已经索引过的，要点下面重建。")}
          >
            <div className="flex items-center gap-3">
              <Button variant="outline" disabled={reindexing} onClick={() => void reindexAll()}>
                {reindexing ? <Spinner /> : <RefreshCw />}
                {uiText("重建全部文档")}</Button>
              {progress ? (
                reindexing ? (
                  <span className="text-xs text-muted-foreground">
                    {uiText("重建中")}{progress.done}/{progress.total}
                  </span>
                ) : (
                  <span className={cn("text-xs", progress.failed ? "text-destructive" : "text-muted-foreground")}>
                    {uiText("已重建 {0} 个，失败 {1} 个", [progress.done - progress.failed, progress.failed])}</span>
                )
              ) : null}
            </div>
          </Field>
          <Field label="API Key">
            <div className="flex gap-2">
              <Input
                className="flex-1"
                type="password"
                placeholder={capabilities.embedding.hasKey ? uiText("替换密钥") : "sk-…"}
                value={embeddingKey}
                onChange={(event) => setEmbeddingKey(event.target.value)}
              />
              <Button
                disabled={!embeddingKey.trim()}
                onClick={async () => {
                  const ok = await act(
                    async () => setCapabilities(await api.setSecret("embedding", embeddingKey.trim())),
                    uiText("已保存"),
                  );
                  if (ok) setEmbeddingKey("");
                }}
              >
                {uiText("保存")}</Button>
            </div>
          </Field>
        </SectionBody>
      </Section>

      <Section
        title={uiText("记忆")}
        actions={<span className="text-xs text-muted-foreground">{capabilities.memory.suggestedKeys.length} {uiText("个建议名称")}</span>}
      >
        <SectionBody>
          <Switch
            label={uiText("每次对话带上已保存的记忆")}
            checked={capabilities.memory.enabled}
            onChange={(value) => void patch({ memory: { enabled: value } })}
          />
          <Switch
            label={uiText("允许助手保存记忆")}
            checked={capabilities.memory.writeEnabled}
            onChange={(value) => void patch({ memory: { writeEnabled: value } })}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={uiText("记忆总长度")} hint={uiText("保存超额时会拒绝写入。调低预算不会删除已有记忆；对话只带入预算内的条目，优先保留最近更新的。")}>
              <Input
                type="number"
                defaultValue={capabilities.memory.tokenLimit}
                onBlur={(event) => void patch({ memory: { tokenLimit: Number(event.target.value) } })}
              />
            </Field>
            <Field label={uiText("单条字符上限")}>
              <Input
                type="number"
                defaultValue={capabilities.memory.charLimit}
                onBlur={(event) => void patch({ memory: { charLimit: Number(event.target.value) } })}
              />
            </Field>
          </div>
          <Field label={uiText("建议的记忆名称")} hint={uiText("用逗号分开；模型可以另起名字。")}>
            <Input
              defaultValue={capabilities.memory.suggestedKeys.join(", ")}
              onBlur={(event) =>
                void patch({
                  memory: {
                    suggestedKeys: event.target.value
                      .split(",")
                      .map((key) => key.trim())
                      .filter(Boolean),
                  },
                } as Parameters<typeof api.updateCapabilities>[0])
              }
            />
          </Field>
        </SectionBody>
      </Section>

      <Section title={uiText("创作台")}>
        <SectionBody>
          <Switch
            label={uiText("启用创作台页面")}
            checked={capabilities.studio.enabled}
            onChange={(value) => void patch({ studio: { enabled: value } })}
          />
        </SectionBody>
      </Section>

      <Section
        title={uiText("工作目录访问")}
        hint={uiText("控制助手使用本机文件和命令工具。资料库与长期记忆在各自分组中管理。")}
      >
        <SectionBody>
          <Field label={uiText("工作目录")} hint={uiText("文件工具使用此目录。选择 Uncensia 源码目录并允许修改文件时，助手也能修改程序源码。") }>
            <Input className="font-mono text-xs" defaultValue={capabilities.coding.workspace}
              onBlur={(event) => void patch({ coding: { workspace: event.target.value } })} />
          </Field>
          <Field label={uiText("查看本机文件")} hint={uiText("读取文件、搜索内容、查找文件和列目录；也可将工作成果保存到资料库。") }>
            <Switch
              label={uiText("允许查看文件")}
              checked={capabilities.coding.read}
              onChange={(value) => void patch({ coding: { read: value } })}
            />
          </Field>
          <Field label={uiText("修改本机文件")} hint={uiText("新建、编辑、移动、删除和恢复文件；也可把资料库原件复制到工作目录。覆盖和删除仍遵循审批与备份流程。") }>
            <Switch
              label={uiText("允许修改文件")}
              checked={capabilities.coding.write}
              onChange={(value) => void patch({ coding: { write: value } })}
            />
          </Field>
          <Field label={uiText("运行命令")} hint={uiText("用于运行脚本、测试和命令行程序。命令以服务进程的系统权限执行，不受上面的文件读写开关或工作目录边界隔离。") }>
            <Switch
              label={uiText("允许运行命令")}
              checked={capabilities.coding.shell}
              onChange={(value) => void patch({ coding: { shell: value } })}
            />
          </Field>
        </SectionBody>
      </Section>
      <Section title={uiText("技能与长期指令")} hint={uiText("决定助手能否修改以后对话会使用的行为资料。这不会训练或更换模型，也不会自动修改和部署程序。") }>
        <SectionBody>
          <Field label={uiText("管理技能")} hint={uiText("允许助手新增、修改和启停技能，保存修改原因与旧版本。已有技能的读取和使用不受此开关影响。") }>
            <Switch label={uiText("允许修改技能")} checked={capabilities.learning?.skills ?? false}
              onChange={value => void patch({ learning: { skills: value } })} />
          </Field>
          <Field label={uiText("管理长期指令")} hint={uiText("允许助手按明确要求修改全局指令和工具指令，保留版本记录。修改从下一轮对话生效。") }>
            <Switch label={uiText("允许修改长期指令")} checked={capabilities.learning?.prompts ?? false}
              onChange={value => void patch({ learning: { prompts: value } })} />
          </Field>
          <p className="text-xs text-muted-foreground">{uiText("这些开关控制专用管理工具。若同时允许命令执行，或允许写入存放技能和指令的目录，仍可通过本机工具修改相应文件。")}</p>
          <a href="/settings/skills" className="text-sm underline">{uiText("查看技能与修改记录")}</a>
        </SectionBody>
      </Section>
    </>
  );
}
