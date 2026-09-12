import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import translations from '../src/web/locales/en.json';
import { language, uiText } from '../src/web/i18n.tsx';
const dictionary: Record<string, string> = translations;
const root = path.resolve('src/web');
let count = 0;
for (const file of fs.readdirSync(root, { recursive: true }).filter(file => /\.tsx?$/.test(String(file)))) {
  const full = path.join(root, String(file));
  const source = ts.createSourceFile(full, fs.readFileSync(full, 'utf8'), ts.ScriptTarget.Latest, true, full.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  function walk(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'uiText' && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      const key = node.arguments[0].text;
      assert.ok(dictionary[key], `${file}: missing English translation for ${key}`);
      const slots = (text: string) => [...text.matchAll(/\{\d+\}/g)].map(m => m[0]).sort();
      assert.deepEqual(slots(dictionary[key]!), slots(key), `Placeholder mismatch: ${key}`);
      count++;
    }
    ts.forEachChild(node, walk);
  }
  walk(source);
}
assert.equal(language(), 'zh-CN');
assert.equal(uiText('对话'), '对话');
let selected = 'en';
const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const savedStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => selected } });
try {
  assert.equal(uiText('对话'), 'Chat');
  assert.equal(uiText('范围 {0} – {1}', ['保留用户内容', 12]), 'Range 保留用户内容 – 12');
  assert.equal(uiText('User-owned text with {0}'), 'User-owned text with {0}');
  selected = 'zh-CN';
  assert.equal(uiText('对话'), '对话');
} finally {
  if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (savedStorage) Object.defineProperty(globalThis, 'localStorage', savedStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
}
const readStrings = (lang: string) => new Map(fs.readFileSync(`native-ios/Resources/${lang}.lproj/Localizable.strings`, 'utf8').trim().split('\n').filter(line => line.trim()).map(line => {
  const match = line.match(/^("(?:\\.|[^"\\])*") = ("(?:\\.|[^"\\])*");$/); assert.ok(match, line);
  return [JSON.parse(match[1]!), JSON.parse(match[2]!)] as [string, string];
}));
const nativeEn = readStrings('en'), nativeZh = readStrings('zh-Hans');
assert.deepEqual([...nativeEn.keys()], [...nativeZh.keys()]);
for (const [key, value] of nativeEn) assert.equal((value.match(/%@/g) ?? []).length, (key.match(/%@/g) ?? []).length, key);
let nativeUses = 0;
for (const file of fs.readdirSync('native-ios', {recursive:true}).filter(file => String(file).endsWith('.swift'))) {
  const source = fs.readFileSync(path.join('native-ios',String(file)),'utf8');
  for (const match of source.matchAll(/uncensiaText\("((?:\\.|[^"\\])*)"/g)) {
    const raw = match[1]!;
    if (raw.includes('\\(')) continue;
    const key = JSON.parse(`"${raw}"`) as string;
    assert.ok(nativeEn.has(key), `${file}: missing native English translation for ${key}`);
    assert.ok(nativeZh.has(key), `${file}: missing native Chinese translation for ${key}`);
    nativeUses++;
  }
}
console.log(`PASS localization: ${count} Web labels, interpolation and language switching; ${nativeEn.size} matching native resource entries covering ${nativeUses} native uses (Xcode runtime validation separate)`);
