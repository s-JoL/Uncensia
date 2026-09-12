import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { startOpenAiStub } from "./stub-openai.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uncensia-delivery-"));
process.env.UNCENSIA_DATA_DIR = dir;
process.env.UNCENSIA_ACCESS_CODE = "DELIVERYAUDITCODE";
const { createServices } = await import("../src/server/services.ts");
const { ingestFile, preserveToolOutput } = await import("../src/server/library.ts");
const { persistMessage } = await import("../src/server/agent/messages.ts");
const { resourceTools } = await import("../src/server/tools/resources.ts");
const { readResource, quoteResource, getQuote, deliverable, reviewDeliverable } = await import("../src/server/resources.ts");
const { fileRoutes } = await import("../src/server/http/routes/files.ts");
const services = createServices();
try {
  const conv = services.store.createConversation("fixture", "Delivery");
  const other = services.store.createConversation("fixture", "Other");
  const tools = resourceTools(services.config, services.store, conv.id, async () => {});
  const call = async (name: string, args: object) => {
    const tool = tools.find(t => t.name === name)!;
    const result = await tool.execute("audit", args);
    return JSON.parse((result.content[0] as { text: string }).text);
  };
  const ids = new Set<string>();
  for (let i = 0; i < 151; i++) ids.add(ingestFile(services.store, {name:`catalog-${i}.txt`,bytes:Buffer.from(`item ${i}`)}).file.id);
  let page = await call("list_resources", {query:"catalog-",limit:50});
  const listed = [...page.items];
  assert.ok(page.next_cursor, "large catalogs must provide a next page");
  await assert.rejects(()=>call("list_resources",{query:"different",cursor:page.next_cursor}),/cursor/i);
  ingestFile(services.store, {name:"catalog-new.txt",bytes:Buffer.from("new after page one")});
  while (page.next_cursor) { page = await call("list_resources", {query:"catalog-",limit:50,cursor:page.next_cursor}); listed.push(...page.items); }
  assert.equal(listed.length,151);
  assert.deepEqual(new Set(listed.map((f: {id:string})=>f.id)),ids);
  const original = "前言".repeat(1700)+"needle-marker\ncomplete ending";
  services.store.replaceMessages(other.id,[{entryId:"history-entry",message:{role:"assistant",content:[{type:"text",text:original}],timestamp:12345}}]);
  const local = await call("search_history",{query:"needle-marker",scope:"conversation"});
  assert.equal(local.messages.length,0);
  const history = await call("search_history",{query:"needle-marker",scope:"personal"});
  assert.match(history.messages[0].content,/needle-marker/);
  assert.ok(history.messages[0].history_ref);
  const ref = history.messages[0].history_ref;
  assert.equal((await readResource(services.store,conv.id,{history_ref:ref})).text,original);
  await assert.rejects(()=>readResource(services.store,other.id,{history_ref:ref}),/reference|conversation/i);
  await assert.rejects(()=>readResource(services.store,conv.id,{entry_id:"history-entry"}),/not found/i);
  const quote = await quoteResource(services.store,conv.id,{history_ref:ref});
  assert.equal(getQuote(services.store,quote.id)?.text,original);
  const originals: Array<{id:string;text:string}> = [];
  for (const text of ["x".repeat(80000)+"TAIL", ("中文行\n".repeat(20000))+"TAIL"]) {
    const message = persistMessage({role:"toolResult",content:[{type:"text",text}]},[],text=>preserveToolOutput(services.store,conv.id,text)) as {content:Array<{text:string}>};
    const fileId = /file_id=(file_[a-f0-9]+)/.exec(message.content[0]!.text)?.[1];
    assert.ok(fileId,"bounded history links to the complete original");
    const file = services.store.getFile(fileId)!;
    assert.equal(fs.readFileSync(file.diskPath,"utf8"),text);
    assert.notEqual(ingestFile(services.store,{name:"editable.txt",bytes:Buffer.from(text)}).file.id,fileId);
    assert.ok((await readResource(services.store,conv.id,{file_id:fileId,find_text:"TAIL"})).text.endsWith("TAIL"));
    originals.push({id:fileId,text});
    if (text.startsWith("x")) {
      const preview = await call("read_resource",{file_id:fileId,max_characters:2000});
      assert.ok(preview.next_character,"a long single line must have a readable continuation");
      const ending = await call("read_resource",{file_id:fileId,find_text:"TAIL",max_characters:2000});
      assert.match(ending.numbered_lines,/TAIL/);
      assert.ok(ending.numbered_lines.length < 2100);
    }
  }
  const source = ingestFile(services.store,{name:"chapter.txt",bytes:Buffer.from("chapter version one")}).file;
  const input = {key:"chapter-1",description:"Chapter one",status:"verified" as const,asset_id:source.id,evidence:"Read the complete text"};
  const first = deliverable(services.store,conv.id,input);
  assert.notEqual(first.asset_id,source.id);
  assert.equal(first.revision,1);
  assert.throws(()=>deliverable(services.store,conv.id,{...input,key:"duplicate"}),/already belongs/);
  reviewDeliverable(services.store,conv.id,first.key,first.revision,"accepted");
  assert.equal(deliverable(services.store,conv.id,input).review?.status,"accepted","identical replay preserves the review");
  fs.writeFileSync(source.diskPath,"chapter version two");
  const second = deliverable(services.store,conv.id,input);
  assert.equal(second.revision,2);
  assert.equal(second.review,undefined,"revisions require a new user review");
  assert.equal(fs.readFileSync(services.store.getFile(first.asset_id!)!.diskPath,"utf8"),"chapter version one");
  assert.throws(()=>reviewDeliverable(services.store,conv.id,second.key,1,"accepted"),/changed/);
  const app = fileRoutes(services);
  let character = 0, reconstructed = "", version: string | undefined;
  do {
    const response = await app.request(`/resources/files/${originals[0]!.id}?character=${character}${version ? `&version=${version}` : ""}`);
    assert.equal(response.status,200);
    const window = await response.json();
    reconstructed += window.text; version = window.version; character = window.next_character;
  } while (character !== null);
  assert.equal(reconstructed,originals[0]!.text,"HTTP character pages recover a giant single line exactly");
  const emojiText = "😀".repeat(1700)+"END";
  const emoji = ingestFile(services.store,{name:"emoji.txt",bytes:Buffer.from(emojiText)}).file;
  let offset = 0, joined = "";
  do {
    const window = await readResource(services.store,conv.id,{file_id:emoji.id,start_character:offset,max_characters:599});
    joined += window.text; offset = window.next_character!;
    assert.equal(Buffer.from(window.text).toString("utf8"),window.text,"UTF-8 round trip must not replace a split surrogate");
  } while (offset !== null);
  assert.equal(joined,emojiText);
  const update = await app.request(`/files/${first.asset_id}/text`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({text:"changed"})});
  assert.equal(update.status,409);
  const url = `/resources/conversations/${conv.id}/deliverables/${first.key}`;
  const accepted = await app.request(`${url}/review`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({revision:2,status:"accepted"})});
  assert.equal(accepted.status,200);
  assert.equal((await accepted.json()).review.status,"accepted");
  assert.equal((await (await app.request(`${url}/versions`)).json()).length,2);
  const huge = "HUGE_TOOL:" + "x".repeat(90000) + "TOOL_END: complete";
  services.mcp.currentTools = () => [{name:"large_output",label:"Fixture",description:"Return a large test log",parameters:Type.Object({}),execute:async()=>({content:[{type:"text",text:huge}],details:{}})}];
  let step = 0;
  const stub = await startOpenAiStub(0, body => {
    if (++step === 1) return {kind:"tool",name:"large_output",args:{}};
    const output = String(body.messages?.findLast(message=>message.role === "tool")?.content);
    if (step === 2) {
      const originalId = /file_id=(file_[a-f0-9]+)/.exec(output)?.[1];
      assert.ok(originalId,"the SDK replay carries a saved original ID");
      assert.equal(fs.readFileSync(services.store.getFile(originalId)!.diskPath,"utf8"),huge);
      originals.push({id:originalId,text:huge});
      return {kind:"tool",name:"read_resource",args:{file_id:originalId,find_text:"TOOL_END"}};
    }
    assert.match(output,/TOOL_END: complete/);
    assert.ok(output.length < 1000,"the tail reaches the provider in a bounded window");
    return {kind:"text",text:"Complete original recovered."};
  });
  try {
    services.config.savePrompts({titleEnabled:false});
    services.store.upsertProvider({id:"fixture",name:"fixture",baseUrl:stub.url+"/v1",auth:{style:"none"},enabled:true});
    services.store.upsertModel({id:"fixture",providerId:"fixture",model:"fixture",name:"fixture",apiMode:"openai-chat",kind:"chat",enabled:true,reasoning:false,input:["text"],contextWindow:32000,maxTokens:1000,thinkingLevel:"off"});
    services.reload();
    const run = services.store.createRun(conv.id,"fixture");
    await services.runtime.start(run.id,conv.id,{message:"Run the large output fixture, then recover its exact ending.",modelId:"fixture"});
    assert.equal(services.store.getRun(run.id)?.status,"completed");
    assert.equal(step,3);
  } finally { await stub.close(); }
  await services.close();
  const restarted = createServices();
  try {
    for (const original of originals) assert.equal(fs.readFileSync(restarted.store.getFile(original.id)!.diskPath,"utf8"),original.text);
    const restored = await (await fileRoutes(restarted).request(`/resources/conversations/${conv.id}/evidence`)).json();
    assert.equal(restored.deliverables[0].review.status,"accepted");
  } finally { await restarted.close(); }
  console.log("PASS delivery: stable 151-item catalog, scoped history, restart-safe long originals, immutable versions and user review conflicts");
} finally { await services.close(); fs.rmSync(dir,{recursive:true,force:true}); }
