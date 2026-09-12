import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

/** Preserve MCP semantics at the Pi boundary; details alone are not model input. */
export function mcpResult(value: unknown, server: string, saveBinary?: (resource: {uri:string; blob:string; mimeType?:string}) => string) {
  const response = CallToolResultSchema.parse(value);
  const parts = Array.isArray(response.content) ? response.content as Array<Record<string, unknown>> : [];
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  for (const part of parts) {
    if (part.type === "text") content.push({type:"text",text:String(part.text ?? "")});
    else if (part.type === "image") content.push({type:"image",data:String(part.data ?? ""),mimeType:String(part.mimeType ?? "image/png")});
    else if (part.type === "resource_link") content.push({type:"text",text:`MCP resource link (not downloaded): ${JSON.stringify(part)}`});
    else if (part.type === "resource") {
      const resource = part.resource as { uri?: string; text?: string; blob?: string; mimeType?: string } | undefined;
      if (resource?.text !== undefined) content.push({type:"text",text:`MCP resource ${resource.uri ?? ""} (${resource.mimeType ?? "text/plain"}):\n${resource.text}`});
      else if (resource?.blob && resource.mimeType?.startsWith("image/")) content.push({type:"image",data:resource.blob,mimeType:resource.mimeType});
      else if (resource?.blob && resource.uri && saveBinary) content.push({type:"text",text:saveBinary({uri:resource.uri,blob:resource.blob,mimeType:resource.mimeType})});
      else content.push({type:"text",text:`MCP binary resource: ${JSON.stringify({uri:resource?.uri,mimeType:resource?.mimeType,bytes:typeof resource?.blob === "string" ? Buffer.byteLength(resource.blob,"base64") : 0})}. This preview does not expose the binary contents as text.`});
    } else content.push({type:"text",text:`MCP content: ${JSON.stringify({...part,...(part.data ? {data:"[binary payload]"} : {})})}`});
  }
  if (response.structuredContent !== undefined) {
    const text = JSON.stringify(response.structuredContent);
    if (!content.some(part => part.type === "text" && part.text === text)) content.push({type:"text",text:`Structured result:\n${text}`});
  }
  // Pi marks thrown tool calls as errors. Returning isError in details would be ignored.
  if (response.isError) throw new Error(content.filter(part=>part.type === "text").map(part=>part.text).join("\n") || `MCP tool failed (${server})`);
  return {content,details:{server,structuredContent:response.structuredContent,resources:parts.filter(part=>part.type === "resource" || part.type === "resource_link").map(part => {
    const resource = part.resource as Record<string, unknown> | undefined;
    return resource?.blob && saveBinary ? {...part,resource:{...resource,blob:undefined}} : part;
  })}};
}
