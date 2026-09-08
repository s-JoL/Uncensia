import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uncensia-release-'));
process.env.UNCENSIA_DATA_DIR = dir;
for (const key of ['OPENROUTER_API_KEY', 'SIRAY_API_KEY', 'EMBEDDING_API_KEY', 'TAVILY_API_KEY']) delete process.env[key];
const { createServices } = await import('../src/server/services.ts');
const { seed } = await import('../src/server/store/seed.ts');
const services = createServices();
try {
  assert.deepEqual(services.store.listMemories(), []);
  const models = services.store.listModels();
  assert.deepEqual(models.filter(m => m.kind === 'chat').map(m => m.model), ['tencent/hy4-preview']);
  assert.equal(models.length, 6);
  assert.ok(models.every(m => m.enabled));
  assert.deepEqual(services.store.listProviders().map(p => p.id).sort(), ['comfy', 'openrouter', 'siray']);
  assert.equal(services.config.defaultModelId(), 'openrouter-tencent-hy4-preview');
  const caps = services.config.capabilities();
  assert.equal(caps.embedding.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(caps.embedding.model, 'qwen/qwen3-embedding-8b');
  assert.equal(caps.embedding.hasKey, false);
  assert.equal(caps.coding.write, true);
  assert.equal(caps.coding.shell, true);
  assert.equal(caps.embedding.chunkOverlap, 150);
  services.store.upsertMemory('fixture', 'User-owned memory', 1);
  services.config.setDefaultModelId('user-choice');
  services.config.saveCapabilities({ coding: { ...caps.coding, write: false, workspace: dir } });
  seed(services.store, services.config, services.vault);
  assert.equal(services.store.listMemories()[0]?.value, 'User-owned memory');
  assert.equal(services.config.defaultModelId(), 'user-choice');
  assert.equal(services.config.capabilities().coding.write, false);
  console.log('PASS release: empty memory, HY4-only chat, enabled AIGC profiles, OpenRouter embedding, portable defaults, existing user settings retained');
} finally {
  await services.close();
  assert.equal(path.dirname(dir), os.tmpdir());
  assert.ok(path.basename(dir).startsWith('uncensia-release-'));
  fs.rmSync(dir, { recursive: true, force: true });
}
