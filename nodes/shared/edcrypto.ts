/**
 * Ed25519 keys, signatures, SHA-256 and EdDSA JSON Web Tokens on WebCrypto. Runs unchanged in
 * Node >= 24 and in workerd, so the same file serves the node program, the reference control
 * plane and, later, the NodeRegistryDO.
 *
 * Why asymmetric keys: the existing backend signs sessions and match tickets with HS256 under
 * JWT_SECRET. A community node must be able to CHECK a ticket without being able to MINT one, so
 * tickets for node matches are EdDSA (the control plane keeps the private key, every node gets the
 * public key at registration). Each node also has its own Ed25519 key pair, generated on the node,
 * that proves its identity to the control plane (challenge / response, signed uploads). Nothing a
 * node stores lets it impersonate the control plane or another node.
 *
 * Encodings: public keys are the 32 raw bytes, private keys PKCS#8, signatures 64 bytes, all
 * base64url without padding (same encoding as server/src/auth.ts, copied here so the node bundle
 * does not depend on the Worker's auth module).
 */

export function base64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const ED = { name: 'Ed25519' } as const;
const JWT_HEADER = base64urlEncode(enc.encode(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })));

export interface KeyPairB64 {
  /** 32 raw bytes, base64url. */
  publicKey: string;
  /** PKCS#8, base64url. Never leaves the machine that generated it. */
  privateKey: string;
}

function bytes(data: Uint8Array | string): Uint8Array<ArrayBuffer> {
  return typeof data === 'string' ? enc.encode(data) : (data as Uint8Array<ArrayBuffer>);
}

export async function generateEd25519(): Promise<KeyPairB64> {
  const pair = (await crypto.subtle.generateKey(ED, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const priv = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return { publicKey: base64urlEncode(pub), privateKey: base64urlEncode(priv) };
}

const pubCache = new Map<string, Promise<CryptoKey>>();

/** Import a base64url raw public key (cached per key string). Rejects on a malformed key. */
export function importPublicKey(b64: string): Promise<CryptoKey> {
  let p = pubCache.get(b64);
  if (!p) {
    const raw = base64urlDecode(b64);
    p = raw && raw.length === 32 ? crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, ED, true, ['verify']) : Promise.reject(new Error('bad public key'));
    p.catch(() => pubCache.delete(b64));
    pubCache.set(b64, p);
  }
  return p;
}

export async function importPrivateKey(b64: string): Promise<CryptoKey> {
  const raw = base64urlDecode(b64);
  if (!raw) throw new Error('bad private key');
  return crypto.subtle.importKey('pkcs8', raw as Uint8Array<ArrayBuffer>, ED, false, ['sign']);
}

/** True when `b64` decodes to a 32-byte key WebCrypto accepts. */
export async function isValidPublicKey(b64: unknown): Promise<boolean> {
  if (typeof b64 !== 'string' || b64.length > 64) return false;
  try {
    await importPublicKey(b64);
    return true;
  } catch {
    return false;
  }
}

/** Ed25519 signature of `data`, base64url. */
export async function sign(key: CryptoKey, data: Uint8Array | string): Promise<string> {
  return base64urlEncode(new Uint8Array(await crypto.subtle.sign(ED, key, bytes(data))));
}

export async function verify(key: CryptoKey, data: Uint8Array | string, sigB64: string): Promise<boolean> {
  if (typeof sigB64 !== 'string' || sigB64.length > 128) return false;
  const sig = base64urlDecode(sigB64);
  if (!sig || sig.length !== 64) return false;
  try {
    return await crypto.subtle.verify(ED, key, sig as Uint8Array<ArrayBuffer>, bytes(data));
  } catch {
    return false;
  }
}

/** Verify with a base64url public key (false on a malformed key instead of throwing). */
export async function verifyWith(publicKeyB64: string, data: Uint8Array | string, sigB64: string): Promise<boolean> {
  let key: CryptoKey;
  try {
    key = await importPublicKey(publicKeyB64);
  } catch {
    return false;
  }
  return verify(key, data, sigB64);
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(data)));
  let s = '';
  for (let i = 0; i < d.length; i++) s += (d[i] < 16 ? '0' : '') + d[i].toString(16);
  return s;
}

/** `n` random bytes as base64url (tokens, nonces). */
export function randomB64(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return base64urlEncode(b);
}

/** `n` random bytes as lowercase hex (ids). */
export function randomHexId(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}

/** Constant-time comparison of two strings of equal length (length leaks). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- EdDSA JWT ----------------------------------------------------------------------------

/** Sign a claims object as a compact JWT (header {alg: EdDSA, typ: JWT}). The caller sets iat / exp. */
export async function signEdJwt(key: CryptoKey, claims: object): Promise<string> {
  const body = JWT_HEADER + '.' + base64urlEncode(enc.encode(JSON.stringify(claims)));
  return body + '.' + (await sign(key, body));
}

/**
 * Verify an EdDSA JWT: header, signature, then a numeric `exp` in the future. Returns the claims
 * or null. Tokens over 4 KB, other algorithms and malformed parts are rejected.
 */
export async function verifyEdJwt<T extends { exp: number }>(key: CryptoKey, token: string, nowSec: number = Math.floor(Date.now() / 1000)): Promise<T | null> {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  if (parts[0] !== JWT_HEADER) {
    const hb = base64urlDecode(parts[0]);
    if (!hb) return null;
    try {
      const h = JSON.parse(dec.decode(hb)) as { alg?: unknown; typ?: unknown };
      if (h.alg !== 'EdDSA' || (h.typ !== undefined && h.typ !== 'JWT')) return null;
    } catch {
      return null;
    }
  }
  if (!(await verify(key, parts[0] + '.' + parts[1], parts[2]))) return null;
  const pb = base64urlDecode(parts[1]);
  if (!pb) return null;
  let claims: T;
  try {
    claims = JSON.parse(dec.decode(pb)) as T;
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object' || typeof claims.exp !== 'number' || !(claims.exp > nowSec)) return null;
  return claims;
}
