// The public replays' privacy, the browser's side (audit pr60-1 and pr60-6; the server's side:
// server/test/nodeRoutes.test.mjs and server/test/replay-names.test.mjs). A hidden name ('Jugador 3'
// on the wire) and a guest's in this page's language; the viewer's green "Checked against the
// recording" only for a match a verifier checked (x-replay-verified), honest words for an
// unverified match and a local file; the list's opaque cursor; PERFIL's switch through
// AccountClient (GET / POST /api/me/replay-name). This file is the English page (node's default).
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

test('the viewer’s notice: green "Checked against the recording" only for a match a verifier checked; an unverified one and a local file say so', () => {
  const base = { divergedAt: -1, otherBuild: false, checked: 3, endTick: 25_000, time: '0:00' };
  assert.deepEqual(N.replayNotice({ ...base, source: { kind: 'server', verified: true } }), { key: 'replay.checked', ok: true, hideMs: 4000 });
  const casual = N.replayNotice({ ...base, source: { kind: 'server', verified: false } });
  assert.equal(casual.key, 'replay.unverifiedNotice');
  assert.equal(casual.ok, false, 'never the green check: the node wrote the inputs and the checkpoints alike');
  assert.ok(casual.hideMs > 4000);
  const file = N.replayNotice({ ...base, source: { kind: 'file' } });
  assert.equal(file.key, 'replay.localNotice');
  assert.equal(file.ok, false);
  // What the recording itself says comes first, whoever checked it.
  assert.deepEqual(N.replayNotice({ ...base, divergedAt: 600, time: '0:05', source: { kind: 'server', verified: true } }), { key: 'replay.diverged', params: { time: '0:05' }, ok: false, hideMs: null });
  assert.equal(N.replayNotice({ ...base, otherBuild: true, source: { kind: 'file' } }).key, 'replay.buildWarning');
  assert.equal(N.replayNotice({ ...base, checked: 0, source: { kind: 'server', verified: true } }), null, 'nothing checked: nothing to say');
  for (const k of ['replay.unverifiedNotice', 'replay.localNotice']) {
    assert.ok(en[k] && es[k], k);
    assert.doesNotMatch(en[k], /Checked against the recording/);
  }
  assert.match(es['replay.unverifiedNotice'], /^Sin verificar/);
  assert.match(es['replay.localNotice'], /^Archivo local/);
});

test('the viewer reads the view’s x-replay-verified and plays a local or dev file as one; main.ts never shows the green check by itself', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes('/view')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'x-replay-verified': String(url).includes('aa') ? '1' : '0' } });
    return new Response(JSON.stringify({ matches: [], next: null }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    assert.equal((await R.fetchReplayView('aa'.repeat(32))).verified, true);
    assert.equal((await R.fetchReplayView('bb'.repeat(32))).verified, false);
    await R.fetchReplayList('489375.' + 'c'.repeat(64) + '.' + 'd'.repeat(32));
    assert.equal(seen.at(-1), `/nodes/replays?before=489375.${'c'.repeat(64)}.${'d'.repeat(32)}`, 'the cursor goes back as the server signed it');
  } finally {
    globalThis.fetch = realFetch;
  }
  const main = await src('../src/replay/main.ts');
  assert.match(main, /replayNotice\(/);
  assert.doesNotMatch(main, /t\('replay\.checked'\)/, 'the decision is names.ts replayNotice');
  assert.match(main, /from: \{ kind: 'file' \}/, 'a local file is one');
  assert.match(main, /from: \{ kind: 'server', verified: v\.verified \}/);
});

test('the list says when a match shows up and that its time is rounded; names in the list and the player go through replayName', async () => {
  assert.match(en['replay.intro'], /one to two hours after it ends/);
  assert.match(en['replay.intro'], /rounded to the hour/);
  assert.match(es['replay.intro'], /entre una y dos horas después de terminar/);
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
