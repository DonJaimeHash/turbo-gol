// Usernames and lobby titles that read as a web address are refused (the owner, 2026-10-29): a name
// like 'tg-verify.com' could pass for a link to another site in a lobby, the leaderboard or a mail.
// The rule is src/net/account.ts looksLikeDomain, shared by the client, the Worker and AccountsDO.
// Run: node --test tests/username-domain.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';

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
});

const { looksLikeDomain, usernameIssue, usernameProblem, lobbyNameIssue } = await import('../src/net/account.ts');

test('usernames shaped like a web address are refused', () => {
  for (const name of ['tg-verify.com', 'www.x.gg', 'WWW.turbo', 'ana.ar', 'pro.player.io', 'x.Dev', 'shop.xyz']) {
    assert.equal(looksLikeDomain(name), true, name);
    assert.equal(usernameIssue(name)?.code, 'usernameDomain', name);
  }
  assert.match(usernameProblem('tg-verify.com'), /dirección web/);
});

test('names with a dot that do not read as an address still pass', () => {
  for (const name of ['jv.77', 'ana.b', 'Jv_77_B', 'ana_bel', 'la-pulga', 'x.9.z1']) {
    assert.equal(looksLikeDomain(name), false, name);
    assert.equal(usernameIssue(name), null, name);
  }
});

test('lobby titles holding a web address are refused, plain titles are not', () => {
  for (const title of ['Gana premios en tg-verify.com', 'www.x.gg', 'Entra a https://evil', 'Sala de pro.player.io!', 'Мi sala en x.сom']) {
    assert.equal(lobbyNameIssue(title), 'name_reserved', title);
  }
  for (const title of ['Sala de Ana', 'Ana vs. Juan', 'Partido 3.5', 'Los de siempre', 'jv.77 y amigos']) {
    assert.equal(lobbyNameIssue(title), null, title);
  }
});

test('the refusal has its text in both languages', () => {
  for (const file of ['src/locales/es.ts', 'src/locales/en.ts']) {
    assert.match(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), /'account\.issue\.usernameDomain':/, file);
  }
});

test('an OAuth display name never becomes a web-address username', () => {
  const src = readFileSync(new URL('../server/src/accountStore.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function usernameFromDisplay'));
  assert.match(body.slice(0, body.indexOf('\n}\n')), /looksLikeDomain\(s\)\) s = s\.replace\(\/\\\.\/g, '_'\)/);
});
