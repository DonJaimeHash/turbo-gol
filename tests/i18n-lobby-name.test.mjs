// A lobby's default title is the server's (the host's name) and each page shows it as
// t('custom.defaultName', { name }) (src/ui/names.ts lobbyTitle). The host's SETTINGS shows that text
// in its name field, and an account that edits it sends what it typed: the server keeps only the
// characters of its sanitizer (server/src/LobbyDO.ts sanitizeLobbyName: letters, digits, space
// _ . - ! ? #, 3 to 24 long) and refuses a reserved title (src/net/account.ts lobbyNameIssue).
// Every locale's template must survive both, even with the longest player name and a guest's
// ('Guest 4821'): an English "{name}'s lobby" would arrive as "Guest 4821s lobby".
// Run: node --test tests/i18n-lobby-name.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// LobbyDO.ts extends the Worker's DurableObject: a stub class lets node load its pure helpers
// (the same stub as server/test/accounts.test.mjs).
const DO_STUB = 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return { url: DO_STUB, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (!specifier.startsWith('.') || /\.[cm]?ts$/.test(specifier)) throw err;
      return nextResolve(specifier.replace(/\.js$/, '') + '.ts', context);
    }
  },
});

const I = await import('../src/i18n.ts');
const { USERNAME_MAX, lobbyNameIssue } = await import('../src/net/account.ts');
// A computed specifier: the root tsc (allowJs over tests/) would otherwise type-check this Worker
// module, whose types (cloudflare:workers) only server/ has.
const LOBBY_DO = new URL('../server/src/LobbyDO.ts', import.meta.url).href;
const { sanitizeLobbyName } = await import(LOBBY_DO);

// The longest names a player can have (accounts and guests both stop at 16), in the characters
// usernames allow (src/net/account.ts usernameProblem).
const NAMES = ['A'.repeat(USERNAME_MAX), 'abc_def-ghi.1234', 'Ana', 'Guest 4821', 'Invitado 4821'];

test('the default lobby name survives the server sanitizer in every locale', () => {
  assert.equal(USERNAME_MAX, 16);
  for (const [code, { messages }] of Object.entries(I.LOCALES)) {
    for (const name of NAMES) {
      const text = I.textIn(messages, code, 'custom.defaultName', { name });
      assert.ok(text.includes(name), `${code}: the template has no {name}: ${JSON.stringify(text)}`);
      assert.ok(text.length <= 24, `${code}: ${JSON.stringify(text)} is longer than 24 characters (the client cuts the name)`);
      assert.equal(sanitizeLobbyName(text), text, `${code}: the server would change ${JSON.stringify(text)}`);
      assert.equal(lobbyNameIssue(text), null, `${code}: the server would refuse ${JSON.stringify(text)} (name_reserved)`);
    }
  }
  // The Sala samples' (src/ui/screens/lobbySamples.ts): the host's names, the server's default titles.
  for (const name of ['Constantinopla_9', 'Ana', 'Valentina_Rios', 'Leo', 'MaximilianoGomez', 'Bea']) assert.equal(lobbyNameIssue(name), null, name);
});

test('preset names keep to the same rules in every locale: built-ins, "My rules N" and "{name} #N" copies', async () => {
  const R = await import('../src/game/physicsRules.ts');
  const ACC = await import('../src/net/account.ts');
  assert.equal(ACC.sanitizeLobbyName, sanitizeLobbyName, 'LobbyDO re-exports the shared sanitizer');
  for (const [code, { messages }] of Object.entries(I.LOCALES)) {
    const say = (key, params) => I.textIn(messages, code, key, params);
    const keep = (text, what) => assert.equal(sanitizeLobbyName(text), text, `${code} ${what}: the sanitizer would change ${JSON.stringify(text)}`);
    for (const p of R.BUILT_IN_PRESETS) keep(say(`rules.builtin.${p.id}`), p.id);
    for (const n of [1, 9, 10, 99]) keep(say('rules.defaultName', { n }), 'rules.defaultName');
    assert.equal(R.defaultPresetName([], (n) => say('rules.defaultName', { n })), say('rules.defaultName', { n: 1 }));
    const copyOf = (name, n) => say('rules.copyName', { name, n });
    for (const base of [say('rules.builtin.lowGravity'), say('rules.defaultName', { n: 10 }), 'A'.repeat(24)]) {
      const copy = R.copyPresetName(base, [], copyOf);
      keep(copy, 'rules.copyName');
      assert.ok(copy.length <= 24);
      keep(R.copyPresetName(copy, [copy], copyOf), 'a copy of a copy');
    }
  }
});

test('the sanitizer still drops what the templates must avoid', () => {
  assert.equal(sanitizeLobbyName("Guest123's lobby"), 'Guest123s lobby');
  assert.equal(sanitizeLobbyName('Sala de Tomi'), 'Sala de Tomi');
  assert.equal(sanitizeLobbyName('x'.repeat(25)), null);
});
