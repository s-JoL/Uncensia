import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { startOpenAiStub } from './stub-openai.ts';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'uncensia-product-'));
process.env.UNCENSIA_DATA_DIR=dir; process.env.UNCENSIA_ACCESS_CODE='PRODUCTTESTCODE';
const {createServices}=await import('../src/server/services.ts');
const {createApp}=await import('../src/server/http/app.ts');
const {projectTranscript}=await import('../src/server/agent/projection.ts');
const services=createServices(); const app=createApp(services);
let watched=''; let watchedFile='';
const stub=await startOpenAiStub(0,(body)=> {
 if(watchedFile && !body.messages?.some(m=>m.role==='tool' && JSON.stringify(m.content).includes('image'))) return {kind:'tool',name:'read',args:{path:watchedFile}};
 if(watched && !body.messages?.some(m=>m.role==='tool')) return {kind:'tool',name:'view_image',args:{intent:'inspect the chosen reference',image_id:watched}};
 return {kind:'text',text:'Fixture inspected the selected image.'};
});
let auth='';
async function call(method:string,url:string,body?:unknown){const r=await app.request('/v1'+url,{method,headers:{...(auth?{authorization:`Bearer ${auth}`} : {}),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:r.status===204?null:await r.json() as any};}
try{
 const login=await call('POST','/auth/token',{accessCode:'PRODUCTTESTCODE',deviceName:'product-audit'});auth=login.body.token;
 services.store.upsertProvider({id:'fixture',name:'fixture',baseUrl:stub.url+'/v1',auth:{style:'none'},enabled:true});
 services.store.upsertModel({id:'fixture-chat',providerId:'fixture',model:'stub-chat',name:'fixture',apiMode:'openai-chat',kind:'chat',enabled:true,pinned:false,reasoning:false,input:['text','image'],contextWindow:32000,maxTokens:2000,thinkingLevel:'off'});
 services.reload();
 const ids:string[]=[];
 for(const [i,color] of ['red','blue'].entries()){
  const bytes=await sharp({create:{width:40,height:40,channels:3,background:color}}).png().toBuffer();
  const form=new FormData();form.set('file',new File([new Uint8Array(bytes)],`reference-${i}.png`,{type:'image/png'}));
  const r=await app.request('/v1/files',{method:'POST',headers:{authorization:`Bearer ${auth}`},body:form}); assert.equal(r.status,201);ids.push((await r.json() as any).id);
 }
 assert.equal((await call('POST','/conversations',{modelId:'does-not-exist'})).status,422);
 const created=await call('POST','/conversations',{modelId:'fixture-chat',title:'Reference contract'});assert.equal(created.status,201,JSON.stringify(created.body));const id=created.body.id;
 const rp={enabled:false,character:'Mira',persona:'Reporter',world:'Clock shop',scene:'Previous scene',style:'Short dialogue',examples:'Voice demonstration only'};
 assert.equal((await call('PATCH',`/conversations/${id}`,{roleplay:rp})).status,200);
 assert.deepEqual((await call('GET',`/conversations/${id}`)).body.roleplay,rp,'RP examples must round-trip independently');
 for(const invalid of [{...rp,examples:'x'.repeat(6001)},{...rp,scene:123},{...rp,enabled:'false'},null,[]]) {
   assert.equal((await call('PATCH',`/conversations/${id}`,{title:'Must not be saved',roleplay:invalid})).status,400);
   const unchanged=(await call('GET',`/conversations/${id}`)).body;
   assert.equal(unchanged.title,'Reference contract','invalid context partially changed conversation');
   assert.deepEqual(unchanged.roleplay,rp,'invalid context overwrote saved notes');
 }
 assert.equal((await call('POST',`/conversations/${id}/runs`,{text:'test',attachments:[ids[0]],imageReferences:[{imageId:ids[1],role:'base'}]})).status,400);
 const visual={enabled:true,description:'Stable reference',references:[{imageId:ids[0],role:'subject',label:'Original'}],lastImageId:null,lastPrompt:''};
 assert.equal((await call('PATCH',`/conversations/${id}`,{visualContinuity:visual})).status,200);
 for(const invalid of [null,[],{...visual,enabled:'false'},{...visual,description:'x'.repeat(10001)},{...visual,references:[{...visual.references[0],role:'unknown'}]},{...visual,references:Array(4).fill(visual.references[0])},{...visual,references:[{...visual.references[0],imageId:'img_'+'0'.repeat(32)}]},{...visual,lastImageId:'img_'+'0'.repeat(32)}]) {
   assert.equal((await call('PATCH',`/conversations/${id}`,{title:'Must not be saved',roleplay:{...rp,scene:'Must not be saved'},visualContinuity:invalid})).status,400);
   const unchanged=(await call('GET',`/conversations/${id}`)).body;
   assert.equal(unchanged.title,'Reference contract');assert.deepEqual(unchanged.roleplay,rp);assert.deepEqual(unchanged.visualContinuity,visual);
 }
 console.log('PASS invalid visual references, roles and limits fail visibly before any context or title changes');
 const started=await call('POST',`/conversations/${id}/runs`,{text:'Use the second image as the base and the first as a style reference.',attachments:ids,imageReferences:[{imageId:ids[1],role:'base'},{imageId:ids[0],role:'style'}]});assert.equal(started.status,202);
 async function finish(runId:string){for(let i=0;i<200;i++){const run=services.store.getRun(runId);if(run?.status==='completed')return;if(run?.status==='failed')throw new Error(run.error??'failed');await new Promise(r=>setTimeout(r,50));}throw new Error('run timed out');}
 await finish(started.body.runId);
 const request=stub.requests.find(r=>r.messages?.some(m=>JSON.stringify(m.content).includes('user_assigned_role=base')));assert(request,'role not transported');
 const system = JSON.stringify(request.messages?.filter(message => message.role === 'system'));
 assert.equal(system.split('<available_skills>').length-1,1,'duplicate or missing Pi skill catalog');
 assert(!system.includes('<project_context>'),'checkout instructions leaked into ordinary product chat');
 assert.equal(JSON.stringify(request.messages).split('data:image/').length-1,2,'both images must reach the model');
 const messages=(await call('GET',`/conversations/${id}/messages`)).body.items;
 assert(JSON.stringify(messages).includes('reference_role'));assert(!JSON.stringify(messages).includes('base64,'));
 console.log('PASS reversed upload order preserves explicit base/style roles and sends both pixels; storage contains references');
 watched=ids[1]!;stub.requests.length=0;
 const second=await call('POST',`/conversations/${id}/runs`,{text:'Inspect the prior base image again.',attachments:[]});await finish(second.body.runId);
 assert(stub.requests.some(r=>r.messages?.some(m=>m.role==='tool') && JSON.stringify(r.messages).includes('data:image/')),'view_image pixels were lost after persistence');
 console.log('PASS historical view_image delivers pixels through the SDK tool-result round trip');
 const tree=(await call('GET',`/conversations/${id}/tree`)).body;
 const firstUser=tree.entries.find((e:any)=>e.role==='user');
 const fork=await call('POST',`/conversations/${id}/fork`,{entryId:firstUser.id});assert.equal(fork.status,201);
 assert.deepEqual(fork.body.roleplay,rp,'fork lost saved RP fields');
 const forkMessages=(await call('GET',`/conversations/${fork.body.id}/messages`)).body.items;assert.equal(forkMessages.length,1);assert(JSON.stringify(forkMessages).includes('reference_role'));
 assert.equal((await call('POST',`/conversations/${id}/runs`,{text:'test',modelId:'unknown'})).status,422);
 const matches=(await call('GET','/conversations/search?q=second%20image')).body.items;
 assert(matches.some((hit:any)=>hit.conversationId===id) && matches.some((hit:any)=>hit.conversationId===fork.body.id),'forked IDs collided in history search');
 services.store.upsertMemory('audit_fact','An explicitly saved fixture fact.',8,id);
 assert.equal((await call('GET','/memory')).body.items.find((item:any)=>item.key==='audit_fact').sourceConversationId,id);
 await call('PUT','/memory/audit_fact',{value:'A manually corrected fact.'});
 assert.equal((await call('GET','/memory')).body.items.find((item:any)=>item.key==='audit_fact').sourceConversationId,null);
 console.log('PASS HTTP fork preserves selected message references and model errors never silently switch models');
 const customSource=services.store.createConversation('fixture-chat','Custom branch fixture');
 const customSession=await services.sessions.session(customSource.id);
 const banner=customSession.appendCustomMessageEntry('fixture.banner',[{type:'text',text:'Visible before user'}],true,{assetId:ids[0]});
 const question=customSession.appendMessage({role:'user',content:'Custom branch question',timestamp:Date.now()});
 const hidden=customSession.appendCustomMessageEntry('fixture.internal','Hidden between messages',false,{key:'fixture-state'});
 const answer=customSession.appendMessage({role:'assistant',content:[{type:'text',text:'Custom branch answer'}],api:'openai-completions',provider:'fixture',model:'stub-chat',stopReason:'stop',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
 const footer=customSession.appendCustomMessageEntry('fixture.footer','Visible after answer',true);
 customSession.appendCustomEntry('fixture.private',{notAMessage:true});
 await projectTranscript(services.store,services.sessions,customSource.id);
 const originalCustomRows=(await call('GET',`/conversations/${customSource.id}/messages`)).body.items;
 const originalCustomEntries=JSON.stringify(customSession.getEntries());
 for(const [entryId,length] of [[banner,1],[question,2],[hidden,3],[answer,4],[footer,5]] as const){
  const response=await call('POST',`/conversations/${customSource.id}/fork`,{entryId});assert.equal(response.status,201);
  const projected=(await call('GET',`/conversations/${response.body.id}/messages`)).body.items;
  assert.deepEqual(projected.map((row:any)=>({role:row.role,content:row.content})),originalCustomRows.slice(0,length).map((row:any)=>({role:row.role,content:row.content})),`fork at ${entryId} changed custom message ordering, display or metadata`);
  assert.deepEqual(projected.map((row:any)=>services.store.messageEntryId(response.body.id,row.seq)),[banner,question,hidden,answer,footer].slice(0,length));
  if(length>=3)assert.equal(projected[2].content.display,false,'hidden custom message must remain hidden after fork');
  assert.equal(projected[0].content.display,true);
 }
 const leafFork=await call('POST',`/conversations/${customSource.id}/fork`,{});assert.equal(leafFork.status,201);
 assert.equal((await call('GET',`/conversations/${leafFork.body.id}/messages`)).body.items.length,5,'private extension state must not become a message');
 assert.deepEqual((await call('GET',`/conversations/${customSource.id}/messages`)).body.items,originalCustomRows,'fork rewrote source transcript');
 assert.equal(JSON.stringify(customSession.getEntries()),originalCustomEntries,'fork rewrote source SDK tree');
 console.log('PASS HTTP forks at custom/user/assistant nodes preserve exact order, display flags, metadata and source history');
 watched='';
 const manager=await services.sessions.session(id);
 manager.appendMessage({role:'user',content:'Long context fact. '.repeat(12000),timestamp:Date.now()});
 manager.appendMessage({role:'assistant',content:[{type:'text',text:'Acknowledged the long context.'}],api:'openai-completions',provider:'fixture',model:'stub-chat',stopReason:'stop',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}});
 stub.requests.length=0;
 const compact=await call('POST',`/conversations/${id}/compact`);assert.equal(compact.status,202);await finish(compact.body.runId);
 assert(manager.getEntries().some(entry=>entry.type==='compaction'),'SDK did not persist compaction');
 assert(stub.requests.some(request=>JSON.stringify(request.messages).includes('user_assigned_role=base')),'compaction discarded image identities or roles before summarization');
 console.log('PASS native SDK compaction receives reference IDs and roles and retains the original tree');
 watchedFile=services.store.getFile(ids[0]!)!.diskPath;
 services.config.saveCapabilities({coding:{read:true,write:false,shell:false,workspace:dir}});
 const readConversation=services.store.createConversation('fixture-chat','Read image');stub.requests.length=0;
 const readRun=await call('POST',`/conversations/${readConversation.id}/runs`,{text:'Read the image fixture.'});await finish(readRun.body.runId);
 assert(stub.requests.some(request=>request.messages?.some(message=>message.role==='tool') && JSON.stringify(request.messages).includes('data:image/')),'Pi read pixels were not hydrated after persistence');
 console.log('PASS standard Pi read images survive the full SDK persistence and provider round trip');
 assert.equal((await call('DELETE',`/files/${ids[0]}`)).status,204);
 const missingReferenceFork=await call('POST',`/conversations/${id}/fork`,{entryId:firstUser.id});
 assert.equal(missingReferenceFork.status,201);assert.deepEqual(missingReferenceFork.body.visualContinuity.references,visual.references,'historical fork silently dropped the deleted reference identity');
 console.log('PASS historical fork preserves the identity of an explicitly deleted reference');


}finally{await services.close();await stub.close();}
console.log('Product contract acceptance PASS');
