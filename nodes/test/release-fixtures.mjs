// Throwaway release keys, a sandboxed checkout for scripts/sign-release.mjs and a fake R2 bucket for
// the release tests. The signing script takes its public key only from <its nodes/>/release-key.pub,
// with no override, and checks the build against its own checkout, so the tests run the real script
// from a copy whose release-key.pub is a throwaway key.
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUCKET } from '../scripts/channel.mjs';
import { INSTALLERS } from '../scripts/release-check.mjs';
import { fillInstaller } from '../scripts/release-key.mjs';

const nodes = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** A fresh Ed25519 pair: { raw (public, base64url), pkcs8 (private, base64url, as keys.mjs writes it) }. */
export function throwawayKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { raw: publicKey.export({ format: 'jwk' }).x, pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url') };
}

/** { raw, pem } of a raw public key, as the installers carry it. */
export function publicKeyOf(raw) {
  return { raw, pem: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' }).export({ format: 'pem', type: 'spki' }).toString().trim() };
}

/** A temporary directory removed after the test. */
export function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A checkout as the sign and upload jobs see it: <repo>/nodes/ with the release scripts, the real
 * installer templates, a package.json at `version` and `raw` as release-key.pub, next to the real
 * src/sim/wasm/rocketsim.wasm and src/net/protocol.ts. Returns its nodes/ folder.
 */
export function signerRoot(t, raw, version) {
  const repo = tempDir(t, 'tgn-signer-');
  const root = join(repo, 'nodes');
  const copy = (from, to) => {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  };
  for (const f of ['sign-release.mjs', 'release-key.mjs', 'release-check.mjs']) copy(join(nodes, 'scripts', f), join(root, 'scripts', f));
  for (const name of INSTALLERS) copy(join(nodes, 'install', name), join(root, 'install', name));
  for (const f of [['sim', 'wasm', 'rocketsim.wasm'], ['net', 'protocol.ts']]) copy(join(nodes, '..', 'src', ...f), join(repo, 'src', ...f));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'turbogol-community-nodes', version, type: 'module' }));
  writeFileSync(join(root, 'release-key.pub'), `${raw}\n`);
  return root;
}

/**
 * An unsigned production build of the checkout `root` (a signerRoot) as build-node.mjs lays it out,
 * small enough to write by hand, with its installers filled with `raw`: { out, rel, version }.
 */
export function fakeBuild(t, root, raw, { commit = 'f00d'.padEnd(40, '1') } = {}) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const out = tempDir(t, 'tgn-dist-');
  const rel = join(out, version);
  mkdirSync(rel);
  const wasm = readFileSync(join(root, '..', 'src', 'sim', 'wasm', 'rocketsim.wasm'));
  const protocol = Number(/PROTOCOL_VERSION = (\d+)/.exec(readFileSync(join(root, '..', 'src', 'net', 'protocol.ts'), 'utf8'))[1]);
  const files = [];
  for (const [path, bytes] of [['node.mjs', Buffer.from('console.log("node")')], ['rocketsim.wasm', wasm]]) {
    writeFileSync(join(rel, path), bytes);
    files.push({ path, sha256: sha(bytes), size: bytes.length });
  }
  const inputs = Buffer.from(JSON.stringify({ version, files: ['nodes/node/main.ts'] }));
  writeFileSync(join(rel, 'inputs.json'), inputs);
  const manifest = { name: 'turbogol-node', version, protocol, wasmSha256: files[1].sha256, nodeMajor: 24, entry: 'node.mjs', createdAt: '2026-10-19T00:00:00Z', ...(commit ? { commit } : {}), inputsSha256: sha(inputs), files };
  writeFileSync(join(rel, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(out, 'launcher.mjs'), 'console.log("launcher")');
  for (const name of INSTALLERS) writeFileSync(join(out, name), fillInstaller(readFileSync(join(root, 'install', name), 'utf8'), publicKeyOf(raw)));
  return { out, rel, version };
}

/** Run a signing script; `env` replaces the release variables of this process (CI sets GITHUB_SHA). */
export function runSign(root, args, env = {}) {
  const base = { ...process.env };
  delete base.TGN_RELEASE_PRIVATE_KEY;
  delete base.GITHUB_SHA;
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'sign-release.mjs'), ...args], { env: { ...base, ...env }, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/**
 * Wrangler's `r2 object get|put <bucket>/<key> --file <f> ... --remote` over a Map, for
 * wranglerR2({ run }) of scripts/channel.mjs. A put of a key for which `failPut(key)` is true fails
 * like an API error. Every call lands in `calls`, every write in `puts` ("<key> <content type>").
 */
export function fakeBucket(store, { failPut = () => false } = {}) {
  const calls = [];
  const puts = [];
  const run = (args) => {
    calls.push(args);
    const [, , op, path] = args;
    const key = path.slice(BUCKET.length + 1);
    const file = args[args.indexOf('--file') + 1];
    if (op === 'get') {
      if (!store.has(key)) return { status: 1, stdout: '', stderr: '[ERROR] The specified key does not exist.\n' };
      writeFileSync(file, store.get(key));
      return { status: 0, stdout: 'Download complete.\n', stderr: '' };
    }
    if (failPut(key)) return { status: 1, stdout: '', stderr: '[ERROR] A request to the Cloudflare API failed. Internal error [code: 10001]\n' };
    store.set(key, readFileSync(file));
    puts.push(`${key} ${args[args.indexOf('--content-type') + 1]}`);
    return { status: 0, stdout: 'Upload complete.\n', stderr: '' };
  };
  return { run, calls, puts };
}
