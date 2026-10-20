// Generate the two project keys (Ed25519) into nodes/.keys/ (git-ignored by nodes/.gitignore; keep a
// copy in a password manager, never commit it):
//   control.json  signs match tickets. Production: Worker secret NODE_CONTROL_PRIVATE_KEY.
//   release.json  signs node releases. Keep it OFF the server (CI secret or an offline machine):
//                 whoever holds it can push code to every community node.
// Prints only the PUBLIC halves. Refuses to overwrite existing keys.
import { mkdir, writeFile, access, chmod } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '.keys');
await mkdir(dir, { recursive: true });
for (const name of ['control', 'release']) {
  const file = join(dir, `${name}.json`);
  try {
    await access(file);
    // Say it plainly: a kept key is not a new key, and the production keys must be new ones.
    console.log(`${name}: ${file} exists, kept: NOT a new key (move .keys/ away first for new ones)`);
    continue;
  } catch {
    /* create */
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pub = Buffer.from(spki.subarray(spki.length - 32)).toString('base64url');
  const priv = Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' })).toString('base64url');
  await writeFile(file, JSON.stringify({ publicKey: pub, privateKey: priv }, null, 2));
  await chmod(file, 0o600).catch(() => undefined);
  console.log(`${name}: public key ${pub}`);
  console.log(publicKey.export({ format: 'pem', type: 'spki' }).toString().trim());
}
