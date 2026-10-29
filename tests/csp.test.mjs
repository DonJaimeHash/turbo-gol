// The game page's security headers (public/_headers, which Workers Static Assets applies to every
// page it serves: /, /tv, the SPA fallback and the replay viewer): an enforced Content-Security-Policy
// the whole game works under, and HSTS. Read against the code that needs each source; no browser.
//   node --test tests/csp.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** _headers as { path: { lower-case name: value } } (Cloudflare's format: a path, then indented "Name: value" lines). */
function parseHeaders(text) {
  const rules = {};
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      cur = rules[line.trim()] ??= {};
      continue;
    }
    const i = line.indexOf(':');
    assert.ok(cur !== null && i > 0, `a header outside a rule: ${line}`);
    cur[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return rules;
}

/** A policy as Map(directive -> [sources]). */
function parseCsp(value) {
  const out = new Map();
  for (const part of value.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    assert.ok(!out.has(name), `${name} twice`);
    out.set(name.toLowerCase(), sources);
  }
  return out;
}

const sha256 = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const all = parseHeaders(read('public/_headers'));
const page = all['/*'] ?? {};
const csp = parseCsp(page['content-security-policy'] ?? '');
const src = (d) => csp.get(d) ?? csp.get('default-src') ?? [];

test('every page gets an enforced CSP and HSTS for a year, subdomains included', () => {
  assert.ok(page['content-security-policy'], 'Content-Security-Policy under /*');
  assert.equal(page['content-security-policy-report-only'], undefined, 'enforced, not report-only');
  const hsts = page['strict-transport-security'] ?? '';
  const age = Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? 0);
  assert.ok(age >= 31_536_000, `HSTS max-age ${age}`);
  assert.match(hsts, /includeSubDomains/);
  // The headers that were already there stay.
  assert.equal(page['x-frame-options'], 'DENY');
  assert.equal(page['x-content-type-options'], 'nosniff');
});

test('the policy locks down what an injected script could use', () => {
  assert.deepEqual(csp.get('default-src'), ["'self'"]);
  assert.deepEqual(csp.get('object-src'), ["'none'"]);
  assert.deepEqual(csp.get('base-uri'), ["'none'"]);
  assert.deepEqual(csp.get('frame-ancestors'), ["'none'"]);
  assert.deepEqual(csp.get('form-action'), ["'self'"]);
  const script = src('script-src');
  for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "'strict-dynamic'", '*', 'https:', 'http:', 'data:', 'blob:'])
    assert.ok(!script.includes(bad), `script-src allows ${bad}`);
  for (const s of script) assert.ok(/^'(self|wasm-unsafe-eval|sha256-[A-Za-z0-9+/]+=*)'$|^https:\/\/[a-z0-9.-]+$/.test(s), `script-src source ${s}`);
  for (const d of ['img-src', 'connect-src', 'frame-src', 'font-src', 'worker-src', 'style-src'])
    assert.ok(!src(d).includes('*') && !src(d).includes('https:') && !src(d).includes('http:'), `${d} has a wildcard`);
});

/** The pages the build emits: vite.config.ts's rollupOptions.input (index.html, replay.html...). */
function builtPages() {
  const pages = [...read('vite.config.ts').matchAll(/new URL\('\.\/([\w.-]+\.html)', import\.meta\.url\)/g)].map((m) => m[1]);
  // One page is the default (no input): index.html.
  return pages.length > 0 ? pages : ['index.html'];
}

const inlineScripts = (html) => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/\bsrc=/.test(m[1])).map((m) => m[2]);

test("every page's inline scripts are exactly the hashes script-src lists, and no page has inline handlers", () => {
  const pages = builtPages();
  // Every HTML file at the root is a page of the build, and every page is checked (a new page
  // added to one list and not the other fails here).
  const atRoot = readdirSync(ROOT).filter((f) => f.endsWith('.html'));
  assert.deepEqual([...pages].sort(), [...atRoot].sort(), 'vite.config.ts rollupOptions.input vs the root *.html files');
  assert.ok(pages.includes('index.html') && pages.includes('replay.html'), `pages: ${pages.join(', ')}`);
  const inline = [];
  for (const page of pages) {
    const html = read(page);
    const hashes = inlineScripts(html).map(sha256);
    if (page === 'index.html') assert.ok(hashes.length > 0, 'the /tv/ redirect is inline');
    for (const h of hashes) inline.push(`${page} ${h}`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${page}: an inline event handler (on...=) never runs under this CSP`);
    assert.doesNotMatch(html, /javascript:/i, `${page}: a javascript: URL never runs under this CSP`);
  }
  const listed = src('script-src').filter((s) => s.startsWith("'sha256-"));
  const needed = [...new Set(inline.map((s) => s.split(' ')[1]))];
  assert.deepEqual([...listed].sort(), [...needed].sort(), `update the sha256 in public/_headers with the inline scripts:\n  ${inline.join('\n  ')}`);
});

test('the game works under it: wasm, the music worklet, the sockets and the community nodes', () => {
  // RocketSim: WebAssembly.instantiate needs 'wasm-unsafe-eval', and the glue never evals.
  const glue = read('src/sim/wasm/rocketsim.js');
  assert.match(glue, /WebAssembly\.instantiate/);
  assert.doesNotMatch(glue, /\beval\(|new Function\(/);
  assert.ok(src('script-src').includes("'wasm-unsafe-eval'"));
  // The AudioWorklet module is a build file (?worker&url), so 'self' covers it: no blob: needed.
  assert.match(read('src/audio/Audio.ts'), /from '\.\/music\/worklet\.ts\?worker&url'/);
  const code = walk(join(ROOT, 'src')).filter((f) => !f.endsWith('rocketsim.js'));
  const blobs = code.filter((f) => /createObjectURL/.test(readFileSync(f, 'utf8'))).map((f) => relative(ROOT, f));
  assert.deepEqual(blobs, [], 'a blob: URL for a script, worker or worklet would need blob: in script-src / worker-src');
  // The API, the match, room and lobby sockets are same-origin; a community node is a wss:// URL
  // on its own domain (server/src/nodeApi.ts isWss).
  assert.ok(src('connect-src').includes("'self'"));
  assert.ok(src('connect-src').includes('wss:'), 'community nodes are wss:// hosts anywhere');
  assert.match(read('server/src/nodeApi.ts'), /protocol === 'wss:'/);
  // Fonts and images are the build's own (plus generated data: / blob: images).
  assert.deepEqual(src('font-src'), ["'self'"]);
  for (const s of ["'self'", 'data:', 'blob:']) assert.ok(src('img-src').includes(s), `img-src ${s}`);
  // The icon sprite and the debug overlays set style attributes.
  assert.ok(src('style-src').includes("'unsafe-inline'"));
});

test('Turnstile and Cloudflare Web Analytics are allowed, and only their hosts', () => {
  const url = /TURNSTILE_SCRIPT_URL = '([^']+)'/.exec(read('src/net/Turnstile.ts'))?.[1];
  assert.ok(url, 'TURNSTILE_SCRIPT_URL');
  const origin = new URL(url).origin;
  assert.ok(src('script-src').includes(origin), `script-src ${origin}`);
  assert.deepEqual(src('frame-src'), [origin], 'the challenge iframe and nothing else');
  // The zone injects the beacon script; it reports to /cdn-cgi/rum on the page's own origin ('self').
  assert.ok(src('script-src').includes('https://static.cloudflareinsights.com'));
  const hosts = src('script-src').filter((s) => s.startsWith('https://'));
  assert.deepEqual([...hosts].sort(), [origin, 'https://static.cloudflareinsights.com'].sort());
});
