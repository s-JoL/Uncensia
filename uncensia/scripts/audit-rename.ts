import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { databaseFile, inheritLegacyEnvironment } from '../src/server/legacy.ts';
import { migrateLegacyStorage } from '../src/web/legacy-storage.ts';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uncensia-rename-'));
const env = { LUMA_PORT: '8099', LUMA_DATA_DIR: dir, UNCENSIA_PORT: '8098' };
inheritLegacyEnvironment(env);
assert.equal(env.UNCENSIA_PORT, '8098');
assert.equal((env as NodeJS.ProcessEnv).UNCENSIA_DATA_DIR, dir);
assert.equal(databaseFile(dir), path.join(dir, 'uncensia.sqlite'));
fs.writeFileSync(path.join(dir, 'luma.sqlite'), '');
assert.equal(databaseFile(dir), path.join(dir, 'luma.sqlite'));
const values = new Map([['luma.language', 'zh'], ['luma.token', 'legacy'], ['uncensia.token', 'current']]);
const storage = { get length() { return values.size; }, key: (i: number) => [...values.keys()][i] ?? null,
  getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } } as Storage;
migrateLegacyStorage(storage);
assert.equal(values.get('uncensia.language'), 'zh');
assert.equal(values.get('uncensia.token'), 'current');
values.delete('uncensia.token');
migrateLegacyStorage(storage);
assert.equal(values.has('uncensia.token'), false, 'logout must not restore the old token');
process.env.UNCENSIA_DATA_DIR = dir;
process.env.UNCENSIA_ACCESS_CODE = 'RENAMEAUDIT2026';
const { createServices } = await import('../src/server/services.ts');
const { createApp } = await import('../src/server/http/app.ts');
const { seed } = await import('../src/server/store/seed.ts');
const services = createServices();
try {
  assert.equal(fs.existsSync(path.join(dir, 'uncensia.sqlite')), false, 'reuse existing database');
  const app = createApp(services);
  const login = await app.request('/v1/auth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessCode: 'RENAMEAUDIT2026' }) });
  assert.equal(login.status, 200);
  const { token } = await login.json() as { token: string };
  assert.ok(login.headers.get('set-cookie')?.includes('uncensia_token='));
  for (const cookie of ['luma_token', 'uncensia_token']) {
    const result = await app.request('/v1/models', { headers: { cookie: `${cookie}=${token}` } });
    assert.equal(result.status, 200, cookie);
  }
  const skillRoot = path.join(dir, 'skills');
  fs.renameSync(path.join(skillRoot, 'improve-uncensia'), path.join(skillRoot, 'improve-luma'));
  const hashes = JSON.parse(services.store.getMeta('skill_hashes')!);
  for (const key of Object.keys(hashes)) if (key.startsWith('improve-uncensia')) { hashes[key.replace('improve-uncensia', 'improve-luma')] = hashes[key]; delete hashes[key]; }
  services.store.setMeta('skill_hashes', JSON.stringify(hashes));
  const file = path.join(skillRoot, 'improve-luma', 'SKILL.md');
  const edited = fs.readFileSync(file, 'utf8') + '\nMy custom procedure.\n';
  fs.writeFileSync(file, edited);
  seed(services.store, services.config, services.vault);
  assert.equal(fs.existsSync(path.join(skillRoot, 'improve-luma')), false);
  assert.equal(fs.readFileSync(path.join(skillRoot, 'improve-uncensia', 'SKILL.md'), 'utf8'), edited);
  console.log('PASS rename: database, environment precedence, saved language, login cookies, logout, edited skill migration');
} finally {
  await services.close();
  assert.equal(path.dirname(dir), os.tmpdir());
  fs.rmSync(dir, { recursive: true, force: true });
}
