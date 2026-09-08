import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { connectServer } from "../src/server/mcp/transport.ts";
import type { McpServer as ServerConfig } from "../src/shared/types.ts";

function fixture() {
  const server = new McpServer({ name: "transport-fixture", version: "1.0.0" });
  server.registerTool("probe", { description: "Read the fixture marker", inputSchema: {} }, async () => ({
    content: [{ type: "text", text: process.env.UNCENSIA_TRANSPORT_PROBE ?? "http-probe" }],
  }));
  return server;
}

if (process.argv.includes("--stdio-fixture")) {
  await fixture().connect(new StdioServerTransport());
} else {
  const mcp = fixture();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await mcp.connect(transport);
  const oldMethods: string[] = [];
  const host = http.createServer((request, response) => {
    if (request.url === "/old") {
      oldMethods.push(request.method ?? ""); response.writeHead(404).end(); return;
    }
    if (request.headers["x-fixture"] !== "expanded-header") { response.writeHead(401).end(); return; }
    void transport.handleRequest(request, response);
  });
  await new Promise<void>(resolve => host.listen(0, "127.0.0.1", resolve));
  const port = (host.address() as { port: number }).port;
  const config: ServerConfig = { id: "transport", title: "Transport fixture", enabled: true, command: "", args: [], env: {}, sortOrder: 0 };
  const expand = (value: string) => value.replaceAll("${MARKER}", "expanded-header");
  try {
    const remote = await connectServer({ ...config, url: `http://127.0.0.1:${port}/mcp`, headers: { "x-fixture": "${MARKER}" } }, expand);
    try {
      assert.equal((await remote.listTools()).tools[0]?.name, "probe");
      assert.equal(((await remote.callTool({ name: "probe", arguments: {} })).content as Array<{text:string}>)[0]?.text, "http-probe");
    } finally { await remote.close(); }
    await assert.rejects(connectServer({ ...config, url: `http://127.0.0.1:${port}/old` }, expand));
    assert.deepEqual(oldMethods, ["POST"], "a rejected HTTP connection must not try the retired SSE transport");
    await assert.rejects(connectServer({ ...config, url: "file:///unexpected" }, expand), /HTTP or HTTPS/);
    const local = await connectServer({ ...config, command: process.execPath,
      args: ["--import", "tsx", fileURLToPath(import.meta.url), "--stdio-fixture"], env: { UNCENSIA_TRANSPORT_PROBE: "${MARKER}" } }, expand);
    try {
      assert.equal(((await local.callTool({ name: "probe", arguments: {} })).content as Array<{text:string}>)[0]?.text, "expanded-header");
    } finally { await local.close(); }
    console.log("PASS MCP Streamable HTTP and stdio: real discovery/call, expanded headers/env, failed connection stays on the selected transport");
  } finally {
    await mcp.close();
    host.closeAllConnections();
    await new Promise<void>((resolve, reject) => host.close(error => error ? reject(error) : resolve()));
  }
}
