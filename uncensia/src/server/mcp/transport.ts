/**
 * Which transport a stored server gets, decided by the shape of its record: a
 * command is a child process over stdio, a URL is a remote server over HTTP.
 *
 * The MCP spec has two mainstream transports and hosted servers are published
 * on the second one, so a stdio-only client can talk to whatever it can spawn
 * and to nothing else. Remote servers use Streamable HTTP explicitly.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@shared/types.ts";

const CLIENT = { name: "uncensia", version: "1.0.0" };

/** Connects one stored server, or throws with what the transport reported. */
export async function connectServer(server: McpServer, expand: (value: string) => string): Promise<Client> {
  const expandValues = (values: Record<string, string>) => Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, expand(value)]),
  );
  const url = server.url ? new URL(expand(server.url)) : undefined;
  if (url && url.protocol !== "http:" && url.protocol !== "https:") throw new Error("MCP URL must use HTTP or HTTPS");
  const transport = url
    ? new StreamableHTTPClientTransport(url, { requestInit: { headers: expandValues(server.headers ?? {}) } })
    : new StdioClientTransport({
        command: expand(server.command), args: server.args.map(expand),
        env: { ...(process.env as Record<string, string>), ...expandValues(server.env) }, stderr: "pipe",
      });
  const client = new Client(CLIENT);
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}
