/**
 * Asserts conversation tool blocks render by kind: a skill read names its source, an
 * image/video call shows the prompt rather than a JSON dump, and a live job
 * is the same card the studio uses.
 *
 *   node --import tsx scripts/audit-tool-view.tsx
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { JobRecord } from "../src/shared/types.ts";
import type { ToolPart } from "../src/web/messages.ts";
import { JobCard } from "../src/web/ui/job-card.tsx";
import { ToolView, toolSummary } from "../src/web/ui/tool-view.tsx";

let failures = 0;

function check(name: string, run: () => string | void) {
  try {
    const note = run();
    console.log(`PASS ${name}${note ? ` — ${note}` : ""}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

function tool(partial: Partial<ToolPart> & Pick<ToolPart, "name" | "args">): ToolPart {
  return {
    kind: "tool",
    callId: "call-1",
    result: "",
    isError: false,
    running: false,
    ...partial,
  };
}

function renderTool(part: ToolPart) {
  return renderToStaticMarkup(createElement(ToolView, { part }));
}

check("native skill read shows its source and loaded procedure", () => {
  const part = tool({ name: "read", args: { path: "C:/skills/image-generate/SKILL.md" }, result: "Write one paragraph." });
  assert(toolSummary(part.name, part.args as Record<string, unknown>) === "image-generate/SKILL.md", "source missing from summary");
  const html = renderTool(part);
  assert(html.includes("读取资料") && html.includes("Write one paragraph."), "native read result missing");
});

check("generate_image shows the prompt, not the whole argument object", () => {
  const html = renderTool(
    tool({
      name: "generate_image",
      args: { prompt: "a red bicycle in rain", size: "1024x1024", seed: 7 },
    }),
  );
  assert(html.includes("a red bicycle in rain"), "the prompt never reached the block");
  assert(!html.includes('"size"'), `size leaked as JSON:\n${html}`);
  assert(!html.includes('"seed"'), `seed leaked as JSON:\n${html}`);
});

check("edit_image keeps the source id next to the prompt", () => {
  const html = renderTool(
    tool({
      name: "edit_image",
      args: { prompt: "remove the umbrella", source_image_id: "img_0123456789abcdef0123456789abcdef" },
    }),
  );
  assert(html.includes("remove the umbrella"), "edit prompt missing");
  assert(html.includes("img_0123456789abcdef0123456789abcdef"), "source id missing");
});

check("a named generate_image_* tool still uses the prompt layout", () => {
  const html = renderTool(tool({ name: "generate_image_lustify", args: { prompt: "portrait at dusk" } }));
  assert(html.includes("portrait at dusk"), "suffixed image tools fell through to JSON");
});

check("inspection references stay available inside the tool card", () => {
  const html = renderTool(tool({ name: "view_image", args: { image_id: "img_0123456789abcdef0123456789abcdef" } }));
  assert(html.includes("打开已检查的参考图") && html.includes("?w=160"), "inspection thumbnail or open action missing");
});

check("generation failure exposes its concrete error", () => {
  const html = renderTool(tool({ name: "edit_image", args: { prompt: "change coat" }, result: "modelId: Required", isError: true }));
  assert(html.includes('role="alert"') && html.includes("modelId: Required"), "failed card hid the provider error");
  const missing = renderTool(tool({ name: "view_image", args: { image_id: "img_0123456789abcdef0123456789abcdef" }, result: "No readable image", isError: true }));
  assert(!missing.includes("?w=160") && missing.includes("No readable image"), "failed inspection showed a fake preview");
});

check("a running generation job renders as the studio card, not a spinner-only row", () => {
  const job: JobRecord = {
    id: "job_1",
    kind: "image",
    op: "text_to_image",
    modelId: "comfy:lustify-v10",
    modelName: "Lustify v10",
    conversationId: "c1",
    status: "running",
    progress: 0.4,
    note: "sampling",
    params: { prompt: "a red bicycle in rain" },
    sources: [],
    assets: [],
    error: null,
    createdAt: 1,
    startedAt: 1,
    finishedAt: null,
    updatedAt: 1,
  };
  const html = renderToStaticMarkup(createElement(JobCard, { job, onZoom: () => undefined }));
  assert(html.includes("生成中"), `status missing:\n${html}`);
  assert(html.includes("Lustify v10"), "model name missing");
  assert(html.includes("a red bicycle in rain"), "job prompt missing");
});

console.log(failures ? `\n${failures} tool-view check(s) failed` : "\nall tool-view checks passed");
if (failures) process.exit(1);
