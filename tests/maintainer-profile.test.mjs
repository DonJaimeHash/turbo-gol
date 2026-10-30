// Sign-in PR 10 (the design's §3.12 step 5): PERFIL's CUENTA DEL PROYECTO, the checklist of the
// project's maintainer account (NODE_TRUSTED_OPERATORS), from /api/me's `maintainer`, which the
// server sends to that account only (server/test/maintainer.test.mjs): its password, a verified
// email, at least two ways in. DESVINCULAR on it says the refusal at once instead of asking for
// the password first (409 maintainer_two_ways is the server's). Both languages, tú in Spanish.
//   node --test tests/maintainer-profile.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND' && !/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
      throw err;
    }
  },
  // The screens import package.json as Vite does (no `with { type: 'json' }`): its version, as a module.
  load(url, context, nextLoad) {
    if (url.endsWith('/package.json') && context.importAttributes?.type !== 'json') {
      const { version } = JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
      return { format: 'module', shortCircuit: true, source: `export const version = ${JSON.stringify(version)}; export default { version: ${JSON.stringify(version)} };` };
    }
    return nextLoad(url, context);
  },
});

const P = await import('../src/ui/screens/profile.ts');
const en = (await import('../src/locales/en.ts')).default;
const es = (await import('../src/locales/es.ts')).default;
const PROFILE = readFileSync(new URL('../src/ui/screens/profile.ts', import.meta.url), 'utf8');

const me = (maintainer) => ({ playerId: 'p', name: 'Proyecto', createdAt: 0, providers: ['password', 'discord'], hasPassword: true, renameAt: 0, ratings: [], rankedBanUntil: 0, abandons24h: 0, season: 1, experimental: false, ...(maintainer ? { maintainer } : {}) });

test('the checklist: a password, a verified email and at least two ways in, each in words and done or not', () => {
  assert.deepEqual(P.maintainerChecks({ password: true, verifiedEmail: false, waysIn: 1 }), [
    { ok: true, text: 'Password: set' },
    { ok: false, text: 'Verified email: missing' },
    { ok: false, text: 'Ways to sign in: 1 of at least 2' },
  ]);
  assert.deepEqual(
    P.maintainerChecks({ password: true, verifiedEmail: true, waysIn: 2 }).map((c) => c.ok),
    [true, true, true],
    'ready: the owner may set the cutoff',
  );
  assert.deepEqual(P.maintainerChecks({ password: false, verifiedEmail: true, waysIn: 3 }).map((c) => [c.ok, c.text]), [
    [false, 'Password: missing'],
    [true, 'Verified email: set'],
    [true, 'Ways to sign in: 3 of at least 2'],
  ]);
});

test('DESVINCULAR on the project account: refused at once when its password and two ways in would not stay (the server\'s rule); any other account as before', () => {
  assert.equal(P.unlinkKeepsMaintainer(me(null)), true, 'not a maintainer: the server decides as for anyone');
  assert.equal(P.unlinkKeepsMaintainer(me({ password: true, verifiedEmail: true, waysIn: 3 })), true, 'two stay');
  assert.equal(P.unlinkKeepsMaintainer(me({ password: true, verifiedEmail: true, waysIn: 2 })), false, 'one would stay');
  assert.equal(P.unlinkKeepsMaintainer(me({ password: false, verifiedEmail: false, waysIn: 3 })), false, 'no password to keep');
  const view = PROFILE.slice(PROFILE.indexOf('const accountView = '), PROFILE.indexOf('/** ACERCA DE, under either view. */'));
  assert.match(view, /unlinkKeepsMaintainer\(me\) \? unlinkDialog\(p\) : menu\.toast\(t\('error\.account\.maintainer_two_ways'\), 'error'\)/);
});

test('PERFIL shows CUENTA DEL PROYECTO only with /api/me\'s maintainer, first in its column, never on a TV; with no CSS of its own (the node tile and its state lines)', () => {
  const view = PROFILE.slice(PROFILE.indexOf('const accountView = '), PROFILE.indexOf('/** ACERCA DE, under either view. */'));
  assert.match(view, /const project = me\?\.maintainer;/);
  assert.match(view, /project !== undefined && !\(sample === null && acc\.account\?\.tv === true\)/, 'not on a TV signed in with the phone');
  assert.match(view, /section\(t\('profile\.maintainerTitle'\), h\('div\.mn-prof-node', null, h\('p\.mn-prof-node-reason', null, t\('profile\.maintainerNote'\)\), \.\.\.maintainerChecks\(project\)\.map\(\(c\) => h\('span\.mn-prof-node-state', \{ 'data-ok': c\.ok \? 'true' : 'false' \}, h\('span\.mn-dot'\), c\.text\)\)\)\)/);
  assert.match(view, /'div\.mn-prof-col',\s*null,\s*projectChecks,\s*h\('section\.mn-section\.mn-prof-security'/, 'above CUENTA Y SEGURIDAD');
});

test('the texts in both languages: Spanish with tú, the refusal as the server words it', () => {
  const keys = ['profile.maintainerTitle', 'profile.maintainerNote', 'profile.maintainerPassword', 'profile.maintainerNoPassword', 'profile.maintainerEmail', 'profile.maintainerNoEmail', 'profile.maintainerWays', 'error.account.maintainer_two_ways'];
  for (const k of keys) {
    assert.equal(typeof en[k], 'string', k);
    assert.equal(typeof es[k], 'string', k);
    assert.notEqual(es[k], en[k], `${k} is translated`);
  }
  assert.equal(es['profile.maintainerTitle'], 'CUENTA DEL PROYECTO');
  assert.equal(es['error.account.maintainer_two_ways'], 'La cuenta del proyecto necesita su contraseña y al menos otra forma de entrar.');
  const server = readFileSync(new URL('../server/src/AccountsDO.ts', import.meta.url), 'utf8');
  assert.ok(server.includes(`error(409, 'maintainer_two_ways', '${es['error.account.maintainer_two_ways']}')`), "the server's own message, verbatim");
});
