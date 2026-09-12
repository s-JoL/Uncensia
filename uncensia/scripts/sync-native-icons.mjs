/** Export the installed WebUI Lucide version to iOS template vector assets. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import sharp from 'sharp';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const assets = path.join(root, 'native-ios/Resources/Icons.xcassets');
const packageRoot = path.dirname(require.resolve('lucide-react/package.json'));
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
for (const folder of fs.readdirSync(assets).filter(name => name.startsWith('lucide-') && name.endsWith('.imageset'))) {
  const name = folder.slice(7, -9);
  const { __iconNode } = await import(path.join(packageRoot, 'dist/esm/icons', `${name}.mjs`));
  const nodes = __iconNode.map(([tag, attributes]) => `<${tag} ${Object.entries(attributes).filter(([key]) => key !== 'key').map(([key, value]) => `${key}="${escape(value)}"`).join(' ')}/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${nodes}</svg>`;
  fs.writeFileSync(path.join(assets, folder, 'icon.svg'), svg);
}
fs.copyFileSync(path.join(packageRoot, 'LICENSE'), path.join(root, 'native-ios/Resources/Lucide-LICENSE.txt'));
await sharp(path.join(root, 'src/web/assets/uncensia.svg')).resize(1024, 1024).png().toFile(path.join(assets, 'AppIcon.appiconset/AppIcon.png'));
console.log('iOS vectors and app icon synchronized with WebUI sources.');
