import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { connectServer } from "../src/server/mcp/transport.ts";
import type { McpServer as ServerConfig } from "../src/shared/types.ts";
import { mcpResult } from "../src/server/mcp/result.ts";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpPool } from "../src/server/mcp/pool.ts";

function fixture() {
  const server = new McpServer({ name: "transport-fixture", version: "1.0.0" });
  server.registerTool("probe", { description: "Read the fixture marker", inputSchema: {} }, async () => ({
    content: [{ type: "text", text: process.env.UNCENSIA_TRANSPORT_PROBE ?? "http-probe" }],
  }));
  server.registerTool("intentional_error", {inputSchema:{}}, async () => ({isError:true,content:[{type:"text",text:"fixture operation failed"}]}));
  server.registerTool("linked", {inputSchema:{}}, async () => ({content:[{type:"resource_link",uri:"fixture://original",name:"original"}],structuredContent:{found:1}}));
  server.registerResource("original","fixture://original",{mimeType:"text/plain"},async uri => ({contents:[{uri:uri.href,text:"MCP original text"}]}));
  server.server.setRequestHandler(ListToolsRequestSchema, async request => request.params?.cursor
    ? {tools:[{name:"intentional_error",inputSchema:{type:"object"}},{name:"linked",inputSchema:{type:"object"}}]}
    : {tools:[{name:"probe",inputSchema:{type:"object"}}],nextCursor:"second"});
  return server;
}

if (process.argv.includes("--stdio-fixture")) {
  await fixture().connect(new StdioServerTransport());
} else {
  assert.throws(() => mcpResult({isError:true,content:[{type:"text",text:"operation failed"}]},"fixture"), /operation failed/);
  const resourceResult = mcpResult({content:[{type:"resource_link",uri:"https://example.com/original.txt",name:"original"},{type:"resource",resource:{uri:"fixture://note",text:"original note"}}],structuredContent:{found:2}},"fixture");
  const resourceText = JSON.stringify(resourceResult.content);
  assert.match(resourceText,/https:\/\/example.com\/original.txt/);
  assert.match(resourceText,/original note/);
  assert.match(resourceText,/found/);
  let binaryBytes: Buffer | undefined;
  const binaryResult = mcpResult({content:[{type:"resource",resource:{uri:"fixture://document.pdf",mimeType:"application/pdf",blob:Buffer.from("original binary bytes").toString("base64")}}]},"fixture",resource => {
    binaryBytes = Buffer.from(resource.blob,"base64");
    return "Saved file_id=file_fixture";
  });
  assert.equal(binaryBytes?.toString(),"original binary bytes");
  assert.match(JSON.stringify(binaryResult.content),/file_fixture/);
  assert.ok(!JSON.stringify(binaryResult.details).includes("b3JpZ2luYWw"),"saved binaries do not duplicate base64 in history");
  const structured = mcpResult({structuredContent:{count:3}},"fixture");
  assert.match(JSON.stringify(structured.content),/count/);
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
    const pool = new McpPool({listProviders:()=>[],listMcpServers:()=>[{...config,command:process.execPath,args:["--import","tsx",fileURLToPath(import.meta.url),"--stdio-fixture"]}]} as never, {} as never);
    try {
      const tools = await pool.connect();
      assert.equal(tools.length,4,"all pages and the resource reader are offered");
      const call = (name:string,args={}) => tools.find(tool=>tool.name.startsWith(name))!.execute("audit",args);
      await assert.rejects(()=>call("intentional_error"),/fixture operation failed/);
      assert.match(JSON.stringify(await call("linked")),/fixture:\/\/original/);
      assert.match(JSON.stringify(await call("uncensia_resources",{uri:"fixture://original"})),/MCP original text/);
      assert.match(JSON.stringify(await call("uncensia_resources")),/fixture:\/\/original/);
    } finally { await pool.close(); }
    console.log("PASS MCP Streamable HTTP and stdio: real discovery/call, expanded headers/env, failed connection stays on the selected transport");
  } finally {
    await mcp.close();
    host.closeAllConnections();
    await new Promise<void>((resolve, reject) => host.close(error => error ? reject(error) : resolve()));
  }
}
