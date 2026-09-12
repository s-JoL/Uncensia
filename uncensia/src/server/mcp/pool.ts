import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { McpStatus } from "@shared/types.ts";
import { SECRET } from "../config.ts";
import type { SecretVault } from "../crypto/secrets.ts";
import { paths } from "../env.ts";
import type { Store } from "../store/store.ts";
import { portableSchema } from "./schema.ts";
import { connectServer } from "./transport.ts";
import { mcpResult } from "./result.ts";
import { ingestFile } from "../library.ts";
import { linkConversationFile } from "../projects.ts";

const CALL_TIMEOUT_MS = 600_000;

function expand(value: string, vars: Record<string, string>) {
  return value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => vars[key] ?? process.env[key] ?? "");
}

/**
 * Owns the connected MCP servers — child processes and remote endpoints alike
 * (`transport.ts`). Reconnecting is a full teardown so a settings change can
 * never leave a half-configured server attached.
 *
 * MCP is for the agent. Generation goes through adapters and the job queue;
 * connecting a server "for the studio only" was a second image path and is gone.
 */
export class McpPool {
  private clients: Array<{ id: string; client: Client }> = [];
  private statuses: McpStatus[] = [];
  private tools: AgentTool[] = [];

  constructor(
    private readonly store: Store,
    private readonly vault: SecretVault,
  ) {}

  status(): McpStatus[] {
    return this.statuses;
  }

  currentTools(conversationId?: string) {
    if (!conversationId) return this.tools;
    return this.tools.map((tool) => ({
      ...tool,
      execute: async (...args: Parameters<typeof tool.execute>) => {
        const result = await tool.execute(...args);
        const savedFileIds = (result.details as { savedFileIds?: unknown } | undefined)?.savedFileIds;
        if (Array.isArray(savedFileIds)) {
          for (const fileId of savedFileIds) {
            if (typeof fileId === "string") linkConversationFile(this.store, conversationId, fileId);
          }
        }
        return result;
      },
    }));
  }

  private variables(): Record<string, string> {
    const vars: Record<string, string> = {
      AIGC_ROOT: path.resolve(paths.root, "..").replaceAll("\\", "/"),
      PROJECT_ROOT: paths.root.replaceAll("\\", "/"),
      NODE_EXE: process.execPath,
    };
    for (const provider of this.store.listProviders()) {
      const key = this.vault.get(SECRET.provider(provider.id));
      if (key) vars[`${provider.id.toUpperCase().replaceAll("-", "_")}_API_KEY`] = key;
    }
    return vars;
  }

  async connect(): Promise<AgentTool[]> {
    await this.close();
    const vars = this.variables();
    const output: AgentTool[] = [];
    this.statuses = [];

    for (const server of this.store.listMcpServers()) {
      if (!server.enabled) {
        this.statuses.push({ id: server.id, title: server.title, enabled: false, connected: false, tools: [] });
        continue;
      }
      let client: Client | undefined;
      const outputStart = output.length;
      try {
        const connected = await connectServer(server, (value) => expand(value, vars));
        client = connected;
        this.clients.push({ id: server.id, client: connected });
        const listed = connected.getServerCapabilities()?.tools ? await connected.listTools() : {tools:[], nextCursor:undefined};
        const cursors = new Set<string>();
        while (listed.nextCursor) {
          if (cursors.has(listed.nextCursor)) throw new Error("MCP returned a repeated tools cursor");
          cursors.add(listed.nextCursor);
          const page = await connected.listTools({cursor:listed.nextCursor});
          listed.tools.push(...page.tools);
          listed.nextCursor = page.nextCursor;
        }
        if (new Set(listed.tools.map(tool => tool.name)).size !== listed.tools.length) throw new Error("MCP returned duplicate tool names");
        this.statuses.push({
          id: server.id,
          title: server.title,
          enabled: true,
          connected: true,
          tools: listed.tools.map((tool) => tool.name),
        });
        for (const tool of listed.tools) {
          const toolName = `${tool.name}_mcp_${server.id.replaceAll(":", "__")}`;
          output.push({
            name: toolName,
            label: toolName,
            description: tool.description ?? "",
            parameters: Type.Unsafe(portableSchema(tool.inputSchema) as never),
            executionMode: "sequential",
            execute: async (_callId, args, signal) => {
              const response = await connected.callTool(
                { name: tool.name, arguments: args as Record<string, unknown> },
                undefined,
                { signal, timeout: CALL_TIMEOUT_MS },
              );
              return this.result(response, server.id);
            },
          });
        }
        if (connected.getServerCapabilities()?.resources) {
          const name = `uncensia_resources_mcp_${server.id.replaceAll(":", "__")}`;
          if (output.some(tool => tool.name === name)) throw new Error("MCP resource reader name conflicts with a server tool");
          output.push({
            name, label:name,
            description:"List this MCP server's resources/templates, or read an exact URI returned by its tools or catalog. Omit uri to list; set templates to discover parameterized resources. Follow nextCursor for more. Binary documents are saved as library files; images are returned as pixels.",
            parameters:Type.Object({uri:Type.Optional(Type.String()),cursor:Type.Optional(Type.String()),templates:Type.Optional(Type.Boolean())}),
            executionMode:"sequential",
            execute:async (_id,args,signal) => {
              const {uri,cursor,templates} = args as {uri?:string;cursor?:string;templates?:boolean};
              if (uri && (cursor || templates)) throw new Error("Use either a resource URI or a catalog request");
              if (uri) {
                const read = await connected.readResource({uri},{signal,timeout:CALL_TIMEOUT_MS});
                return this.result({content:read.contents.map(resource => ({type:"resource",resource}))},server.id);
              }
              const catalog = templates
                ? await connected.listResourceTemplates({cursor},{signal,timeout:CALL_TIMEOUT_MS})
                : await connected.listResources({cursor},{signal,timeout:CALL_TIMEOUT_MS});
              return this.result({content:[{type:"text",text:JSON.stringify(catalog)}]},server.id);
            },
          });
          this.statuses.at(-1)!.tools.push(name);
        }
      } catch (error) {
        output.splice(outputStart);
        this.statuses = this.statuses.filter(status => status.id !== server.id);
        this.clients = this.clients.filter(connection => connection.id !== server.id);
        const message = error instanceof Error ? error.message : String(error);
        this.statuses.push({
          id: server.id,
          title: server.title,
          enabled: true,
          connected: false,
          tools: [],
          error: message,
        });
        console.error(`[mcp] ${server.id} unavailable: ${message}`);
        await client?.close().catch(() => undefined);
      }
    }
    this.tools = output;
    return output;
  }

  private result(response: unknown, server: string) {
    const savedFileIds: string[] = [];
    const result = mcpResult(response,server,resource => {
      const name = path.basename(new URL(resource.uri).pathname) || "resource.bin";
      const {file} = ingestFile(this.store,{name,bytes:Buffer.from(resource.blob,"base64"),mime:resource.mimeType,source:"mcp"});
      savedFileIds.push(file.id);
      return `MCP resource ${resource.uri}: [${file.name}](file://${file.id}); file_id=${file.id}; ${file.bytes} bytes. Use read_resource for supported documents.`;
    });
    return { ...result, details: { ...result.details, savedFileIds } };
  }

  async close() {
    await Promise.allSettled(this.clients.map(({ client }) => client.close()));
    this.clients = [];
    this.tools = [];
  }
}
