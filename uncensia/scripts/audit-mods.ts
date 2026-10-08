/**
 * Mods: the shipped mod installs, manifests are validated before anything is
 * written, replacing needs the current revision, the switch survives an
 * upgrade, and the assistant's manage_mod writes history and tells clients.
 *
 *   node --import tsx scripts/audit-mods.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uncensia-mods-"));
process.env.UNCENSIA_DATA_DIR = dir;
process.env.UNCENSIA_ACCESS_CODE = "MODSAUDITCODE";
const { createServices } = await import("../src/server/services.ts");
const { listMods, readMod, saveMod, setModEnabled, deleteMod, validateMod } = await import("../src/server/mods.ts");
const { learningTools, learningHistory } = await import("../src/server/tools/learning.ts");
const { seed } = await import("../src/server/store/seed.ts");
const { createApp } = await import("../src/server/http/app.ts");

const services = createServices();
try {
  // The shipped kit installs on first boot and is enabled.
  const shipped = listMods();
  assert.deepEqual(shipped.errors, []);
  const kit = shipped.items.find(mod => mod.name === "creative-kit");
  assert.ok(kit?.enabled && kit.contributes.panels?.some(panel => panel.notes.includes("outline")), "shipped creative kit");

  // Validation names the field and writes nothing.
  const good = { name: "audit-mod", title: "Audit", description: "", contributes: { messageActions: [{ label: "Shorter", prompt: "Shorten: {excerpt}" }] } };
  for (const [bad, field] of [
    [{ ...good, name: "Bad Name" }, /name/],
    [{ ...good, contributes: {} }, /at least one/],
    [{ ...good, contributes: { panels: [{ title: "P", notes: ["Not A Key"] }] } }, /note keys/],
    [{ ...good, contributes: { messageActions: [{ label: "x".repeat(40), prompt: "p" }] } }, /label/],
    [{ ...good, contributes: { script: "alert(1)" } }, /contributes/],
  ] as const) assert.throws(() => validateMod(bad), field);
  assert.equal(listMods().items.some(mod => mod.name === "audit-mod"), false);

  // Replacing needs the revision that was read.
  saveMod(good);
  const first = readMod("audit-mod");
  assert.throws(() => saveMod({ ...good, title: "Stale" }, "not-the-revision"), /changed since/);
  saveMod({ ...good, title: "Audit 2" }, first.revision);
  assert.equal(listMods().items.find(mod => mod.name === "audit-mod")?.title, "Audit 2");

  // The owner's switch survives the package re-installing its files.
  setModEnabled("creative-kit", false);
  seed(services.store, services.config, services.vault);
  assert.equal(listMods().items.find(mod => mod.name === "creative-kit")?.enabled, false);
  setModEnabled("creative-kit", true);

  // Removal moves the folder aside, and the package does not bring it back.
  deleteMod("creative-kit");
  seed(services.store, services.config, services.vault);
  assert.ok(!listMods().items.some(mod => mod.name === "creative-kit"));
  assert.ok(fs.readdirSync(path.join(dir, "mod-trash")).some(name => name.startsWith("creative-kit-")));
  console.log("PASS mods: shipped kit, validation before writing, revision conflict, switch kept across upgrade, recoverable removal");

  // The assistant's tool: creates as learned, records history, tells clients.
  const conv = services.store.createConversation("fixture");
  let notified = 0;
  const tool = () => learningTools(services.config, services.store, conv.id, undefined, () => { notified++; }).find(item => item.name === "manage_mod")!;
  const call = async (args: object) => JSON.parse(((await tool().execute("audit", args)).content[0] as { text: string }).text);
  await assert.rejects(() => call({ action: "create", manifest: { ...good, name: "translate" } }), /reason/);
  await call({ action: "create", manifest: { ...good, name: "translate", title: "Translate", contributes: { messageActions: [{ label: "English", prompt: "Translate: {excerpt}" }] } }, reason: "The person asked for a translate button" });
  const listed = await call({ action: "list" });
  const translate = listed.items.find((item: { name: string }) => item.name === "translate");
  assert.ok(translate?.learned && notified === 1, "learned mod created and clients told");
  assert.equal(learningHistory()[0]!.kind, "mod");
  await assert.rejects(() => call({ action: "create", manifest: { ...good, name: "translate" }, reason: "again" }), /exists/);
  await call({ action: "update", manifest: { ...good, name: "translate", title: "Translate 2" }, revision: translate.revision, reason: "Rename" });
  await call({ action: "enable", name: "translate", enabled: false, reason: "Not needed today" });
  assert.equal(listMods().items.find(mod => mod.name === "translate")?.enabled, false);
  assert.equal(notified, 3);
  services.config.saveCapabilities({ learning: { ...services.config.capabilities().learning!, skills: false } });
  assert.ok(!learningTools(services.config, services.store, conv.id).some(item => item.name === "manage_mod"), "mods follow the skill-learning permission");
  console.log("PASS manage_mod: learned origin, history, client notification, duplicate and stale protection, permission");

  const app = createApp(services);
  assert.equal((await app.request("/v1/mods")).status, 401);
  console.log("PASS mod routes require authentication");
} finally {
  await services.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
