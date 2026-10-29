// Guest names on the Spanish page (tests/guest-name.test.mjs is the English one): the server's wire
// name 'Invitado 4821' reads as it is, and a lobby's default title as "Sala de …". Outside a browser
// the page is English, so this file fakes an es-AR browser before loading src/i18n.ts (as
// tests/i18n-es.test.mjs; node --test runs each file in its own process).
// Run: node --test tests/guest-name-es.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

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

globalThis.window = { navigator: { languages: ['es-AR'], language: 'es-AR' } };

const I = await import('../src/i18n.ts');
const N = await import('../src/ui/names.ts');

test('the page is Spanish', () => {
  assert.equal(I.language(), 'es');
});

test("playerName: a guest's wire name in Spanish, every other name as it is", () => {
  assert.equal(N.playerName('Invitado 4821'), 'Invitado 4821');
  for (const raw of ['Invitado 0123', 'Invitado 48210', 'invitado 4821', 'Guest 4821', 'Ana']) assert.equal(N.playerName(raw), raw, raw);
});

test("lobbyTitle: the server's default (the host's name) reads in Spanish; a typed title as it is", () => {
  assert.equal(N.lobbyTitle('Invitado 4821', 'Invitado 4821'), 'Sala de Invitado 4821');
  assert.equal(N.lobbyTitle('Ana', 'Ana'), 'Sala de Ana');
  assert.equal(N.lobbyTitle('Invitado 4821', 'Ana'), 'Sala de Ana');
  assert.equal(N.lobbyTitle('Los del barrio', 'Ana'), 'Los del barrio');
});

test("the guest's lines: PERFIL's, the plate's, the guest host's SETTINGS", () => {
  assert.equal(I.t('profile.guestLine', { name: N.playerName('Invitado 4821') }), 'Juegas como Invitado 4821, un nombre temporal. Con una cuenta eliges el tuyo.');
  assert.equal(I.t('home.guestRank'), 'Sin cuenta · Sin rango');
  assert.equal(I.t('custom.guestTitle'), 'Con una cuenta puedes ponerle nombre a tu sala.');
  assert.equal(I.t('error.lobby.name_reserved'), 'Ese nombre de sala no está permitido');
});
