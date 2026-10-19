// The project's release key (Ed25519) in the shapes the release tools need:
//   raw   the 32-byte public key, base64url (43 characters): nodes/release-key.pub, what launchers
//         pin in <data>/release-key.pub and what the installers carry
//   pem   the same public key as an SPKI PEM, for openssl in install.sh
//   key   a node:crypto KeyObject, to verify signatures
// Signatures are base64url Ed25519 over the exact bytes of a file (manifest.json, launcher.mjs),
// the format node/launcher.ts and install.sh check.
//
// Only node:crypto and node:fs: scripts/sign-release.mjs imports this file, and the release private
// key must never share a process with third-party code (esbuild, werift, wrangler).
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const RAW = /^[A-Za-z0-9_-]{43}$/;

/** A KeyObject from the 43-character raw public key (JWK OKP, then SPKI for the PEM). Throws on anything else. */
export function publicKeyFromRaw(raw) {
  if (typeof raw !== 'string' || !RAW.test(raw)) throw new Error('not a release public key (43 base64url characters)');
  let key;
  try {
    key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
  } catch {
    throw new Error('not a valid Ed25519 public key');
  }
  // A non-canonical encoding of the same bytes would make string comparisons lie.
  if (rawOf(key) !== raw) throw new Error('not a canonical Ed25519 public key');
  return key;
}

/** The raw base64url public half of a public or private KeyObject. */
export function rawOf(key) {
  const pub = key.type === 'private' ? createPublicKey(key) : key;
  return pub.export({ format: 'jwk' }).x;
}

/** The release public key in a file (nodes/release-key.pub): { raw, pem, key }. */
export function readReleaseKey(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`${file} is missing`);
  }
  const raw = text.trim();
  try {
    const key = publicKeyFromRaw(raw);
    return { raw, pem: key.export({ format: 'pem', type: 'spki' }).toString().trim(), key };
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
}

/**
 * A private key from its text: PKCS#8 DER in base64url (the privateKey field scripts/keys.mjs
 * writes), or a whole keys.mjs JSON file. The error never quotes the text.
 */
export function privateKeyFromText(text) {
  let b64 = String(text ?? '').trim();
  if (b64.startsWith('{')) {
    try {
      b64 = String(JSON.parse(b64).privateKey ?? '').trim();
    } catch {
      b64 = '';
    }
  }
  try {
    const key = createPrivateKey({ key: Buffer.from(b64, 'base64url'), format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
    return key;
  } catch {
    throw new Error('the release private key is not an Ed25519 PKCS#8 key in base64url');
  }
}

export const signB64 = (bytes, privateKey) => sign(null, bytes, privateKey).toString('base64url');

export function verifyB64(bytes, sigText, publicKey) {
  const sig = Buffer.from(String(sigText).trim(), 'base64url');
  return sig.length === 64 && verify(null, bytes, publicKey, sig);
}
