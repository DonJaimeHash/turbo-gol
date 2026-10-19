// The shell installers parse (bash -n), and install.sh writes a Caddyfile fit for its public
// address: a DNS name gets the default certificate, an IP address the short-lived profile, and
// both keep WebSockets open across a reload and turn HTTP/3 off. install.sh is sourced with
// TGN_INSTALL_LIB=1, which defines its functions and runs nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const installer = (name) => fileURLToPath(new URL(`../install/${name}`, import.meta.url)).replace(/\\/g, '/');
const INSTALL_SH = installer('install.sh');

/** A bash that runs (Git for Windows' on a Windows machine without one on the PATH), or null. */
function findBash() {
  const candidates = ['bash', ...(process.platform === 'win32' ? ['C:/Program Files/Git/bin/bash.exe'] : [])];
  for (const bash of candidates) {
    const r = spawnSync(bash, ['-c', 'echo ok'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'ok') return bash;
  }
  return null;
}
const BASH = findBash();
const skip = BASH ? false : 'no bash on this machine';

/** Run `script` in bash after sourcing install.sh as a library; returns its stdout. */
function withInstaller(script) {
  const r = spawnSync(BASH, ['-c', `. "$INSTALL_SH"\n${script}`], { encoding: 'utf8', env: { ...process.env, TGN_INSTALL_LIB: '1', INSTALL_SH } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

/** The Caddyfile without its comments and blank lines, one trimmed line each. */
const directives = (caddyfile) =>
  caddyfile
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));

test('the shell installers parse', { skip }, () => {
  for (const name of ['install.sh', 'install-desktop.sh']) {
    const r = spawnSync(BASH, ['-n', installer(name)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
  }
  assert.equal(withInstaller('echo sourced'), 'sourced\n', 'sourcing it as a library runs nothing');
});

test('Caddyfile for a DNS name: default certificate, WebSockets kept across reloads, no HTTP/3', { skip }, () => {
  const text = withInstaller('caddyfile sp1.turbo-gol.com 7350');
  assert.deepEqual(directives(text), [
    '{',
    'servers {',
    'protocols h1 h2',
    '}',
    '}',
    'sp1.turbo-gol.com {',
    'reverse_proxy 127.0.0.1:7350 {',
    'stream_close_delay 30m',
    '}',
    '}',
  ]);
  assert.doesNotMatch(text, /shortlived|cert_issuer/);
});

test('Caddyfile for an IP address: the short-lived certificate profile; IPv6 in brackets', { skip }, () => {
  const v4 = directives(withInstaller('caddyfile 203.0.113.7 7350'));
  assert.deepEqual(v4, [
    '{',
    'servers {',
    'protocols h1 h2',
    '}',
    'cert_issuer acme {',
    'profile shortlived',
    '}',
    '}',
    '203.0.113.7 {',
    'reverse_proxy 127.0.0.1:7350 {',
    'stream_close_delay 30m',
    '}',
    '}',
  ]);
  const v6 = directives(withInstaller('caddyfile 2001:db8::7 7350'));
  assert.ok(v6.includes('profile shortlived'));
  assert.ok(v6.includes('[2001:db8::7] {'), v6.join('\n'));
});

test('install.sh helpers: what is an IP address or a DNS name, which Caddy is new enough', { skip }, () => {
  const out = withInstaller(`
    for h in 203.0.113.7 256.1.1.1 2001:db8::7 sp1.turbo-gol.com localhost 'a b.com' 1.2.3.4:443 sp1.turbo-gol.com:443 '{x}.com'; do
      kind=-
      if is_ip "$h"; then kind=ip; elif is_dns_name "$h"; then kind=name; fi
      echo "$h=$kind"
    done
    for v in 'v2.10.2 h1:abc' 'v2.9.1 h1:abc' 'v2.6.2' 'v3.0.0' '(devel)' ''; do
      if version_at_least "$v" 2 10; then echo "[$v]=ok"; else echo "[$v]=old"; fi
    done
  `);
  assert.deepEqual(out.trim().split('\n'), [
    '203.0.113.7=ip',
    '256.1.1.1=-',
    '2001:db8::7=ip',
    'sp1.turbo-gol.com=name',
    'localhost=-',
    'a b.com=-',
    '1.2.3.4:443=-',
    'sp1.turbo-gol.com:443=-',
    '{x}.com=-',
    '[v2.10.2 h1:abc]=ok',
    '[v2.9.1 h1:abc]=old',
    '[v2.6.2]=old',
    '[v3.0.0]=ok',
    '[(devel)]=ok',
    '[]=ok',
  ]);
});
