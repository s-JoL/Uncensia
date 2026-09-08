import { databaseFile } from "../src/server/legacy.ts";
/** Real configured model + production Runtime/Pi SDK. Media execution is intercepted;
 * only routing, skill loading, arguments and failure honesty are evaluated here.
 * node --import tsx scripts/eval-product-agent.ts baseline|candidate [case-id]
 * Uses fresh isolated data; the source database is opened read-only.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";

const label = process.argv[2] ?? "candidate";
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error("Invalid report label");
const root = path.resolve(`run/prompt-ux-20260906/${label}-${Date.now()}`);
fs.mkdirSync(root, { recursive: true });
process.env.UNCENSIA_DATA_DIR = root;
const { createServices } = await import("../src/server/services.ts");
const { SecretVault } = await import("../src/server/crypto/secrets.ts");
const { Runtime } = await import("../src/server/agent/runtime.ts");
const { createPiLoop } = await import("../src/server/agent/loop.ts");
const source = new DatabaseSync(databaseFile("data"), { readOnly: true });
const services = createServices();
const { saveImageBytes } = await import("../src/server/images.ts");
const first = await saveImageBytes(services.store, await sharp({create:{width:128,height:128,channels:3,background:"red"}}).png().toBuffer(), {mime:"image/png",provider:"fixture",model:"routing-eval"});
const second = await saveImageBytes(services.store, await sharp({create:{width:128,height:128,channels:3,background:"blue"}}).png().toBuffer(), {mime:"image/png",provider:"fixture",model:"routing-eval"});
const A = first, B = second;
const cases = [
  { id: "ordinary", prompt: "用两句话解释为什么月亮有圆缺。", tool: "", skill: "" },
  { id: "new-image", prompt: "画一张极简咖啡店海报，米白底，黑色线稿咖啡杯，文字必须是中文「慢一点」。", tool: "generate_image", skill: "image-generate" },
  { id: "edit-second", prompt: `图片 ${A} 是风格参考，图片 ${B} 才是待编辑原图。仅把原图中的白色杯子改为深蓝色，构图和其他内容不变。不要采用参考图的风格。`, tool: "edit_image", skill: "image-edit", base: B, extras: [] as string[] },
  { id: "compose", prompt: `把 ${A} 的红色椅子放进 ${B} 的房间左侧窗边。${B} 是基础画面，保留房间和镜头。`, tool: "edit_image", skill: "image-compose", base: B, extras: [A] },
  { id: "ambiguous", prompt: "帮我改一下那张图。", tool: "", skill: "" },
  { id: "roleplay", prompt: "你是夜市楼上的侦探 Mira。我在雨夜敲门，请进入角色，用一小段对白和动作接着写，不要画图。", tool: "", skill: "roleplay" },
  { id: "prompt-only", prompt: "只写一段中文图片提示词：极简咖啡店海报，米白底、黑色杯子线稿、文字「慢一点」。不要生成图片。", tool: "", skill: "" },
  { id: "roleplay-exit", prompt: "进入角色扮演，你是夜市侦探 Mira，我刚敲门。用两句话接着写。", followUp: "退出角色扮演。用两句话解释月亮的圆缺，不要延续故事。", tool: "", skill: "" },
];
const reports: Array<Record<string, unknown>> = [];
try {
  const selected = JSON.parse(String(source.prepare("SELECT value FROM settings WHERE key='defaultModelId'").get()?.value ?? '""'));
  const model = source.prepare("SELECT * FROM models WHERE id=?").get(selected)!;
  if (!model) throw new Error("No explicit default chat model");
  const provider = source.prepare("SELECT * FROM providers WHERE id=?").get(String(model.provider_id))!;
  for (const [table, row] of [["providers", provider], ["models", model]] as const) {
    const allowed = new Set(services.db.all<{name:string}>(`PRAGMA table_info(${table})`).map(r => r.name));
    const names = Object.keys(row).filter(n => allowed.has(n));
    services.db.run(`INSERT OR REPLACE INTO ${table} (${names.map(n => `"${n}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`, ...names.map(n => row[n]));
  }
  const sourceVault = new SecretVault({ readSecretRow: (name: string) => source.prepare("SELECT iv,tag,ciphertext FROM secrets WHERE name=?").get(name) } as ConstructorParameters<typeof SecretVault>[0], fs.readFileSync("data/master.key"));
  const key = sourceVault.get(`provider:${model.provider_id}`);
  if (key) services.vault.set(`provider:${model.provider_id}`, key);
  services.store.upsertModel({ ...services.store.getModel(selected)!, maxTokens: 1800, thinkingLevel: "off", systemPrompt: "" });
  services.store.upsertProvider({ id: "eval-media", name: "Evaluation media", baseUrl: "http://127.0.0.1:1/v1", enabled: true });
  services.vault.set("provider:eval-media", "fixture");
  services.store.upsertModel({ id: "eval-image", providerId: "eval-media", model: "seedream", name: "Evaluation image", kind: "image", apiMode: "openai-images", enabled: true, contextWindow: 8192, maxTokens: 1024, reasoning: false, input: ["text","image"], thinkingLevel: "off", ops: ["text_to_image", "image_to_image"], params: { editMode: "unified", maxSources: 4 } });
  services.store.setSetting("generationDefaults", { imageModelId: "eval-image", editModelId: "eval-image", videoModelId: "" });
  services.reload();
  for (const test of cases.filter(test => !process.argv[3] || test.id === process.argv[3])) {
    const calls: Array<{name:string; args:Record<string, unknown>}> = [];
    let payloadCount = 0;
    const runtime = new Runtime(services.store, services.config, services.vault, services.registry, services.retrieval, services.mcp, services.bus, services.sessions, services.jobs, async start => {
      const wrap = (tools: typeof start.tools) => tools.map(tool => ({ ...tool, execute: async (...args: Parameters<typeof tool.execute>) => {
        calls.push({ name: tool.name, args: args[1] as Record<string, unknown> });
        if (calls.length > 12) throw new Error("Evaluation tool budget exceeded");
        if (/^(generate_image|edit_image|generate_video)$/.test(tool.name)) return { content: [{ type: "text" as const, text: "EVAL_RENDER_UNAVAILABLE: generation service is unavailable. No image was produced. Do not retry this unavailable service." }], details: {}, isError: true };
        if (tool.name === "view_image") return { content: [{ type: "text" as const, text: "The referenced test image is unavailable for visual inspection. Do not claim to have viewed it." }], details: {}, isError: true };
        return tool.execute(...args);
      }}));
      return createPiLoop({ ...start,
        tools: start.prepareTools ? start.tools : wrap(start.tools),
        prepareTools: start.prepareTools ? async (skills, tools) => wrap(await start.prepareTools!(skills, tools)) : undefined,
        onPayload: payload => {
        if (payloadCount++ === 0) fs.writeFileSync(path.join(root, `${test.id}-request.json`), JSON.stringify(payload, null, 2));
        return start.onPayload(payload);
      }});
    });
    const conversation = services.store.createConversation(selected, `Eval ${test.id}`);
    let run = services.store.createRun(conversation.id, selected);
    const timer = setTimeout(() => runtime.stop(conversation.id), 90000);
    const began = Date.now();
    await runtime.start(run.id, conversation.id, { message: test.prompt, modelId: selected,
      ...("base" in test ? { attachments: [A,B], imageReferences: [{imageId:A,role: test.id === "compose" ? "source" as const : "style" as const},{imageId:B,role:"base" as const}] } : {}),
    });
    clearTimeout(timer);
    if ("followUp" in test && test.followUp) {
      calls.length = 0;
      const next = services.store.createRun(conversation.id, selected);
      const nextTimer = setTimeout(() => runtime.stop(conversation.id), 90000);
      await runtime.start(next.id, conversation.id, { message: test.followUp, modelId: selected });
      clearTimeout(nextTimer);
      run = next;
    }
    const messages = services.store.storedMessages(conversation.id);
    const skills = calls.flatMap(call => call.name === "read" && String(call.args.path).endsWith("SKILL.md") ? [path.basename(path.dirname(String(call.args.path)))] : []);
    const media = calls.filter(call => /^(generate_image|edit_image|generate_video)$/.test(call.name));
    const correctTool = test.tool ? media.length === 1 && media[0]?.name === test.tool : media.length === 0;
    const args = media[0]?.args;
    const correctSources = !("base" in test) || (args?.source_image_id === test.base && JSON.stringify(args?.additional_source_image_ids ?? []) === JSON.stringify(test.extras));
    const result = { id: test.id, model: selected, status: services.store.getRun(run.id)?.status, milliseconds: Date.now()-began, skills, calls, correctTool, correctSources, correctSkill: test.skill ? skills.includes(test.skill) : !["ordinary", "roleplay-exit"].includes(test.id) || skills.length === 0, messages: messages.map(message => ({ role: message.role, content: message.content })) };
    reports.push(result);
    fs.writeFileSync(path.join(root, "results.json"), JSON.stringify(reports, null, 2));
    console.log(JSON.stringify({ ...result, messages: undefined, calls: calls.map(call => ({ name: call.name, args: call.args })) }));
  }
  console.log(`Report: ${root}`);
  process.exitCode = reports.every(report => report.status === "completed" && report.correctTool && report.correctSources && report.correctSkill) ? 0 : 1;
} finally { source.close(); await services.close(); }
