// The public replays' privacy, the browser's side (audit pr60-1; the server's side:
// server/test/nodeRoutes.test.mjs and server/test/replay-names.test.mjs). A hidden name ('Jugador 3'
// on the wire) and a guest's in this page's language; PERFIL's switch through AccountClient
// (GET / POST /api/me/replay-name). This file is the English page (node's default).
// Run: node --test tests/replay-privacy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';

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
const R = await import('../src/net/replays.ts');
const N = await import('../src/replay/names.ts');
const AC = await import('../src/net/AccountClient.ts');
const en = I.LOCALES.en.messages;
const es = I.LOCALES.es.messages;
const src = (p) => readFile(new URL(p, import.meta.url), 'utf8');

test('the page is English', () => {
  assert.equal(I.language(), 'en');
});

test('a hidden name: "Jugador N" on the wire (the slot + 1), "Player N" on an English page; a guest and anyone else as before', () => {
  assert.equal(R.hiddenNameOf(0), 'Jugador 1');
  assert.equal(R.hiddenNameOf(5), 'Jugador 6');
  assert.equal(R.hiddenNumber('Jugador 3'), '3');
  for (const not of ['Jugador 0', 'Jugador 9', 'Jugador3', 'jugador 3', 'Jugador  3', 'Ana', 'Invitado 4821', '']) assert.equal(R.hiddenNumber(not), null, not);
  assert.equal(N.replayName('Jugador 3'), 'Player 3');
  assert.equal(N.replayName('Invitado 4821'), 'Guest 4821');
  assert.equal(N.replayName('Ana'), 'Ana');
  assert.equal(es['replay.hiddenName'], 'Jugador {n}');
  assert.equal(en['replay.hiddenName'], 'Player {n}');
});

test('the list says when a match shows up and that its time is rounded; names in the list and the player go through replayName', async () => {
  assert.match(en['replay.intro'], /an hour after it ends/);
  assert.match(en['replay.intro'], /rounded to the hour/);
  assert.match(es['replay.intro'], /una hora después de terminar/);
  for (const f of ['../src/replay/list.ts', '../src/replay/player.ts']) {
    const text = await src(f);
    assert.match(text, /replayName\(/, f);
    assert.doesNotMatch(text, /playerName\(/, f);
  }
});

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test('PERFIL’s switch: AccountClient reads and sets "hide my name" with the account’s Bearer; PERFIL shows it, off by default', async () => {
  const calls = [];
  let hidden = false;
  const fetchFn = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method: init.method, body, auth: init.headers.authorization });
    if (path === '/api/auth/refresh') return res(200, { kind: 'account', playerId: 'abcdef0123456789', name: 'Ana', session: 'jwt-ana', expiresAt: Date.now() + 3_600_000 });
    if (path === '/api/me/replay-name') {
      if (body) hidden = body.hidden;
      return res(200, { hidden });
    }
    return res(404, { error: 'not_found' });
  };
  const acc = new AC.AccountClient({ storage: null, fetchFn, sleep: async () => undefined });
  await acc.restore();
  assert.equal(await acc.replayNameHidden(), false, 'off by default');
  assert.equal(await acc.setReplayNameHidden(true), true);
  assert.equal(await acc.replayNameHidden(), true);
  const asked = calls.filter((c) => c.path === '/api/me/replay-name');
  assert.deepEqual(
    asked.map((c) => [c.method, c.body, c.auth]),
    [
      ['GET', undefined, 'Bearer jwt-ana'],
      ['POST', { hidden: true }, 'Bearer jwt-ana'],
      ['GET', undefined, 'Bearer jwt-ana'],
    ],
  );
  const profile = await src('../src/ui/screens/profile.ts');
  assert.match(profile, /toggleSwitch\(\s*'profile-replay-name'/);
  assert.match(profile, /acc\.setReplayNameHidden\(on\)/);
  assert.match(profile, /section\(t\('profile\.privacy'\), setRow\(t\('profile\.hideReplayName'\)/);
  assert.equal(es['profile.hideReplayName'], 'Ocultar mi nombre en repeticiones públicas', 'the owner’s words');
  assert.equal(en['profile.hideReplayName'], 'Hide my name in public replays');
  assert.match(es['profile.hideReplayNameHelp'], /«Jugador N»/);
  assert.match(en['profile.hideReplayNameHelp'], /"Player N"/);
});
