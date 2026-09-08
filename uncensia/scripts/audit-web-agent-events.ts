import assert from "node:assert/strict";
import { LiveTurn, buildTurns } from "../src/web/messages.ts";
import type { StoredMessage } from "../src/shared/types.ts";

const turn = new LiveTurn();
turn.apply("agent.auto_retry_start", { attempt: 1, maxAttempts: 2 });
assert.match(turn.snapshot().status!, /重试（1\/2）/);
turn.apply("agent.queue_update", { steering: ["change direction"], followUp: ["next"] });
turn.apply("agent.auto_retry_end", { success: true });
assert.equal(turn.snapshot().status, "待处理：1 条转向 · 1 条追问");
turn.apply("agent.compaction_start", {});
assert.match(turn.snapshot().status!, /整理上下文/);
turn.apply("agent.compaction_end", {});
turn.apply("agent.queue_update", { steering: [], followUp: [] });
assert.equal(turn.snapshot().status, undefined);
turn.apply("agent.extension_status", { key: "import", text: "正在导入 2/4" });
turn.apply("agent.extension_status", { key: "other", text: "校对中" });
turn.apply("agent.extension_status", { key: "import" });
assert.equal(turn.snapshot().status, "校对中", "clearing one extension status must preserve the other");
turn.apply("agent.extension_status", { key: "other", text: "" });
assert.equal(turn.snapshot().status, undefined);
turn.apply("tool.execution.start", { toolCallId: "progress", toolName: "read", args: {} });
turn.apply("tool.execution.update", { toolCallId: "progress", partialResult: { content: [{type:"text",text:"Read 4/8 files"}] } });
const partial = turn.snapshot().parts[0];
assert.equal(partial?.kind === "tool" && partial.running && partial.result, "Read 4/8 files");
turn.apply("tool.execution.end", { toolCallId: "progress", result: { content: [{type:"text",text:"Read 8/8 files"}] } });
const final = turn.snapshot().parts[0];
assert.equal(final?.kind === "tool" && !final.running && final.result, "Read 8/8 files");
assert.equal(partial?.kind === "tool" && partial.result, "Read 4/8 files", "older immutable snapshot changed");
const visible = { role:"custom", customType:"extension-note", content:[{type:"text",text:"Import completed"}], display:true };
turn.apply("message.end", {message:visible});
turn.apply("message.end", {message:{...visible,display:false,content:"hidden state"}});
assert.equal(turn.snapshot().parts.filter(p=>p.kind==="text").map(p=>p.text).join(""),"Import completed");
const persisted = buildTurns([
  {id:"visible",seq:0,role:"custom",content:visible},
  {id:"hidden",seq:1,role:"custom",content:{...visible,display:false}},
] as StoredMessage[]);
assert.equal(persisted.length,1);
assert.deepEqual(persisted[0]!.parts,[{kind:"text",text:"Import completed"}]);
console.log("PASS retry/compaction/queue lifecycle, partial tool snapshots, and visible custom-message replay");

const stopped = new LiveTurn();
stopped.apply("tool.execution.start", { toolCallId: "cancel", toolName: "generate_image", args: {} });
stopped.apply("tool.execution.end", { toolCallId: "cancel", isError: true, cancelled: true, result: { content: [{type:"text",text:"This operation was aborted"}] } });
stopped.apply("message.end", { message: {role:"assistant",stopReason:"error",errorMessage:"This operation was aborted",uncensiaCancelled:true} });
assert.equal(stopped.snapshot().cancelled, true);
assert.equal(stopped.snapshot().error, undefined);
assert.equal(stopped.snapshot().parts.some(part => part.kind === "tool" && part.cancelled), true);
const stoppedReplay = buildTurns([
  {id:"call",seq:0,role:"assistant",content:{role:"assistant",content:[{type:"toolCall",id:"cancel",name:"generate_image",arguments:{}}]}},
  {id:"result",seq:1,role:"toolResult",content:{role:"toolResult",toolCallId:"cancel",isError:true,uncensiaCancelled:true,content:[{type:"text",text:"This operation was aborted"}]}},
  {id:"end",seq:2,role:"assistant",content:{role:"assistant",stopReason:"error",errorMessage:"This operation was aborted",uncensiaCancelled:true,content:[]}},
] as StoredMessage[])[0]!;
assert.equal(stoppedReplay.cancelled, true);
assert.equal(stoppedReplay.error, undefined);
assert.equal(stoppedReplay.parts.some(part => part.kind === "tool" && part.cancelled), true);
const providerFailure = buildTurns([{id:"failed",seq:0,role:"assistant",content:{role:"assistant",stopReason:"error",errorMessage:"Provider aborted the request",content:[]}}] as StoredMessage[])[0]!;
assert.equal(providerFailure.cancelled, undefined, "provider wording must not imply a user cancellation");
assert.equal(providerFailure.error, "Provider aborted the request");
console.log("PASS explicit cancellation survives live/replay while provider errors remain failures");

const reference = "img_0123456789abcdef0123456789abcdef";
const inspected = new LiveTurn();
inspected.apply("tool.execution.start", { toolCallId: "look", toolName: "view_image", args: { image_id: reference } });
inspected.apply("tool.execution.end", { toolCallId: "look", result: { content: [{type:"image_ref",image_id:reference}] } });
assert(!inspected.snapshot().parts.some(p => p.kind === "image"), "inspecting existing media must not republish it as a new full-size result");
const replayed = buildTurns([
  {id:"call",seq:0,role:"assistant",content:{role:"assistant",content:[{type:"toolCall",id:"look",name:"view_image",arguments:{image_id:reference}}]}},
  {id:"result",seq:1,role:"toolResult",content:{role:"toolResult",toolCallId:"look",content:[{type:"image_ref",image_id:reference}]}},
] as StoredMessage[]);
assert(!replayed.flatMap(t=>t.parts).some(p=>p.kind === "image"));
inspected.apply("tool.execution.start", { toolCallId: "make", toolName: "generate_image", args: {} });
inspected.apply("tool.execution.end", { toolCallId: "make", result: { content: [{type:"image_ref",image_id:reference}] } });
assert(inspected.snapshot().parts.some(p => p.kind === "image"), "generated media must remain visible even without assistant markup");
console.log("PASS image inspection stays in its tool card while generated outputs remain visible");

const videoId = "vid_0123456789abcdef0123456789abcdef";
for (const [text, standalone] of [
  [`![clip](video://${videoId})`, false],
  [`![clip](/v1/videos/${videoId})`, false],
  [`[download](video://${videoId})`, true],
  [`\`![clip](video://${videoId})\``, true],
  [`![clip](video://${videoId}`, true],
] as const) {
  const liveVideo = new LiveTurn();
  liveVideo.apply("tool.execution.start", { toolCallId: "video", toolName: "generate_video", args: {} });
  liveVideo.apply("tool.execution.end", { toolCallId: "video", result: { content: [{ type: "video_ref", video_id: videoId }] } });
  assert(liveVideo.snapshot().parts.some(part => part.kind === "video"));
  liveVideo.apply("message.delta", { assistantMessageEvent: { type: "text_delta", delta: text } });
  assert.equal(liveVideo.snapshot().parts.some(part => part.kind === "video"), standalone);
  const replayVideo = buildTurns([
    { id: "call", seq: 0, role: "assistant", content: { content: [{ type: "toolCall", id: "video", name: "generate_video", arguments: {} }] } },
    { id: "result", seq: 1, role: "toolResult", content: { toolCallId: "video", content: [{ type: "video_ref", video_id: videoId }] } },
    { id: "answer", seq: 2, role: "assistant", content: { content: [{ type: "text", text }] } },
  ] as StoredMessage[]);
  assert.equal(replayVideo.flatMap(turn => turn.parts).some(part => part.kind === "video"), standalone);
}
console.log("PASS video embeds replace standalone results in live and replay; links, code and incomplete embeds retain them");

const echoedMarker = buildTurns([
  {id:"call",seq:0,role:"assistant",content:{role:"assistant",content:[{type:"toolCall",id:"make",name:"generate_image",arguments:{}}]}},
  {id:"result",seq:1,role:"toolResult",content:{role:"toolResult",toolCallId:"make",content:[{type:"image_ref",image_id:reference}]}},
  {id:"answer",seq:2,role:"assistant",content:{role:"assistant",content:[{type:"text",text:`[image image_id=${reference}]`}]}},
] as StoredMessage[])[0]!;
assert(!echoedMarker.parts.some(part => part.kind === "image"), "echoed rendered marker must replace its duplicate fallback image");
const codeMarker = new LiveTurn();
codeMarker.apply("tool.execution.start", {toolCallId:"code",toolName:"generate_image",args:{}});
codeMarker.apply("tool.execution.end", {toolCallId:"code",result:{content:[{type:"image_ref",image_id:reference}]}});
codeMarker.apply("message.delta", {assistantMessageEvent:{type:"text_delta",delta:`Example: \`image://${reference}\``}});
assert(codeMarker.snapshot().parts.some(part => part.kind === "image"), "an image URI in a code example is not a displayed image");

const commandMessage = {id:"command",seq:0,role:"user",content:{role:"user",uncensiaSkillInvocation:{name:"roleplay",userMessage:"继续故事"},content:[{type:"text",text:"<skill>large durable procedure</skill>"},{type:"image_ref",image_id:reference}]}};
const commandTurn = buildTurns([commandMessage] as StoredMessage[])[0]!;
assert.deepEqual(commandTurn.parts,[{kind:"text",text:"/skill:roleplay\n\n继续故事"},{kind:"image",imageId:reference,referenceRole:undefined}]);
assert.equal(commandMessage.content.content[0]!.text,"<skill>large durable procedure</skill>","display must not rewrite durable expansion");
console.log("PASS explicit skill commands display compactly and preserve attachments and stored procedure");

// Existing conversations retain their original metadata after the product rename.
const legacyCommand = { ...commandMessage, content: { ...commandMessage.content, uncensiaSkillInvocation: undefined,
  lumaSkillInvocation: commandMessage.content.uncensiaSkillInvocation } };
assert.deepEqual(buildTurns([legacyCommand] as StoredMessage[])[0]!.parts, commandTurn.parts);
const legacyCancelled = buildTurns([{ id: 'legacy', seq: 0, role: 'assistant', content: {
  content: [{ type: 'text', text: 'Partial response' }], lumaCancelled: true, stopReason: 'error', errorMessage: 'aborted',
} }] as StoredMessage[])[0]!;
assert.equal(legacyCancelled.cancelled, true);
assert.equal(legacyCancelled.error, undefined);
console.log('PASS pre-rename conversations retain skill labels and cancellation state');
