// The game page's security headers (public/_headers, which Workers Static Assets applies to every
// page it serves: /, /tv, the SPA fallback and the replay viewer): the Content-Security-Policy the
// whole game works under, and HSTS. The full policy is report-only; the enforced one is the same
// without the eval gate, which would refuse the physics wasm on Chromium 94 to 96 (2023 TVs). Read
// against the code that needs each source; no browser.
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
/** The full policy, report-only: everything below is checked on it, so it can be enforced as is. */
const full = parseCsp(page['content-security-policy-report-only'] ?? '');
/** The enforced policy: the full one without the eval gate (default-src and script-src). */
const enforced = parseCsp(page['content-security-policy'] ?? '');
const src = (d) => full.get(d) ?? full.get('default-src') ?? [];
const sorted = (list) => [...(list ?? [])].sort();

// CSP3's fallback lists (w3c.github.io/webappsec-csp, "directive fallback list"), for the checks
// the pages are subject to: each element, inline script or request type, and the navigation rules.
const FALLBACK = {
  'script-src-elem': ['script-src-elem', 'script-src', 'default-src'],
  'script-src-attr': ['script-src-attr', 'script-src', 'default-src'],
  'style-src-elem': ['style-src-elem', 'style-src', 'default-src'],
  'style-src-attr': ['style-src-attr', 'style-src', 'default-src'],
  'worker-src': ['worker-src', 'child-src', 'script-src', 'default-src'],
  'frame-src': ['frame-src', 'child-src', 'default-src'],
  'connect-src': ['connect-src', 'default-src'],
  'font-src': ['font-src', 'default-src'],
  'img-src': ['img-src', 'default-src'],
  'manifest-src': ['manifest-src', 'default-src'],
  'media-src': ['media-src', 'default-src'],
  'object-src': ['object-src', 'default-src'],
  'base-uri': ['base-uri'],
  'form-action': ['form-action'],
  'frame-ancestors': ['frame-ancestors'],
};
/** The sources `policy` applies to `check`, or null when nothing in it restricts that check. */
function effective(policy, check) {
  for (const d of FALLBACK[check]) if (policy.has(d)) return policy.get(d);
  return null;
}

test('every page gets the CSP (the full policy report-only, the rest enforced) and HSTS for a year, subdomains included', () => {
  assert.ok(page['content-security-policy'], 'Content-Security-Policy under /*');
  assert.ok(page['content-security-policy-report-only'], 'Content-Security-Policy-Report-Only under /*');
  const hsts = page['strict-transport-security'] ?? '';
  const age = Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? 0);
  assert.ok(age >= 31_536_000, `HSTS max-age ${age}`);
  assert.match(hsts, /includeSubDomains/);
  // The headers that were already there stay.
  assert.equal(page['x-frame-options'], 'DENY');
  assert.equal(page['x-content-type-options'], 'nosniff');
});

test('the policy locks down what an injected script could use', () => {
  assert.deepEqual(full.get('default-src'), ["'self'"]);
  assert.deepEqual(full.get('object-src'), ["'none'"]);
  assert.deepEqual(full.get('base-uri'), ["'none'"]);
  assert.deepEqual(full.get('frame-ancestors'), ["'none'"]);
  assert.deepEqual(full.get('form-action'), ["'self'"]);
  for (const [name, script] of [['script-src', src('script-src')], ['enforced script-src-elem', enforced.get('script-src-elem') ?? []]]) {
    for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "'strict-dynamic'", '*', 'https:', 'http:', 'data:', 'blob:'])
      assert.ok(!script.includes(bad), `${name} allows ${bad}`);
    for (const s of script) assert.ok(/^'(self|wasm-unsafe-eval|sha256-[A-Za-z0-9+/]+=*)'$|^https:\/\/[a-z0-9.-]+$/.test(s), `${name} source ${s}`);
  }
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
  const needed = [...new Set(inline.map((s) => s.split(' ')[1]))];
  for (const [name, list] of [['script-src (report-only)', src('script-src')], ['script-src-elem (enforced)', enforced.get('script-src-elem') ?? []]]) {
    const listed = list.filter((s) => s.startsWith("'sha256-"));
    assert.deepEqual(sorted(listed), sorted(needed), `update the sha256 in public/_headers' ${name} with the inline scripts:\n  ${inline.join('\n  ')}`);
  }
});

test('the game works under it: wasm, the music worklet, the sockets and the community nodes', () => {
  // RocketSim: WebAssembly.instantiate needs 'wasm-unsafe-eval' once the full policy is enforced
  // (the enforced one gates no wasm: see the Chromium 94 to 96 test), and the glue never evals.
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

test('Chromium 94 to 96 (2023 TVs) still compile the physics wasm: no enforced policy gates eval', () => {
  // 'wasm-unsafe-eval' is new in Chrome 97. An older Chromium ignores the unknown keyword and then
  // compiles a wasm module only where eval may run: script-src, or default-src without it, must say
  // 'unsafe-eval'. The bundle itself runs from Chromium 94 (three.js has class static blocks), the
  // engine of the 2023 TVs (Tizen 7, webOS 23), so 94 to 96 would boot to "Could not load the
  // physics module", and the replay viewer could not play a match.
  const asOld = new Map([...enforced].map(([d, s]) => [d, s.filter((x) => x !== "'wasm-unsafe-eval'")]));
  const gate = asOld.get('script-src') ?? asOld.get('default-src') ?? null;
  assert.equal(gate, null, `the enforced policy gates eval, and so (before Chrome 97) every wasm: ${gate?.join(' ')}`);
  // No other enforced policy either: a <meta http-equiv> CSP in a page would be one.
  for (const p of builtPages()) assert.doesNotMatch(read(p), /http-equiv\s*=\s*["']?content-security-policy/i, `${p}: a <meta> CSP is enforced too`);
  // And 'unsafe-eval' is never the way out, in either policy.
  for (const [name, policy] of [['enforced', enforced], ['report-only', full]])
    for (const [d, s] of policy) assert.ok(!s.includes("'unsafe-eval'"), `${name} ${d} allows 'unsafe-eval'`);
});

test('the enforced policy refuses everything the full one does, except eval and wasm', () => {
  // Each check resolves to the same sources in both ('wasm-unsafe-eval' aside: it only gates wasm),
  // so the enforced policy refuses injected scripts, frames, connections and the rest just as the
  // full one would. The difference is eval and wasm compilation, which the report-only one reports.
  for (const check of Object.keys(FALLBACK)) {
    if (check === 'script-src-attr') continue;
    const want = effective(full, check)?.filter((s) => s !== "'wasm-unsafe-eval'") ?? null;
    const got = effective(enforced, check);
    assert.ok(got !== null, `${check}: unrestricted in the enforced policy (the full one says ${want?.join(' ')})`);
    assert.deepEqual(sorted(got), sorted(want), `${check}: enforced vs report-only`);
  }
  // Inline event handlers: the full policy refuses them (no 'unsafe-inline' or 'unsafe-hashes' in
  // script-src); without script-src, the enforced one needs script-src-attr 'none' to do the same.
  assert.deepEqual(enforced.get('script-src-attr'), ["'none'"]);
  // Nothing beyond the full policy's directives and the ones standing in for default-src and script-src.
  const extra = [...enforced.keys()].filter((d) => !full.has(d) && !['script-src-elem', 'script-src-attr', 'media-src', 'manifest-src'].includes(d));
  assert.deepEqual(extra, [], 'directives only the enforced policy has');
});
