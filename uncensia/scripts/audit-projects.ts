import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startOpenAiStub } from "./stub-openai.ts";
import { applyPatch } from "diff";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uncensia-projects-"));
process.env.UNCENSIA_DATA_DIR = dir;
process.env.UNCENSIA_ACCESS_CODE = "PROJECTSAUDITCODE";
const { createServices } = await import("../src/server/services.ts");
const { createApp } = await import("../src/server/http/app.ts");
const { ingestFile } = await import("../src/server/library.ts");
const { resourceTools } = await import("../src/server/tools/resources.ts");
const { fileSearchTool } = await import("../src/server/tools/file-search.ts");
const { projectFileIds, conversationProject, updateProject } = await import("../src/server/projects.ts");
const { deliverable } = await import("../src/server/resources.ts");
const services = createServices();
try {
  const app = createApp(services);
  const login = await app.request("/v1/auth/token", { method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify({accessCode:process.env.UNCENSIA_ACCESS_CODE}) });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const request = (url: string, method = "GET", body?: unknown) => app.request(`/v1${url}`, {method, headers:{authorization:`Bearer ${token}`, "content-type":"application/json"}, ...(body === undefined ? {} : {body:JSON.stringify(body)})});
  const created = await request("/projects", "POST", {title:"Novel A", instructions:"Use the BLUE-41 setting."});
  assert.equal(created.status, 201, "a project must persist its instructions and identity");
  const a = await created.json();
  const b = await (await request("/projects","POST",{title:"Novel B",instructions:"Use the RED-99 setting."})).json();
  assert.equal((await request("/projects","POST",{title:" "})).status,400);
  const conv = services.store.createConversation("fixture","A",a.id);
  const other = services.store.createConversation("fixture","B",b.id);
  const ordinary = services.store.createConversation("fixture","Ordinary");
  const moved = services.store.createConversation("fixture","Move check");
  assert.equal((await request(`/conversations/${moved.id}`,"PATCH",{projectId:a.id})).status,200);
  assert.ok(services.store.getConversation(moved.id)!.updatedAt > moved.updatedAt,"other clients observe membership changes through the conversation revision");
  assert.equal((await request(`/conversations/${moved.id}`,"PATCH",{projectId:null})).status,200);
  const make = (name: string, text: string, conversationId?: string) => {
    const file = ingestFile(services.store,{name,bytes:Buffer.from(text),conversationId}).file;
    services.store.replaceChunks(file.id,[{idx:0,page:1,text}]);
    return file;
  };
  const fa = make("BLUE_FILE.txt","project-marker blue",conv.id);
  const fb = make("RED_FILE.txt","project-marker red",other.id);
  const fg = make("ordinary.txt","project-marker ordinary");
  const call = async (id: string, name: string, args: object) => {
    const tool = resourceTools(services.config,services.store,id,async()=>{}).find(t=>t.name===name)!;
    return JSON.parse((await tool.execute("audit",args)).content.filter(p=>p.type==="text").map(p=>p.text).join(""));
  };
  const listed = async (id: string, args = {}) => (await call(id,"list_resources",args)).items.map((f: {id:string})=>f.id).sort();
  assert.deepEqual(await listed(conv.id),[fa.id]);
  assert.deepEqual(await listed(other.id),[fb.id]);
  assert.deepEqual(await listed(ordinary.id),[fg.id]);
  assert.deepEqual(await listed(conv.id,{scope:"personal"}),[fa.id,fb.id,fg.id].sort());
  assert.equal((await request(`/projects/${a.id}/files/${fb.id}`,"PUT")).status,204);
  assert.deepEqual(await listed(conv.id),[fa.id,fb.id].sort());
  assert.equal((await request(`/projects/${a.id}/files/${fb.id}`,"DELETE")).status,204);
  assert.ok(services.store.getFile(fb.id),"removing a link preserves the source");
  assert.equal((await request(`/projects/missing/files/${fb.id}`,"PUT")).status,404);
  // Deduplication retains one original while linking the repeated import.
  assert.equal(ingestFile(services.store,{name:"same.txt",bytes:Buffer.from("project-marker ordinary"),conversationId:conv.id}).file.id,fg.id);
  assert.deepEqual(await listed(conv.id),[fa.id,fg.id].sort());
  const firstPage = await call(conv.id,"list_resources",{limit:1});
  await assert.rejects(()=>call(conv.id,"list_resources",{scope:"personal",cursor:firstPage.next_cursor}),/cursor/i);
  const search = fileSearchTool(services.retrieval,"keyword",()=>projectFileIds(services.store,a.id));
  const text = async (tool: typeof search, args: object) => (await tool.execute("audit",{intent:"audit",query:"project-marker",...args})).content.filter(p=>p.type==="text").map(p=>p.text).join("");
  assert.ok(!(await text(search,{})).includes(fb.id));
  assert.ok((await text(search,{file_ids:[fb.id]})).includes(fb.id),"explicit cross-project IDs work");
  assert.match(await text(fileSearchTool(services.retrieval,"keyword",()=>[]),{}),/No files in the current scope/);
  services.store.replaceMessages(other.id,[{entryId:"b-entry",message:{role:"assistant",content:[{type:"text",text:"history-project-marker"}],timestamp:123}}]);
  assert.equal((await call(conv.id,"search_history",{query:"history-project-marker",scope:"project"})).messages.length,0);
  assert.equal((await call(conv.id,"search_history",{query:"history-project-marker",scope:"personal"})).messages.length,1);
  await assert.rejects(()=>call(ordinary.id,"search_history",{scope:"project"}),/no project/);
  assert.equal((await request(`/projects/${a.id}`,"PATCH",{title:a.title,instructions:"BLUE-42",revision:1})).status,200);
  assert.equal((await request(`/projects/${a.id}`,"PATCH",{title:a.title,instructions:"stale",revision:1})).status,409);
  const before = "First paragraph stays byte-identical.\r\n\r\nSecond paragraph: blue.\r\n\r\nLast paragraph stays byte-identical.😀\r\n";
  const after = before.replace("Second paragraph: blue.","Second paragraph: amber.");
  const work = make("chapter.txt",before,conv.id);
  const v1 = deliverable(services.store,conv.id,{key:"chapter",description:"Chapter",status:"produced",asset_id:work.id});
  assert.equal((await request(`/files/${work.id}/text`,"PUT",{text:after})).status,200);
  const v2 = deliverable(services.store,conv.id,{key:"chapter",description:"Chapter",status:"produced",asset_id:work.id});
  const compareUrl = `/resources/conversations/${conv.id}/deliverables/chapter/compare?from=1&to=2`;
  const comparisonResponse = await request(compareUrl);
  assert.equal(comparisonResponse.status,200);
  const comparison = await comparisonResponse.json();
  assert.equal(comparison.kind,"text");
  assert.equal(applyPatch(before,comparison.patch),after,"the diff reconstructs the exact new bytes, including unchanged paragraphs, CRLF and emoji");
  assert.equal(fs.readFileSync(services.store.getFile(v1.asset_id!)!.diskPath,"utf8"),before);
  assert.equal(fs.readFileSync(services.store.getFile(v2.asset_id!)!.diskPath,"utf8"),after);
  assert.equal((await request(compareUrl.replace("from=1","from=999"))).status,400);
  let step = 0;
  const snapshots: string[] = [];
  const stub = await startOpenAiStub(0, body => {
    const current = JSON.stringify(body.messages?.findLast(m=>m.role==="user")?.content);
    snapshots.push(current);
    if (++step === 1) {
      assert.match(current,/BLUE-42/); assert.match(current,/BLUE_FILE/); assert.doesNotMatch(current,/RED-99|RED_FILE/);
      assert.match(current,/Keep the first paragraph unchanged/);
      updateProject(services.store,a.id,{title:a.title,instructions:"BLUE-43",revision:2});
      make("FRESH_FILE.txt","project-marker fresh",conv.id);
      services.store.db.run("UPDATE message_feedback SET text=?,created_at=? WHERE conversation_id=? AND entry_id=?","Keep the opening paragraph unchanged.",Date.now(),conv.id,"feedback-target");
      return {kind:"tool",name:"list_resources",args:{}};
    }
    if (step === 2) {
      assert.match(current,/BLUE-43/); assert.doesNotMatch(current,/BLUE-42/); assert.match(current,/FRESH_FILE/);
      assert.match(current,/Keep the opening paragraph unchanged/);
      assert.doesNotMatch(current,/Keep the first paragraph unchanged/);
    } else assert.doesNotMatch(current,/BLUE-4|RED-99|BLUE_FILE|RED_FILE|FRESH_FILE/);
    return {kind:"text",text:"Project scope verified."};
  });
  try {
    services.config.savePrompts({titleEnabled:false});
    services.store.upsertProvider({id:"fixture",name:"fixture",baseUrl:stub.url+"/v1",auth:{style:"none"},enabled:true});
    services.store.upsertModel({id:"fixture",providerId:"fixture",model:"fixture",name:"fixture",apiMode:"openai-chat",kind:"chat",enabled:true,reasoning:false,input:["text"],contextWindow:32000,maxTokens:1000,thinkingLevel:"off"});
    services.reload();
    services.store.db.run("INSERT INTO message_feedback(conversation_id,entry_id,text,created_at) VALUES(?,?,?,?)",conv.id,"feedback-target","Keep the first paragraph unchanged.",Date.now());
    const run = services.store.createRun(conv.id,"fixture");
    assert.equal((await request(`/conversations/${conv.id}`,"PATCH",{projectId:b.id})).status,409);
    await services.runtime.start(run.id,conv.id,{message:"Inspect the project's available materials.",modelId:"fixture"});
    assert.equal(services.store.getRun(run.id)?.status,"completed");
    const evidence = services.store.db.all<{data:string}>("SELECT data FROM events WHERE run_id=? AND type='provider.request' ORDER BY seq",run.id).map(r=>JSON.parse(r.data));
    assert.deepEqual(evidence.map(e=>e.project),[{id:a.id,revision:2},{id:a.id,revision:3}]);
    const fork = await request(`/conversations/${conv.id}/fork`,"POST",{});
    assert.equal(fork.status,201);
    assert.equal((await fork.json()).projectId,a.id);
    const plainRun = services.store.createRun(ordinary.id,"fixture");
    await services.runtime.start(plainRun.id,ordinary.id,{message:"Inspect the available materials.",modelId:"fixture"});
    assert.equal(services.store.getRun(plainRun.id)?.status,"completed");
    assert.equal(snapshots.length,3);
    const createdConv = await request("/conversations","POST",{modelId:"fixture",projectId:b.id});
    assert.equal(createdConv.status,201); assert.equal((await createdConv.json()).projectId,b.id);
    services.store.db.run("DELETE FROM project_files WHERE project_id=? AND file_id=?",a.id,fa.id);
    const mcpState = services.mcp as unknown as {tools:Array<Record<string,unknown>>};
    mcpState.tools = [{name:"fixture_mcp",label:"fixture_mcp",description:"",parameters:{},execute:async()=>({content:[],details:{savedFileIds:[fa.id]}})}];
    await services.mcp.currentTools(conv.id)[0]!.execute("audit",{});
    assert.ok(projectFileIds(services.store,a.id).includes(fa.id),"MCP documents saved during a project run join that project");
    mcpState.tools = [];
  } finally { await stub.close(); }
  await services.close();
  const restarted = createServices();
  try {
    assert.equal(conversationProject(restarted.store,conv.id)?.instructions,"BLUE-43");
    assert.ok(projectFileIds(restarted.store,a.id).includes(fa.id));
  } finally { await restarted.close(); }
  console.log("PASS projects: isolated defaults, empty-scope search, explicit references, duplicate imports, optimistic updates, live Pi context refresh, fork and restart");
} finally {
  await services.close();
  fs.rmSync(dir, {recursive:true, force:true});
}
