// The default lobby name (custom.ts lobbyCreateScreen: t('custom.defaultName', { name }), cut to
// 24 characters) is sent to the server as typed, and the server keeps only the characters of its
// sanitizer (server/src/LobbyDO.ts sanitizeLobbyName: letters, digits, space _ . - ! ? #, 3 to 24
// long). Every locale's template must survive it unchanged, even with the longest player name:
// an English "{name}'s lobby" would arrive as "Guest123s lobby".
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
const { USERNAME_MAX } = await import('../src/net/account.ts');
// A computed specifier: the root tsc (allowJs over tests/) would otherwise type-check this Worker
// module, whose types (cloudflare:workers) only server/ has.
const LOBBY_DO = new URL('../server/src/LobbyDO.ts', import.meta.url).href;
const { sanitizeLobbyName } = await import(LOBBY_DO);

// The longest names a player can have (accounts and guests both stop at 16), in the characters
// usernames allow (src/net/account.ts usernameProblem).
const NAMES = ['A'.repeat(USERNAME_MAX), 'abc_def-ghi.1234', 'Ana'];

test('the default lobby name survives the server sanitizer in every locale', () => {
  assert.equal(USERNAME_MAX, 16);
  for (const [code, { messages }] of Object.entries(I.LOCALES)) {
    for (const name of NAMES) {
      const text = I.textIn(messages, code, 'custom.defaultName', { name });
      assert.ok(text.includes(name), `${code}: the template has no {name}: ${JSON.stringify(text)}`);
      assert.ok(text.length <= 24, `${code}: ${JSON.stringify(text)} is longer than 24 characters (the client cuts the name)`);
      assert.equal(sanitizeLobbyName(text), text, `${code}: the server would change ${JSON.stringify(text)}`);
    }
  }
});

test('the sanitizer still drops what the templates must avoid', () => {
  assert.equal(sanitizeLobbyName("Guest123's lobby"), 'Guest123s lobby');
  assert.equal(sanitizeLobbyName('Sala de Tomi'), 'Sala de Tomi');
  assert.equal(sanitizeLobbyName('x'.repeat(25)), null);
});
