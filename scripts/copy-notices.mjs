// Copies the license notices into public/ so every web build ships them next to the game:
//   public/LICENSE.txt               the AGPL-3.0 text (the game's own license)
//   public/third-party-licenses.txt  THIRD_PARTY_NOTICES.md (RocketSim, Bullet, three.js, Emscripten,
//                                    the display font's OFL...)
// Run by `npm run build` before Vite; both outputs are git-ignored (generated). The display font
// (public/fonts/*.woff2, committed) ships next to its own license, public/fonts/OFL.txt: a build
// with a font and no license next to it, or a font the notices do not name, stops here.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'public'), { recursive: true });
copyFileSync(join(root, 'LICENSE'), join(root, 'public', 'LICENSE.txt'));
copyFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(root, 'public', 'third-party-licenses.txt'));
const fontDir = join(root, 'public', 'fonts');
const fonts = existsSync(fontDir) ? readdirSync(fontDir).filter((f) => f.endsWith('.woff2')) : [];
if (fonts.length > 0) {
  if (!existsSync(join(fontDir, 'OFL.txt'))) throw new Error('public/fonts: a font without its license (OFL.txt)');
  if (!readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8').includes('SIL Open Font License')) throw new Error('THIRD_PARTY_NOTICES.md does not list the font');
}
console.log('notices copied to public/');
