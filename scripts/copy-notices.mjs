// Copies the license notices into public/ so every web build ships them next to the game:
//   public/LICENSE.txt               the AGPL-3.0 text (the game's own license)
//   public/third-party-licenses.txt  THIRD_PARTY_NOTICES.md (RocketSim, Bullet, three.js)
// Run by `npm run build` before Vite; both outputs are git-ignored (generated).
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'public'), { recursive: true });
copyFileSync(join(root, 'LICENSE'), join(root, 'public', 'LICENSE.txt'));
copyFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(root, 'public', 'third-party-licenses.txt'));
console.log('notices copied to public/');
