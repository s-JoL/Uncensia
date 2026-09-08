/**
 * MCP only. Generation backends live on the models page with the chat rows —
 * they are the same kind of catalogue entry, and splitting them across two
 * tabs was the thing people had to guess.
 */
import { McpSection } from "./mcp.tsx";

export function ToolsSection({ reload }: { reload: () => Promise<void> }) {
  return <McpSection reload={reload} />;
}
