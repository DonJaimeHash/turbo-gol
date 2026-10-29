// The public docs are not a targeting guide for the project's own machines (the audit's repo-5):
// no routable IP address anywhere, and the trusted node's manual (nodes/docs/VPS-SAO-PAULO.md)
// and plan (PRODUCCION.md) give placeholders, not its provider and plan, SSH key file, test user
// or the traffic and match budgets an abuser would need to push it out of rotation. Those live in
// the maintainer's notes. Reads the tracked .md and .txt files.
//   node --test tests/public-docs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const r = spawnSync('git', ['ls-files', '--', '*.md', '*.txt'], { cwd: ROOT, encoding: 'utf8' });
const docs = r.stdout.split('\n').filter(Boolean);
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

/** An IPv4 address nobody may route to on the internet: loopback, private, link-local, CGNAT, documentation, unspecified. */
function reservedV4(ip) {
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224
  );
}

test('the docs are found', () => {
  assert.equal(r.status, 0, r.stderr);
  assert.ok(docs.includes('nodes/docs/VPS-SAO-PAULO.md'));
});

test('no doc names a routable IP address (examples use the documentation ranges)', () => {
  const hits = [];
  for (const f of docs) {
    const text = read(f);
    // IPv4, not part of a longer dotted version (1.2.3.4.5) nor a version string (v1.2.3.4, x@1.2.3.4).
    for (const m of text.matchAll(/(?<![\w.@])((?:\d{1,3}\.){3}\d{1,3})(?![\w.])/g)) {
      const ip = m[1];
      if (ip.split('.').every((o) => Number(o) <= 255) && !reservedV4(ip)) hits.push(`${f}: ${ip}`);
    }
    // IPv6 global unicast (2000::/3), outside 2001:db8::/32.
    for (const m of text.matchAll(/(?<![\w:])([23][0-9a-f]{3}:[0-9a-f]{0,4}:[0-9a-f:]*[0-9a-f])(?![\w:])/gi))
      if (!/^2001:0?db8:/i.test(m[1])) hits.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(hits, []);
});

test("the trusted node's manual and plan give placeholders, not its provider, keys or budgets", () => {
  const hits = [];
  for (const f of ['nodes/docs/VPS-SAO-PAULO.md', 'nodes/docs/PRODUCCION.md']) {
    const text = read(f);
    for (const [what, re] of [
      ['the provider', /hostinger/i],
      ['the plan', /\bKVM ?\d/i],
      ['the site', /campinas/i],
      ['an SSH key file', /\.ssh[\\/](?!<)[\w.-]+/],
      ['the test user', /\btgtest\b/],
      ['a traffic cap', /--egress-cap-gb[ =]\d/],
      ['a declared capacity', /--matches[ =]\d/],
      ['the plan transfer', /\d+ ?TB\b/],
    ])
      if (re.test(text)) hits.push(`${f}: ${what} (${re.exec(text)[0]})`);
  }
  for (const f of docs) if (/\bKVM ?2\b|campinas/i.test(read(f))) hits.push(`${f}: the node's plan or site`);
  assert.deepEqual(hits, []);
});
