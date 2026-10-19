// Build a node release:
//   dist/releases/<version>/node.mjs        the node program, one ESM bundle (esbuild), no dependencies
//   dist/releases/<version>/rocketsim.wasm  the exact wasm the web client runs
//   dist/releases/<version>/manifest.json   version, protocol, wasm hash, files with sha256 + size
//   dist/releases/<version>/manifest.sig    Ed25519 over manifest.json (release key), base64url
//   dist/releases/launcher.mjs (+ .sig)     the launcher install.sh installs once
//   dist/releases/install.sh                install script with the release public key filled in
//
//   node scripts/build-node.mjs [--sign .keys/release.json]
// Without --sign the release is built but unsigned (launchers refuse it). The private key file comes
// from scripts/keys.mjs; in CI it is a secret (TGN_RELEASE_PRIVATE_KEY).
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash, createPrivateKey, sign as edSign } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRepoRoot } from './repo-root.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = findRepoRoot(root);
const require = createRequire(import.meta.url);
const esbuild = require(join(repo, 'server', 'node_modules', 'esbuild'));

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const versionTs = await readFile(join(root, 'node', 'version.ts'), 'utf8');
const version = /NODE_VERSION = '([^']+)'/.exec(versionTs)?.[1];
if (version !== pkg.version) throw new Error(`node/version.ts (${version}) and package.json (${pkg.version}) differ`);
const protocolTs = await readFile(join(repo, 'src', 'net', 'protocol.ts'), 'utf8');
const protocol = Number(/PROTOCOL_VERSION = (\d+)/.exec(protocolTs)?.[1]);

const out = join(root, 'dist', 'releases');
const rel = join(out, version);
await mkdir(rel, { recursive: true });

// CommonJS dependencies (werift's) call require('tty') & co.: give the ESM bundle a real `require`.
const banner = { js: "import { createRequire as __tgnCreateRequire } from 'node:module'; const require = __tgnCreateRequire(import.meta.url);" };
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node24', legalComments: 'inline', logLevel: 'warning', banner };
await esbuild.build({ ...common, entryPoints: [join(root, 'node', 'main.ts')], outfile: join(rel, 'node.mjs') });
await esbuild.build({ ...common, entryPoints: [join(root, 'node', 'launcherMain.ts')], outfile: join(out, 'launcher.mjs') });
await copyFile(join(repo, 'src', 'sim', 'wasm', 'rocketsim.wasm'), join(rel, 'rocketsim.wasm'));

const sha = (b) => createHash('sha256').update(b).digest('hex');
const files = [];
for (const path of ['node.mjs', 'rocketsim.wasm']) {
  const b = await readFile(join(rel, path));
  files.push({ path, sha256: sha(b), size: b.length });
}
const manifest = {
  name: 'turbogol-node',
  version,
  protocol,
  wasmSha256: files.find((f) => f.path === 'rocketsim.wasm').sha256,
  nodeMajor: 24,
  entry: 'node.mjs',
  createdAt: new Date().toISOString(),
  files,
};
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
await writeFile(join(rel, 'manifest.json'), manifestBytes);

// Signing (Ed25519, PKCS#8 base64url from scripts/keys.mjs).
const i = process.argv.indexOf('--sign');
const keyText = i > 0 ? JSON.parse(await readFile(process.argv[i + 1], 'utf8')).privateKey : process.env.TGN_RELEASE_PRIVATE_KEY;
let publicKey = null;
if (keyText) {
  const key = createPrivateKey({ key: Buffer.from(keyText, 'base64url'), format: 'der', type: 'pkcs8' });
  const b64u = (buf) => Buffer.from(buf).toString('base64url');
  await writeFile(join(rel, 'manifest.sig'), b64u(edSign(null, manifestBytes, key)));
  const launcher = await readFile(join(out, 'launcher.mjs'));
  await writeFile(join(out, 'launcher.mjs.sig'), b64u(edSign(null, launcher, key)));
  // The public half, raw (32 bytes) and PEM, for install.sh.
  const der = (await import('node:crypto')).createPublicKey(key).export({ format: 'der', type: 'spki' });
  publicKey = { raw: b64u(der.subarray(der.length - 32)), pem: (await import('node:crypto')).createPublicKey(key).export({ format: 'pem', type: 'spki' }).toString() };
  await writeFile(join(rel, 'release-key.pub'), publicKey.raw);
}

// Installers: VPS (install.sh), Windows home PCs, macOS / Linux desktops. The release key is baked
// in; an installer still carrying the placeholders refuses to run.
for (const name of ['install.sh', 'install-windows.ps1', 'install-desktop.sh']) {
  let tpl;
  try {
    tpl = await readFile(join(root, 'install', name), 'utf8');
  } catch {
    console.warn(`  (no install/${name} yet)`);
    continue;
  }
  const filled = publicKey ? tpl.split('__RELEASE_PUBLIC_KEY_B64URL__').join(publicKey.raw).split('__RELEASE_PUBLIC_KEY_PEM__').join(publicKey.pem.trim()) : tpl;
  await writeFile(join(out, name), filled);
}
await writeFile(join(out, 'channel.json'), JSON.stringify({ stable: version, minimum: version }, null, 2));

console.log(`release ${version} (protocol ${protocol}, wasm ${manifest.wasmSha256.slice(0, 12)}) -> ${rel}${keyText ? ' (signed)' : ' (UNSIGNED: launchers will refuse it)'}`);
for (const f of files) console.log(`  ${f.path}  ${(f.size / 1024).toFixed(0)} KB  ${f.sha256.slice(0, 16)}`);
