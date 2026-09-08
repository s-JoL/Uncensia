import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../src/server/store/db.ts';
import { Store } from '../src/server/store/store.ts';
import { VectorIndex } from '../src/server/rag/vectors.ts';
import { fileSearchTool } from '../src/server/tools/file-search.ts';
import type { Retrieval } from '../src/server/rag/retrieval.ts';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uncensia-retrieval-'));
const db = new Db(path.join(directory, 'uncensia.sqlite'));
const store = new Store(db);
for (let i = 0; i < 230; i++) {
  const id = `file_${i}`;
  store.addFile({ id, name: `${i}.txt`, mime: 'text/plain', bytes: 1, diskPath: path.join(directory, `${i}.txt`), sha256: id });
  store.replaceChunks(id, [{ idx: 0, text: `共同关键词 中文章节 ${i}`, page: 1 }]);
  store.replaceEmbeddings(id, 'test', [{ chunkId: `${id}:chunk:0`, vector: new Float32Array(i === 229 ? [0,1] : [1,0]) }]);
}
assert.equal(store.keywordChunks('共同关键词', 1, ['file_229'])[0]?.fileId, 'file_229');
console.log('PASS keyword scope is applied before ranking and LIMIT');
const search = fileSearchTool({ searchFiles: async () => ({
  index: { ready: 1 }, results: [{ id: 'file_229', name: '229.txt', excerpt: 'Known passage', retrievalScore: 1 }],
}) } as unknown as Retrieval, 'keyword');
const result = await search.execute('identity', { intent: 'Read the selected notes', query: 'notes' });
assert(result.content.some(part => part.type === 'text' && part.text.includes('file_id: file_229')),
  'file identity must reach model content, not just client-only details');
console.log('PASS retrieved resource identity is available for subsequent scoped calls');
const vectors = new VectorIndex(store);
assert.equal((await vectors.search('test', new Float32Array([1,0]), 1, ['file_229']))[0]?.fileId, 'file_229');
console.log('PASS LanceDB prefilter finds a scoped document outside global top 200');
assert.equal((await vectors.search('test', new Float32Array([0,1]), 1))[0]?.fileId, 'file_229');
store.deleteFile('file_229');
assert.equal((await vectors.search('test', new Float32Array([0,1]), 1, ['file_229'])).length, 0);
console.log('PASS deleting a document invalidates the vector index');
await assert.rejects(vectors.search('test', new Float32Array([1,0,0]), 1), /dimension changed/);
console.log('PASS changed embedding dimensions fail explicitly');
db.close();
