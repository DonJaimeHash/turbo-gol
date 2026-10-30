// The Spanish page (src/locales/es.ts): Spanish players keep the lines the game showed before the
// translations, the Spanish server's own messages included (src/i18n.ts serverText keeps them for
// the codes the server details, SERVER_DETAIL_CODES; AccountClient and LobbyClient differ on purpose
// in the fallback they pass for a bare code). Outside a browser the page is English
// (tests/i18n.test.mjs), so this file fakes an es-AR browser before loading src/i18n.ts; node --test
// runs each test file in its own process, so no other file sees it.
// Run: node --test tests/i18n-es.test.mjs
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

// A browser whose language is es-AR, without storage: src/i18n.ts picks Spanish when it loads.
globalThis.window = { navigator: { languages: ['es-AR'], language: 'es-AR' } };

const I = await import('../src/i18n.ts');
const { NetError } = await import('../src/net/NetClient.ts');
const { netErrorText } = await import('../src/net/netErrorText.ts');
const P2P = await import('../src/net/p2p/P2PSession.ts');
const { ONLINE_STATUS } = await import('../src/render/Hud.ts');
const AC = await import('../src/net/AccountClient.ts');
const LC = await import('../src/net/LobbyClient.ts');

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
/** An error the Worker sends without a text (`error(status, code)`: the message is the code). */
const bare = (status, code) => res(status, { error: code, message: code });
const msg = (status, code, message, extra = {}) => res(status, { error: code, message, ...extra });

test('the page is Spanish', () => {
  assert.equal(I.language(), 'es');
});

test('serverText: the Spanish server message for the codes it details, else the es.ts text', () => {
  assert.equal(I.serverText('lobby', 'rate_limited', 'Creaste demasiadas salas, espera un minuto'), 'Creaste demasiadas salas, espera un minuto');
  assert.equal(I.serverText('lobby', 'rate_limited', ''), 'Demasiados intentos, espera un minuto', 'sent bare, no fallback: the es.ts text');
  assert.equal(I.serverText('account', 'bad_username', 'Elige un nombre de usuario'), 'Elige un nombre de usuario');
  assert.equal(I.serverText('lobby', 'bad_name', 'Configuración inválida'), 'Configuración inválida');
  assert.equal(I.serverText('lobby', 'not_host', 'Solo el anfitrión inicia la partida'), 'Solo el anfitrión inicia la partida');
  assert.equal(I.serverText('account', 'bad_credentials', 'otro texto'), 'Correo o contraseña incorrectos', 'not a detail code: es.ts (the email sign-in; the username one says it in AccountClient.legacySignIn)');
  assert.equal(I.serverText('lobby', 'bad_mode', 'Configuración inválida'), 'Configuración inválida', 'no client text: the server message');
});

test('AccountClient: a bare code gets its es.ts text, else the generic one (`|| error.server`)', async () => {
  const cases = [
    [bare(429, 'rate_limited'), 'Demasiados intentos, espera un minuto'],
    [msg(429, 'rate_limited', 'Demasiados registros desde tu red, inténtalo más tarde'), 'Demasiados registros desde tu red, inténtalo más tarde'],
    [msg(400, 'bad_username', 'El usuario tiene que tener entre 3 y 16 caracteres'), 'El usuario tiene que tener entre 3 y 16 caracteres'],
    [msg(401, 'bad_credentials', 'Usuario o contraseña incorrectos'), 'Usuario o contraseña incorrectos'], // the username sign-in's own text (sign-in PR 8)
    [msg(429, 'throttled', 'Demasiados intentos, espera un momento', { retryAfterMs: 5000 }), 'Demasiados intentos, espera un momento'],
    [msg(503, 'turnstile_unconfigured', 'TURNSTILE_SECRET must be set outside local dev'), 'TURNSTILE_SECRET must be set outside local dev'],
    [bare(400, 'bad_request'), 'Error del servidor'],
    [bare(401, 'unauthorized'), 'Error del servidor'],
    [{ ok: false, status: 502, json: async () => JSON.parse('<html>') }, 'Error del servidor'],
  ];
  for (const [answer, want] of cases) {
    const a = new AC.AccountClient({ fetchFn: async () => answer, storage: null });
    const e = await a.legacySignIn('Tomi', 'a fine password').then(() => null, (err) => err);
    assert.ok(e instanceof AC.AccountError);
    assert.equal(e.message, want);
  }
});

test('LobbyClient: a bare detail code keeps the generic text (`serverMessage || error.server`); socket refusals keep the server text', async () => {
  const http = [
    [bare(429, 'rate_limited'), 'Error del servidor'],
    [msg(429, 'rate_limited', 'Creaste demasiadas salas, espera un minuto'), 'Creaste demasiadas salas, espera un minuto'],
    [bare(503, 'matchmaking_off'), 'Error del servidor'],
    [bare(401, 'unauthorized'), 'Error del servidor'],
    [bare(400, 'bad_name'), 'Error del servidor'],
    [msg(403, 'bad_password', 'Contraseña incorrecta'), 'Contraseña incorrecta'],
    [msg(404, 'no_lobby', 'No existe una sala con ese código'), 'No existe una sala con ese código'],
  ];
  for (const [answer, want] of http) {
    const lc = new LC.LobbyClient({ fetchFn: async () => answer, webSocketFactory: () => ({}), bearer: async () => 'b' });
    const e = await lc.join('ABC234', null).then(() => null, (err) => err);
    assert.ok(e instanceof AC.AccountError);
    assert.equal(e.message, want);
  }
  const socket = [
    ['bad_name', 'Configuración inválida'],
    ['bad_mode', 'Configuración inválida'],
    ['busy', 'La partida ya empezó'],
    ['not_host', 'Solo el anfitrión puede expulsar jugadores'],
    ['bad_password', 'La contraseña puede tener de 1 a 32 caracteres'],
    ['member_busy', 'Tomi todavía está en otra partida'],
    ['team_full', 'Ese equipo está completo'],
    ['unknown', 'Mensaje desconocido'],
  ];
  let ws = null;
  const lc = new LC.LobbyClient({
    fetchFn: async () => res(200, { lobbyId: 'L', code: 'ABC234', ticket: 'T', wsUrl: 'ws://x/lobby/L' }),
    webSocketFactory: () => (ws = { send() {}, close() {} }),
    bearer: async () => 'b',
  });
  await lc.join('ABC234', null);
  const got = [];
  lc.onError = (_code, message) => got.push(message);
  for (const [code, message] of socket) ws.onmessage({ data: JSON.stringify({ t: 'error', code, message }) });
  assert.deepEqual(got, socket.map(([, message]) => message));
});

test('matchmaking lines: es.ts texts, the no-show wait in seconds below two minutes', () => {
  const server = (code, message, retryAfterMs = 0) => ({ code, message, retryAfterMs });
  assert.equal(netErrorText(new NetError('http', 'queue failed (503 matchmaking_off)', 503, server('matchmaking_off', 'matchmaking_off'))), 'La búsqueda de partidas está en pausa, inténtalo más tarde');
  assert.equal(netErrorText(new NetError('http', 'queue failed (429 rate_limited)', 429, server('rate_limited', 'rate_limited'))), 'Demasiados intentos, espera un minuto');
  assert.equal(netErrorText(new NetError('http', 'x', 403, server('account_required', 'Inicia sesión para jugar Competitivo'))), 'Inicia sesión para jugar Competitivo');
  assert.equal(netErrorText(new NetError('turnstile', 'x', 503, server('turnstile_unconfigured', 'TURNSTILE_SITEKEY ...'))), 'Verificación anti-bots no configurada en el servidor, inténtalo más tarde');
  assert.equal(netErrorText(new NetError('turnstile', 'turnstile error 300030')), 'Falló la verificación anti-bots, inténtalo de nuevo');
  assert.equal(netErrorText(new NetError('http', 'x', 410, server('left', 'you left this match (its bots drive your car): queue again'))), 'Error del servidor');
  assert.equal(netErrorText(new NetError('network', 'queue request failed: TypeError')), 'No hay conexión con el servidor');
  const noShow = (left) => `Partidas P2P bloqueadas ${left}: dejaste varias salas sin conectarte (las partidas en servidor siguen disponibles)`;
  assert.equal(P2P.noShowStatus(42_100), noShow('43 s'));
  assert.equal(P2P.noShowStatus(90_000), noShow('90 s'));
  assert.equal(P2P.noShowStatus(119_000), noShow('119 s'));
  assert.equal(P2P.noShowStatus(120_000), noShow('2 min'));
  assert.equal(P2P.noShowStatus(299_500), noShow('5 min'));
});

test('status lines: the Spanish of before (three dots on the server search, the ellipsis on P2P)', () => {
  assert.equal(I.t('online.queue'), 'Buscando partido...');
  assert.equal(I.t('online.queueWaiting', { count: 1 }), 'Buscando partido... (1 esperando)');
  assert.equal(I.t('online.connecting'), 'Conectando...');
  assert.equal(ONLINE_STATUS.verifying, 'Verificando que eres humano…');
  assert.equal(P2P.queueStatus(2), 'Buscando rival (2 esperando)…');
  assert.equal(P2P.STATUS.queue, 'Buscando rival…');
  assert.equal(P2P.STATUS.serverAnswer, 'Sin rivales P2P ahora: partida en servidor');
  assert.equal(P2P.STATUS.reload, 'Hay una versión nueva del juego: recarga la página');
});

test('match banners and toasts: the Spanish Game.ts wrote before the translations', () => {
  assert.equal(I.t('game.playerDisconnected', { name: 'Pepe' }), 'Pepe se desconectó');
  assert.equal(I.t('game.botTakeover'), 'Su auto pasa a la IA');
  assert.equal(I.t('game.resultWin', { team: I.t('game.teamBlue'), result: '2 – 1' }), 'Ganó Azul  ·  2 – 1');
  assert.equal(I.t('game.resultDraw', { result: '1 – 1' }), 'Empate  ·  1 – 1');
  // The player chose the name on the confirm sheet (sign-in PR 6): nothing to change in the profile.
  assert.equal(I.t('game.welcomeNew', { name: 'Pepe' }), '¡Te damos la bienvenida, Pepe!');
  assert.equal(I.t('game.accountLinked'), 'Cuenta vinculada');
  assert.equal(I.t('profile.hello', { name: 'Pepe' }), 'Hola, Pepe');
  assert.equal(I.t('game.guestName'), 'Invitado');
});

test('HUD and controls: Spanish labels, key names kept as they are', async () => {
  const { ACTION_ROWS } = await import('../src/input/bindings.ts');
  assert.equal(ACTION_ROWS.find((r) => r.action === 'throttle').label, 'Acelerar');
  assert.equal(I.t('hud.go'), '¡YA!');
  // Nothing but QUIT leaves a match: the line names only the keys that resume (B among them).
  assert.equal(I.t('pause.hint', { resumeKeys: 'Esc / Start / B' }), 'Esc / Start / B o clic para reanudar');
  assert.equal(I.t('pause.hintDefault', { resumeKeys: 'Esc / Start / B' }), 'Esc / Start / B para reanudar');
  assert.equal(I.t('menu.leaveTitle', { game: 'Turbogol' }), '¿Salir de Turbogol?');
  assert.equal(I.t('controls.tagFirst'), 'TU PRIMER PARTIDO');
  assert.equal(I.t('controls.change', { tab: I.t('settings.tabKbm') }), 'Cámbialos en Configuración › Teclado y mouse');
  assert.equal(I.t('trainingHud.attempts', { count: 1 }), '1 intento');
  assert.equal(I.t('trainingHud.attempts', { count: 3 }), '3 intentos');
});

test('es.ts is neutral Spanish: tú, no voseo (podés, elegí, creá, sos, vos)', async () => {
  const es = (await import('../src/locales/es.ts')).default;
  const texts = Object.values(es).flatMap((v) => (typeof v === 'string' ? [v] : Object.values(v)));
  // Voseo: present tense in -ás / -és / -ís (podés, tenés, elegís) and imperatives in -á / -é / -í
  // (creá, hacé, elegí); the few standard words with those endings are allowed (a future in the
  // third person too: the owner's "No podrá volver a esta sala").
  const allowed = new Set(['está', 'estás', 'más', 'demás', 'también', 'qué', 'así', 'aquí', 'sí', 'después', 'según', 'aún', 'esté', 'guardé', 'atrás', 'país', 'inglés', 'podrá']);
  const bad = [];
  for (const text of texts) {
    for (const m of text.matchAll(/(?<![\p{L}])(\p{L}+(?:á|é|í|ás|és|ís))(?![\p{L}])/gu)) {
      if (!allowed.has(m[1].toLowerCase())) bad.push(m[1] + ' in "' + text + '"');
    }
    for (const m of text.matchAll(/(?<![\p{L}])(vos|sos)(?![\p{L}])/giu)) bad.push(m[1] + ' in "' + text + '"');
  }
  assert.deepEqual(bad, []);
});
