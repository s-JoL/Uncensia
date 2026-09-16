/**
 * MCP and Pi extensions — the two ways to give the assistant tools it was not
 * born with. Generation backends live on the models page with the chat rows —
 * they are the same kind of catalogue entry, and splitting them across two
 * tabs was the thing people had to guess.
 */
import { ExtensionsSection } from "./extensions.tsx";
import { McpSection } from "./mcp.tsx";

export function ToolsSection({ reload }: { reload: () => Promise<void> }) {
  return (
    <>
      <McpSection reload={reload} />
      <ExtensionsSection />
    </>
  );
}
