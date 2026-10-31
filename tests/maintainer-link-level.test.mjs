// The review of sign-in PR 10: the project account (NODE_TRUSTED_OPERATORS) links a new way in only
// at level 2, which only its password reaches (server/src/accountRoutes.ts linkLevel; the server's
// test is server/test/privacy-fixes.test.mjs). PERFIL's VINCULAR asks for that level first, so its
// "confirm it's you" offers the password, never a provider's page the server would refuse after the
// round trip; every other account still links after a provider's press (level 1). AGREGAR CORREO
// asks for level 2 too on the project account while it has a password (the server's emailLevel).
//   node --test tests/maintainer-link-level.test.mjs
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
const PROFILE = readFileSync(new URL('../src/ui/screens/profile.ts', import.meta.url), 'utf8');

const me = (maintainer) => ({ playerId: 'p', name: 'Proyecto', createdAt: 0, providers: ['password', 'discord'], hasPassword: true, renameAt: 0, ratings: [], rankedBanUntil: 0, abandons24h: 0, season: 1, experimental: false, ...(maintainer ? { maintainer } : {}) });

test('VINCULAR asks for level 2 on the project account (its password) and level 1 on any other account', () => {
  assert.equal(P.linkLevel(me({ password: true, verifiedEmail: true, waysIn: 2 })), 2);
  assert.equal(P.linkLevel(me({ password: false, verifiedEmail: false, waysIn: 1 })), 2, 'a project account without its password yet: still 2 (the server refuses less)');
  assert.equal(P.linkLevel(me(null)), 1);
  assert.equal(P.linkLevel(null), 1, 'no /api/me yet: the server decides');
});

test('AGREGAR and CONFIRMAR CORREO ask for level 2 on the project account while it has a password (an address is a way in: its reset link), level 1 without one and on any other account', () => {
  assert.equal(P.emailAddLevel(me({ password: true, verifiedEmail: false, waysIn: 2 })), 2);
  assert.equal(P.emailAddLevel(me({ password: false, verifiedEmail: false, waysIn: 1 })), 1, 'no password yet: 1, its only level, so the owner can add its first address');
  assert.equal(P.emailAddLevel(me(null)), 1);
  assert.equal(P.emailAddLevel(null), 1, 'no /api/me yet: the server decides');
  // The Correo row's dialog asks for it (a change, or a password of before, still 2).
  assert.match(PROFILE, /fresh\(open, change \|\| legacy \? 2 : emailAddLevel\(me\), legacy, 'email:' \+ mode\)/);
});

test('both VINCULAR buttons (PERFIL\'s list and the banner and grace sheet) ask for linkLevel, not a fixed level 1', () => {
  const links = PROFILE.split('fresh(() => (window.location.href = acc.oauthUrl(p, true))').slice(1).map((rest) => rest.slice(0, 24));
  assert.equal(links.length, 2, JSON.stringify(links));
  for (const rest of links) assert.match(rest, /^, linkLevel\((me|acc\.me)\)\)/);
});
