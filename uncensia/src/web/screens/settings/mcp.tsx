import { uiText } from "../../i18n.tsx";
import { Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { McpServer, McpStatus } from "@shared/types.ts";
import { api } from "../../api.ts";
import {
  Badge,
  Button,
  Field,
  Input,
  Modal,
  type Option,
  Row,
  Section,
  SectionBody,
  Select,
  Switch,
  Textarea,
  useAction,
  useToast,
} from "../../ui.tsx";

type Transport = "stdio" | "remote";

const TRANSPORT_OPTIONS: Array<Option<Transport>> = [
  { value: "stdio", label: uiText("本地子进程"), hint: uiText("按命令与参数启动，通过 stdio 通信") },
  { value: "remote", label: uiText("远程 HTTP"), hint: uiText("连接已发布的服务器，Streamable HTTP") },
];

const isHttpUrl = (value: string) => /^https?:\/\//i.test(value.trim());

const kvText = (record: Record<string, string>) =>
  Object.entries(record)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

const parseKv = (text: string): Record<string, string> =>
  Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );

export function McpSection({ reload }: { reload: () => Promise<void> }) {
  const act = useAction();
  const toast = useToast();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [status, setStatus] = useState<McpStatus[]>([]);
  const [editing, setEditing] = useState<McpServer | null>(null);

  const refresh = useCallback(async () => {
    const data = await api.mcpServers();
    setServers(data.items);
    setStatus(data.status);
    await reload();
  }, [reload]);

  useEffect(() => {
    void refresh().catch((error: unknown) => toast(String(error), true));
  }, [refresh, toast]);

  return (
    <>
      <Section
        title={uiText("MCP 服务器")}
        hint={uiText("给对话加第三方工具。本地进程或远程 HTTP 都行。")}
        actions={
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void act(() => api.reconnectMcp(), uiText("已重连")).then(refresh)}>
              <RefreshCw />
              {uiText("重连")}</Button>
            <Button
              size="sm"
              onClick={() =>
                setEditing({
                  id: "",
                  title: "",
                  enabled: true,
                  command: "",
                  args: [],
                  env: {},
                  sortOrder: servers.length,
                })
              }
            >
              {uiText("添加")}</Button>
          </div>
        }
      >
        {servers.length === 0 ? (
          <SectionBody>
            <p className="text-sm text-muted-foreground">
              {uiText("还没有 MCP 服务器。")}</p>
          </SectionBody>
        ) : null}
        {servers.map((server) => {
          const state = status.find((item) => item.id === server.id);
          return (
            <Row key={server.id}>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <strong className="text-sm">{server.title}</strong>
                  {server.url ? <Badge tone="outline">{uiText("远程")}</Badge> : null}
                  {server.enabled ? (
                    <Badge tone={state?.connected ? "success" : "danger"}>
                      {state?.connected ? uiText("{0} 个工具", [state.tools.length]) : uiText("未连接")}
                    </Badge>
                  ) : (
                    <Badge tone="outline">{uiText("已停用")}</Badge>
                  )}
                </div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {server.url ?? `${server.command} ${server.args.join(" ")}`}
                </div>
                {state?.error ? <div className="truncate text-xs text-destructive">{state.error}</div> : null}
              </div>
              <Switch
                checked={server.enabled}
                onChange={(value) => void act(() => api.updateMcpServer(server.id, { enabled: value })).then(refresh)}
              />
              <Button variant="ghost" size="icon-sm" aria-label={uiText("编辑")} onClick={() => setEditing(server)}>
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={uiText("删除")}
                className="text-muted-foreground hover:text-destructive"
                onClick={() => void act(() => api.deleteMcpServer(server.id)).then(refresh)}
              >
                <Trash2 />
              </Button>
            </Row>
          );
        })}
      </Section>

      {editing ? (
        <McpEditor
          server={editing}
          onCancel={() => setEditing(null)}
          onSave={async (next, isNew) => {
            const ok = await act(
              () => (isNew ? api.createMcpServer(next) : api.updateMcpServer(next.id, next)),
              uiText("已保存"),
            );
            if (ok) {
              setEditing(null);
              await refresh();
            }
          }}
        />
      ) : null}
    </>
  );
}

function McpEditor({
  server,
  onCancel,
  onSave,
}: {
  server: McpServer;
  onCancel: () => void;
  onSave: (server: McpServer, isNew: boolean) => Promise<void>;
}) {
  const [draft, setDraft] = useState(server);
  const [transport, setTransport] = useState<Transport>(server.url ? "remote" : "stdio");
  const [url, setUrl] = useState(server.url ?? "");
  const [argsText, setArgsText] = useState(server.args.join("\n"));
  const [envText, setEnvText] = useState(kvText(server.env));
  const [headersText, setHeadersText] = useState(kvText(server.headers ?? {}));
  const isNew = !server.id;
  const remote = transport === "remote";

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onCancel()}
      title={isNew ? uiText("新建 MCP 服务器") : uiText("编辑 {0}", [server.title])}
      className="w-[min(40rem,calc(100vw-2rem))]"
      footer={
        <>
          <Button onClick={onCancel}>{uiText("取消")}</Button>
          <Button
            variant="primary"
            disabled={!draft.title.trim() || (remote ? !isHttpUrl(url) : !draft.command.trim())}
            onClick={() =>
              void onSave(
                {
                  ...draft,
                  // `command` is NOT NULL in the schema, so a remote server stores
                  // an empty one; the URL is what selects the HTTP transport.
                  command: remote ? "" : draft.command.trim(),
                  url: remote ? url.trim() : "",
                  args: remote
                    ? []
                    : argsText
                        .split("\n")
                        .map((line) => line.trim())
                        .filter(Boolean),
                  env: remote ? {} : parseKv(envText),
                  headers: remote ? parseKv(headersText) : {},
                },
                isNew,
              )
            }
          >
            {uiText("保存")}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={uiText("名称")}>
            <Input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          </Field>
          <Field label={uiText("标识")}>
            <Input
              value={draft.id}
              disabled={!isNew}
              placeholder="local-image-generation"
              onChange={(event) => setDraft({ ...draft, id: event.target.value })}
            />
          </Field>
        </div>
        <Field label={uiText("接入方式")}>
          <Select value={transport} options={TRANSPORT_OPTIONS} onChange={setTransport} />
        </Field>
        {remote ? (
          <>
            <Field label="URL" hint={uiText("服务提供的 Streamable HTTP 端点。")}>
              <Input
                className="font-mono text-xs"
                placeholder="https://mcp.example.com/mcp"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </Field>
            <Field
              label={uiText("请求头（KEY=VALUE，每行一个）")}
              hint={uiText("可以用 {0} 引用已存的密钥。", ["${OPENROUTER_API_KEY}"])}
            >
              <Textarea
                className="font-mono text-xs"
                rows={4}
                placeholder="Authorization=Bearer ${OPENROUTER_API_KEY}"
                value={headersText}
                onChange={(event) => setHeadersText(event.target.value)}
              />
            </Field>
          </>
        ) : (
          <>
            <Field label={uiText("命令")}>
              <Input
                className="font-mono text-xs"
                value={draft.command}
                placeholder="python"
                onChange={(event) => setDraft({ ...draft, command: event.target.value })}
              />
            </Field>
            <Field label={uiText("参数（每行一个）")}>
              <Textarea
                className="font-mono text-xs"
                rows={4}
                value={argsText}
                onChange={(event) => setArgsText(event.target.value)}
              />
            </Field>
            <Field
              label={uiText("环境变量（KEY=VALUE，每行一个）")}
              hint={uiText("可引用已存密钥，以及 {0}、{1}、{2}。", ["${AIGC_ROOT}", "${PROJECT_ROOT}", "${NODE_EXE}"])}
            >
              <Textarea
                className="font-mono text-xs"
                rows={4}
                value={envText}
                onChange={(event) => setEnvText(event.target.value)}
              />
            </Field>
          </>
        )}
        <Switch label={uiText("启用")} checked={draft.enabled} onChange={(value) => setDraft({ ...draft, enabled: value })} />
      </div>
    </Modal>
  );
}
