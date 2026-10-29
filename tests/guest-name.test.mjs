// Guest names (spec PR 1; audit auth-10, authz-5, rt-7): the server names every guest 'Invitado 4821'
// (src/net/guestName.ts, shared with the Worker) and each page shows that wire name in its own
// language (src/ui/names.ts playerName, lobbyTitle). This file is the English page (node's default);
// tests/guest-name-es.test.mjs is the Spanish one. The keys a guest's chosen name needed are gone
// in every locale, the new ones are in both.
// Run: node --test tests/guest-name.test.mjs
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

const I = await import('../src/i18n.ts');
const G = await import('../src/net/guestName.ts');
const N = await import('../src/ui/names.ts');
const { usernameIssue } = await import('../src/net/account.ts');
const en = I.LOCALES.en.messages;
const es = I.LOCALES.es.messages;

test('the page is English', () => {
  assert.equal(I.language(), 'en');
});

test('guestNameOf / guestNumber: the wire form Invitado 1000-9999, and only that', () => {
  assert.equal(G.guestNameOf('0000000000000000'), 'Invitado 1000');
  assert.equal(G.guestNameOf('0123456789abcdef'), 'Invitado ' + (1000 + (0x01234567 % 9000)));
  assert.equal(G.guestNumber('Invitado 4821'), '4821');
  for (const not of ['Invitado 0123', 'Invitado 48210', 'invitado 4821', 'Invitado  4821', 'Invitado 482', 'Guest 4821', 'Invitado4821', 'Ana', 'Bot 1', '']) {
    assert.equal(G.guestNumber(not), null, not);
  }
});

test("playerName: a guest's wire name in English, every other name as it is", () => {
  assert.equal(N.playerName('Invitado 4821'), 'Guest 4821');
  assert.equal(N.playerName('Invitado 1000'), 'Guest 1000');
  for (const raw of ['Invitado 0123', 'Invitado 48210', 'invitado 4821', 'Guest 4821', 'Ana', 'Bot 1', 'Constantinopla_9']) assert.equal(N.playerName(raw), raw, raw);
});

test("lobbyTitle: the server's default (the host's name) reads in English; a typed title as it is", () => {
  assert.equal(N.lobbyTitle('Invitado 4821', 'Invitado 4821'), 'Lobby Guest 4821', "a guest host's lobby");
  assert.equal(N.lobbyTitle('Ana', 'Ana'), 'Lobby Ana', "an account's default title");
  assert.equal(N.lobbyTitle('Invitado 4821', 'Ana'), 'Lobby Ana', 'a lobby an account inherited from a guest');
  assert.equal(N.lobbyTitle('Invitado 4821', ''), 'Lobby Guest 4821', 'nobody in it yet: the guest of the title');
  assert.equal(N.lobbyTitle('Los del barrio', 'Ana'), 'Los del barrio', 'typed by an account');
  assert.equal(N.lobbyTitle('Ana', 'Leo'), 'Ana', 'a title that is not the host');
});

test("usernameIssue: 'invitado…' is reserved like 'guest…' (Invitado4821, and the space never fits a username)", () => {
  assert.equal(usernameIssue('Invitado4821')?.code, 'usernameReserved');
  assert.equal(usernameIssue('invitado_ana')?.code, 'usernameReserved');
  assert.equal(usernameIssue('Invitado 4821')?.code, 'usernameChars');
  assert.equal(usernameIssue('Guest4821')?.code, 'usernameReserved');
  assert.equal(usernameIssue('Ana_4821'), null);
});

test('locales: the chosen-name keys are gone, the server-name keys are in both, the plate does not repeat the word', () => {
  for (const [code, m] of [['en', en], ['es', es]]) {
    for (const gone of ['lobby.yourName', 'profile.guestName', 'profile.saveName', 'profile.guestNameSaved']) assert.equal(m[gone], undefined, `${code}: ${gone}`);
    for (const key of ['guest.name', 'profile.guestLine', 'custom.guestTitle', 'error.lobby.name_reserved', 'game.guestName']) assert.equal(typeof m[key], 'string', `${code}: ${key}`);
    assert.match(m['guest.name'], /\{n\}/);
    assert.match(m['profile.guestLine'], /\{name\}/);
  }
  assert.equal(en['guest.name'], 'Guest {n}');
  assert.equal(es['guest.name'], 'Invitado {n}');
  assert.doesNotMatch(en['home.guestRank'], /guest/i, "under 'Guest 4821' the plate's line says something else");
  assert.doesNotMatch(es['home.guestRank'], /invitado/i);
});

test('no screen lets a guest choose a name any more (the field, its setter, the request body)', () => {
  const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
  for (const p of ['src/ui/Menu.ts', 'src/game/Game.ts', 'src/ui/screens/profile.ts', 'src/ui/screens/lobby.ts', 'src/net/NetClient.ts', 'src/game/OnlineSession.ts', 'src/net/p2p/P2PSession.ts']) {
    const hit = /setGuestName|\bsetName\(|defaultGuestName|lobby\.yourName|profile\.guestName\b/.exec(read(p));
    assert.equal(hit, null, `${p}: ${hit?.[0]}`);
  }
  assert.equal(/mn-prof-guestname/.test(read('src/ui/styles/screens/profile.css')), false);
});
