import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import http from "node:http";
import { mock } from "node:test";
import { startOpenAiStub } from "./stub-openai.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uncensia-resources-"));
process.env.UNCENSIA_DATA_DIR = dir;
process.env.UNCENSIA_ACCESS_CODE = "RESOURCEAUDITCODE";
process.env.UNCENSIA_MAX_UPLOAD_BYTES = "4096";
const { createServices } = await import("../src/server/services.ts");
const { ingestFile } = await import("../src/server/library.ts");
const { acquireResource, readResource, quoteResource, getQuote, saveFeedback, deliverable } = await import("../src/server/resources.ts");
const { checkPublicAddress, downloadResource } = await import("../src/server/resource-download.ts");
const services = createServices();
let stub: Awaited<ReturnType<typeof startOpenAiStub>> | undefined;
try {
  const conv = services.store.createConversation("fixture", "Resources");
  const original = "alpha\n中文\ngamma\n";
  const { file } = ingestFile(services.store, { name: "novel.txt", bytes: Buffer.from(original), conversationId: conv.id });
  const read = await readResource(services.store, conv.id, { file_id: file.id, start_line: 2, end_line: 2 });
  assert.equal(read.text, "中文");
  assert.equal(read.total_lines, 4);
  const fullQuote = await quoteResource(services.store, conv.id, { file_id: file.id });
  assert.notEqual(fullQuote.file_id, file.id, "a complete quote must not lock the original document");
  assert.equal((await quoteResource(services.store, conv.id, { file_id: file.id })).file_id, fullQuote.file_id, "retries reuse the same immutable snapshot");
  assert.equal((await quoteResource(services.store, conv.id, { end_line: 4, start_line: 1, file_id: file.id })).file_id, fullQuote.file_id, "equivalent selectors reuse the same snapshot");
  const quote = await quoteResource(services.store, conv.id, { file_id: file.id, start_line: 2, end_line: 3 });
  assert.equal(getQuote(services.store, quote.id)?.text, "中文\ngamma");
  assert.equal((await readResource(services.store, conv.id, { quote_id: quote.id })).text, "中文\ngamma");
  assert.notEqual(ingestFile(services.store, { name: "editable.txt", bytes: Buffer.from("中文\ngamma") }).file.id, quote.file_id, "an upload must not reuse a frozen quote");
  fs.writeFileSync(file.diskPath, "changed");
  assert.equal(getQuote(services.store, quote.id)?.text, "中文\ngamma", "old quotes retain original bytes");
  await assert.rejects(() => readResource(services.store, conv.id, { file_id: file.id, start_line: 0 }), /line/i);
  await assert.rejects(() => readResource(services.store, conv.id, { file_id: file.id, start_line: 0, paragraph_count: 1 }), /line/i);
  await assert.rejects(() => readResource(services.store, conv.id, { file_id: "file_missing" }), /not found/i);
  const gbk = ingestFile(services.store, { name: "encoded.txt", bytes: Buffer.from([0xd6, 0xd0, 0xce, 0xc4]) }).file;
  assert.equal((await readResource(services.store, conv.id, { file_id: gbk.id, encoding: "gb18030" })).text, "中文");
  await assert.rejects(() => readResource(services.store, conv.id, { file_id: gbk.id }), /encoding|text/i);
  const docx = new JSZip();
  docx.file("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  docx.file("_rels/.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  docx.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX original text</w:t></w:r></w:p></w:body></w:document>');
  const docxFile = ingestFile(services.store, { name: "original.docx", bytes: await docx.generateAsync({ type: "nodebuffer" }) }).file;
  assert.equal((await readResource(services.store, conv.id, { file_id: docxFile.id })).text, "DOCX original text");
  const stream = "BT /F1 12 Tf 72 700 Td (PDF original text) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const pdfFile = ingestFile(services.store, { name: "original.pdf", bytes: Buffer.from(pdf) }).file;
  assert.equal((await readResource(services.store, conv.id, { file_id: pdfFile.id })).text, "PDF original text");
  const binary = ingestFile(services.store, { name: "binary.bin", bytes: Buffer.from([0xff, 0x00, 0xfd]) }).file;
  await assert.rejects(() => readResource(services.store, conv.id, { file_id: binary.id }), /No readable text/);
  for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "::ffff:127.0.0.1", "fc00::1"]) assert.throws(() => checkPublicAddress(address), /public/i);
  checkPublicAddress("8.8.8.8");
  await assert.rejects(() => downloadResource("http://127.0.0.1/secret"), /public/i);
  await assert.rejects(() => downloadResource("file:///etc/passwd"), /HTTP/i);
  assert.throws(() => saveFeedback(services.store, conv.id, "missing", "wrong reference"), /not found/i);
  assert.throws(() => deliverable(services.store, conv.id, { key: "1", status: "produced", asset_id: "img_missing", description: "one" }), /not found/i);
  const item = deliverable(services.store, conv.id, { key: "1", status: "produced", asset_id: quote.id, description: "one" });
  assert.equal(item.asset_id, quote.file_id);
  assert.equal(item.key, "1");
  assert.throws(() => deliverable(services.store, conv.id, { ...item, key: "2" }), /twice/);
  const fixture = http.createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "http://public.test/text" }); res.end(); }
    else if (req.url === "/private") { res.writeHead(302, { location: "http://127.0.0.1/secret" }); res.end(); }
    else if (req.url === "/large") { res.writeHead(200, { "content-length": "9000" }); res.end(); }
    else if (req.url === "/chunked") { res.writeHead(200); res.write("a".repeat(3000)); res.end("b".repeat(3000)); }
    else if (req.url === "/404") { res.writeHead(404); res.end("not found"); }
    else if (req.url === "/fake.png") { res.writeHead(200, { "content-type": "image/png" }); res.end("not an image"); }
    else if (req.url === "/login.txt") { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>login</html>"); }
    else { res.writeHead(200, { "content-type": "text/plain" }); res.end("original bytes"); }
  });
  await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const port = (fixture.address() as { port: number }).port;
  const actualGet = http.get;
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ Status: 0, Answer: [{ type: 1, data: "8.8.8.8" }] })));
  const getMock = mock.method(http, "get", ((url: URL, options: http.RequestOptions, callback: (r: http.IncomingMessage) => void) => actualGet(new URL(url.pathname, `http://127.0.0.1:${port}`), { ...options, lookup: undefined }, callback)) as typeof http.get);
  try {
    const dns = "https://resolver.test/query";
    assert.equal((await downloadResource("http://public.test/redirect", undefined, dns)).bytes.toString(), "original bytes");
    for (const [route, expected] of [["private", /public/], ["large", /size/], ["chunked", /size/], ["404", /404/]] as const) await assert.rejects(() => downloadResource(`http://public.test/${route}`, undefined, dns), expected);
    const before = services.store.listFiles().total;
    await assert.rejects(() => acquireResource(services.store, { url: "http://public.test/fake.png" }, undefined, undefined, dns));
    await assert.rejects(() => acquireResource(services.store, { url: "http://public.test/login.txt" }, undefined, undefined, dns), /HTML/);
    await assert.rejects(() => acquireResource(services.store, { url: "http://public.test/text" }, undefined, undefined, dns, () => { throw new Error("access revoked"); }), /revoked/);
    assert.equal(services.store.listFiles().total, before, "invalid downloads must not enter the library");
  } finally { fetchMock.mock.restore(); getMock.mock.restore(); await new Promise<void>(resolve => fixture.close(() => resolve())); }
  const zip = new JSZip();
  zip.file("META-INF/container.xml", '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book/content.opf"/></rootfiles></container>');
  zip.file("book/content.opf", '<package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="two"/><itemref idref="one"/></spine></package>');
  zip.file("book/one.xhtml", '<html><body><p>First chapter</p></body></html>');
  zip.file("book/two.xhtml", '<html><body><p>Second chapter</p></body></html>');
  const epub = ingestFile(services.store, { name: "book.epub", bytes: await zip.generateAsync({ type: "nodebuffer" }) }).file;
  assert.equal((await readResource(services.store, conv.id, { file_id: epub.id })).text, "Second chapter\n\nFirst chapter");
  await services.retrieval.indexFile(epub);
  assert.ok((await services.retrieval.searchFiles("Second chapter", "keyword", 10, [epub.id])).results.length);
  const exact = await readResource(services.store, conv.id, { file_id: epub.id, find_text: "First chapter" });
  assert.equal(exact.start_line, 3);
  await assert.rejects(() => quoteResource(services.store, conv.id, { file_id: epub.id, version: "stale-version" }), /changed/);

  stub = await startOpenAiStub(0, body => {
    const last = body.messages?.findLastIndex(m => m.role === "user") ?? 0;
    const returned = body.messages?.slice(last + 1).find(m => m.role === "tool");
    return returned ? { kind: "text", text: "[Original](excerpt://" + quote.id + ")" } : { kind: "tool", name: "quote_resource", args: { file_id: epub.id, start_line: 1, end_line: 1 } };
  });
  services.store.upsertProvider({ id: "fixture", name: "fixture", baseUrl: stub.url + "/v1", auth: { style: "none" }, enabled: true });
  services.store.upsertModel({ id: "fixture", providerId: "fixture", model: "fixture", name: "fixture", apiMode: "openai-chat", kind: "chat", enabled: true, reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1000, thinkingLevel: "off" });
  services.reload();
  const run = services.store.createRun(conv.id, "fixture");
  await services.runtime.start(run.id, conv.id, { message: "Show an original excerpt.", modelId: "fixture" });
  assert.equal(services.store.getRun(run.id)?.status, "completed");
  const toolResult = services.store.storedMessages(conv.id).find(row => row.role === "toolResult")!;
  const output = JSON.stringify(toolResult.content);
  assert.ok(output.includes("excerpt://quote_"));
  assert.ok(!output.includes('"numbered_lines"'), "quotation must return a reference and bounded previews, not a second full read");
  const p = ingestFile(services.store, { name: "paragraphs.txt", bytes: Buffer.from("Heading\n\nFirst prose\nwrapped line\n\nSecond prose") }).file;
  assert.equal((await readResource(services.store, conv.id, { file_id: p.id, find_text: "First prose", paragraph_count: 1 })).text, "First prose\nwrapped line");
  const entryId = services.store.messageEntryId(conv.id, toolResult.seq)!;
  assert.ok((await readResource(services.store, conv.id, { entry_id: entryId })).text.includes("excerpt://"));
  saveFeedback(services.store, conv.id, entryId, "Check the chosen chapter");
  assert.equal(services.store.db.all("SELECT * FROM message_feedback").length, 1);
  const imageId = "img_" + "a".repeat(32), parentId = "img_" + "b".repeat(32);
  services.store.registerImageAsset({ image_id: imageId, mime_type: "image/jpeg", width: 1200, height: 800, provider: "fixture", model: "editor", parent_image_ids: [parentId] });
  services.store.registerImageAsset({ image_id: imageId, mime_type: "image/jpeg" });
  const inspected = services.store.getImageAsset(imageId)!;
  assert.equal(inspected.provider, "fixture"); assert.equal(inspected.width, 1200); assert.deepEqual(inspected.parentImageIds, [parentId]);
  const other = services.store.createConversation("fixture", "Other");
  await assert.rejects(() => readResource(services.store, other.id, { entry_id: entryId }), /not found/);
  services.store.replaceMessages(other.id, [{ entryId: "dated", message: { role: "assistant", content: [{ type: "text", text: "Earlier answer" }], timestamp: 1234567890 } }]);
  assert.equal(services.store.storedMessages(other.id)[0]?.createdAt, 1234567890, "rebuilding a transcript keeps the original message date");
  const { createApp } = await import("../src/server/http/app.ts");
  const app = createApp(services);
  assert.equal((await app.request(`/v1/resources/quotes/${quote.id}`)).status, 401);
  const login = await app.request("/v1/auth/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accessCode: "RESOURCEAUDITCODE" }) });
  const { token } = await login.json() as { token: string };
  assert.ok(token);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  assert.equal((await app.request(`/v1/files/${quote.file_id}/text`, { method: "PUT", headers, body: JSON.stringify({ text: "changed" }) })).status, 409);
  assert.equal(await (await app.request(`/v1/files/${quote.file_id}/content`, { headers })).text(), "中文\ngamma");
  console.log("PASS resources: exact ranges, immutable quote, explicit encoding, missing sources, public-address validation, evidence-backed deliverables");
  console.log("PASS EPUB spine order and indexing; real Pi tool-reference round trip, message source and persisted feedback");
} finally {
  await stub?.close();
  await services.close();
  assert.equal(path.dirname(dir), os.tmpdir());
  assert.ok(path.basename(dir).startsWith("uncensia-resources-"));
  fs.rmSync(dir, { recursive: true, force: true });
}
