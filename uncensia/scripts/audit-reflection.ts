/**
 * Learning by proposal: which runs are reviewed, which proposals are kept, and
 * that accepting writes through the ordinary memory and skill paths while
 * dismissing writes nothing. The reviewing model is a local stub.
 *
 *   node --import tsx scripts/audit-reflection.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startOpenAiStub } from "./stub-openai.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uncensia-reflection-"));
process.env.UNCENSIA_DATA_DIR = dir;
process.env.UNCENSIA_ACCESS_CODE = "REFLECTIONAUDITCODE";
const { createServices } = await import("../src/server/services.ts");
const { reflectionReason, parseProposal } = await import("../src/server/agent/reflection.ts");
const { managedSkills } = await import("../src/server/tools/skill-management.ts");
const { learningHistory } = await import("../src/server/tools/learning.ts");
const { createApp } = await import("../src/server/http/app.ts");
const { listMods } = await import("../src/server/mods.ts");

const replies: string[] = [];
const prompts: string[] = [];
const stub = await startOpenAiStub(0, body => {
  prompts.push(JSON.stringify(body.messages));
  return { kind: "text", text: replies.shift() ?? '{"action":"none"}' };
});
const services = createServices();
try {
  services.config.savePrompts({ titleEnabled: false });
  services.store.upsertProvider({ id: "fixture", name: "fixture", baseUrl: stub.url + "/v1", auth: { style: "none" }, enabled: true });
  services.store.upsertModel({ id: "fixture", providerId: "fixture", model: "fixture", name: "fixture", apiMode: "openai-chat", kind: "chat", enabled: true, reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000, thinkingLevel: "off" });
  services.reload();
  const workspace = services.config.capabilities().coding.workspace;

  // Which runs are reviewed: facts the server has, not what the person typed.
  const base = { replayed: false, feedback: false, toolCalls: 0, toolErrors: 0, userTurns: 1 };
  assert.equal(reflectionReason(base), null);
  assert.ok(reflectionReason({ ...base, feedback: true }));
  assert.ok(reflectionReason({ ...base, replayed: true }));
  assert.ok(reflectionReason({ ...base, toolCalls: 2, toolErrors: 1 }));
  assert.ok(reflectionReason({ ...base, toolCalls: 5 }));
  assert.ok(reflectionReason({ ...base, userTurns: 6 }));
  assert.equal(reflectionReason({ ...base, userTurns: 7 }), null);
  assert.deepEqual(parseProposal('```json\n{"action":"none"}\n```'), { action: "none" });
  assert.equal(parseProposal("no json here"), null);
  console.log("PASS signals: feedback, replay, recovery, tool-heavy and periodic review; tolerant JSON reading");

  const conv = services.store.createConversation("fixture");
  const reflection = services.runtime.reflection;
  const reflect = (reply: string) => {
    replies.push(reply);
    return reflection.reflect({ conversationId: conv.id, runId: "run_fixture", modelId: "fixture", reason: "the person left feedback on a reply", messages: [
      { role: "user", content: [{ type: "text", text: "Recommend a film." }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "A long answer." }], timestamp: 2 },
    ] as never });
  };

  // Proposals that could not be applied as written are not kept.
  assert.equal(await reflect('{"action":"none"}'), null);
  assert.equal(await reflect('{"action":"memory","key":"bad key!","value":"x","summary":"s"}'), null);
  assert.equal(await reflect('{"action":"skill_new","name":"Bad Name","description":"d","body":"b","summary":"s"}'), null);
  assert.equal(await reflect('{"action":"skill_patch","skill":"missing","old":"a","new":"b","summary":"s"}'), null);
  assert.equal(reflection.list(conv.id).length, 0);
  assert.ok(prompts.at(-1)!.includes("Recommend a film."), "the exchange reaches the reviewer");
  console.log("PASS invalid proposals are discarded before anything is stored");

  // Memory: pending until accepted; accepting saves through the budgeted path.
  const memory = await reflect('{"action":"memory","key":"answer_length","value":"Keep recommendations to three short points.","summary":"Short recommendations"}');
  assert.ok(memory && memory.status === "pending" && memory.kind === "memory");
  assert.equal(services.store.listMemories().length, 0, "a proposal writes nothing on its own");
  const accepted = reflection.accept(memory.id);
  assert.equal(accepted.status, "accepted");
  assert.equal(services.store.listMemories()[0]?.value, "Keep recommendations to three short points.");
  assert.throws(() => reflection.accept(memory.id), /already handled/);

  // New skill: written with a generated header and marked as learned.
  const created = await reflect('{"action":"skill_new","name":"film-picks","description":"Use when recommending films","body":"Give three picks, one line each.","summary":"Film recommendation style"}');
  assert.ok(created);
  reflection.accept(created.id);
  const skill = managedSkills(workspace).items.find(item => item.name === "film-picks");
  assert.ok(skill?.learned && skill.content.includes("Give three picks"));
  assert.ok(learningHistory()[0]!.reason.includes("Film recommendation style"));

  // Patch: applies to the revision it was proposed against, never a newer one.
  const patch = await reflect('{"action":"skill_patch","skill":"film-picks","old":"one line each","new":"one line each, with the year","summary":"Add the year"}');
  assert.ok(patch);
  reflection.accept(patch.id);
  assert.ok(managedSkills(workspace).items.find(item => item.name === "film-picks")!.content.includes("with the year"));
  const stale = await reflect('{"action":"skill_patch","skill":"film-picks","old":"with the year","new":"with the year and director","summary":"Add the director"}');
  assert.ok(stale);
  const current = managedSkills(workspace).items.find(item => item.name === "film-picks")!;
  fs.writeFileSync(current.filePath, current.content + "\nEdited by hand.\n");
  assert.throws(() => reflection.accept(stale.id), /修改过/);

  // Skill proposal kept as a one-line memory instead.
  const asMemory = await reflect('{"action":"skill_new","name":"tone-guide","description":"Use for tone","body":"Be warm.","summary":"Warm tone"}');
  assert.ok(asMemory);
  reflection.accept(asMemory.id, "memory");
  assert.ok(services.store.listMemories().some(item => item.key === "tone_guide" && item.value === "Warm tone"));
  assert.ok(!managedSkills(workspace).items.some(item => item.name === "tone-guide"));

  // A patch aimed at a memory key becomes a refinement of that memory.
  const refined = await reflect('{"action":"skill_patch","skill":"answer_length","old":"three","new":"Keep recommendations to two short points.","summary":"Even shorter"}');
  assert.ok(refined && refined.kind === "memory" && refined.payload.key === "answer_length");
  reflection.accept(refined.id);
  assert.equal(services.store.listMemories().find(item => item.key === "answer_length")?.value, "Keep recommendations to two short points.");

  // A mod: validated before it is stored, written as learned on accept.
  assert.equal(await reflect('{"action":"mod","manifest":{"name":"Bad Name","title":"x","contributes":{"starters":[{"label":"a","prompt":"b"}]}},"summary":"s"}'), null);
  const modProposal = await reflect('{"action":"mod","manifest":{"name":"translate-button","title":"Translate","description":"","contributes":{"messageActions":[{"label":"English","prompt":"Translate: {excerpt}"}]}},"summary":"A translate button"}');
  assert.ok(modProposal && modProposal.kind === "mod");
  assert.ok(!listMods().items.some(mod => mod.name === "translate-button"), "a mod proposal writes nothing on its own");
  reflection.accept(modProposal.id);
  const learnedMod = listMods().items.find(mod => mod.name === "translate-button");
  assert.ok(learnedMod?.origin === "learned" && learnedMod.contributes.messageActions?.[0]?.label === "English");
  assert.equal(learningHistory()[0]!.kind, "mod");
  assert.ok(prompts.at(-1)!.includes("Existing mods"), "the reviewer sees existing mods");

  // Dismissed: nothing written, and the reviewer is told not to repeat it.
  const dismissed = await reflect('{"action":"memory","key":"emoji","value":"Likes emoji.","summary":"Likes emoji"}');
  assert.ok(dismissed);
  assert.equal(reflection.dismiss(dismissed.id).status, "dismissed");
  assert.ok(!services.store.listMemories().some(item => item.key === "emoji"));
  await reflect('{"action":"none"}');
  assert.ok(prompts.at(-1)!.includes("Likes emoji"), "earlier proposals are listed so they are not proposed again");
  console.log("PASS accept writes memory or skills through the ordinary paths; stale patches and dismissals write nothing");

  const app = createApp(services);
  assert.equal((await app.request(`/v1/conversations/${conv.id}/learning-proposals`)).status, 401);
  console.log("PASS proposal routes require authentication");
} finally {
  await services.close(); await stub.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
