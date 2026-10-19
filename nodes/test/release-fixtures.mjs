// Throwaway release keys and a sandboxed copy of scripts/sign-release.mjs for the release tests. The
// signing script takes its public key only from <its nodes/>/release-key.pub, with no override, so the
// tests run the real script from a copy whose release-key.pub is a throwaway key.
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

/** A fresh Ed25519 pair: { raw (public, base64url), pkcs8 (private, base64url, as keys.mjs writes it) }. */
export function throwawayKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { raw: publicKey.export({ format: 'jwk' }).x, pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url') };
}

/** A temporary directory removed after the test. */
export function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A nodes/ folder holding only the signing script, a package.json at `version` and `raw` as release-key.pub. */
export function signerRoot(t, raw, version) {
  const root = tempDir(t, 'tgn-signer-');
  mkdirSync(join(root, 'scripts'));
  for (const f of ['sign-release.mjs', 'release-key.mjs']) copyFileSync(join(scripts, f), join(root, 'scripts', f));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'turbogol-community-nodes', version, type: 'module' }));
  writeFileSync(join(root, 'release-key.pub'), `${raw}\n`);
  return root;
}

/** Run a signing script; `env` replaces the release variables of this process (CI sets GITHUB_SHA). */
export function runSign(root, args, env = {}) {
  const base = { ...process.env };
  delete base.TGN_RELEASE_PRIVATE_KEY;
  delete base.GITHUB_SHA;
  const r = spawnSync(process.execPath, [join(root, 'scripts', 'sign-release.mjs'), ...args], { env: { ...base, ...env }, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
