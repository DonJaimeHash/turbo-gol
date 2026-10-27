// Inicio's decisions (plan PR 5; src/ui/screens/homeModel.ts, src/ui/prefs.ts, src/ui/howPlay.ts):
// the hero's state in priority order, the queue JUGAR AHORA repeats and where it is stored, when
// the game counts as offline, the subtitle and the two-line titles, who is asked "How will you
// play?", the bindings that make a player a returning one, the copy the owner chose, and how a
// TV's subtitle gives way.
//   node --test tests/home-hero.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

const M = await import('../src/ui/screens/homeModel.ts');
const P = await import('../src/ui/prefs.ts');
const HP = await import('../src/ui/howPlay.ts');
const B = await import('../src/input/bindings.ts');
const en = (await import('../src/locales/en.ts')).default;
const es = (await import('../src/locales/es.ts')).default;

const QUEUE = { kind: 'casual', modes: ['2v2'], region: null, net: 'p2p' };
const SEARCH = { kind: 'ranked', modes: ['1v1', '3v3'], region: 'EU', since: 1234 };
const LOBBY = { code: 'ABC234', count: 2, max: 4 };
const REJOIN = { kind: 'casual', modes: ['2v2'], leftMs: 192_000 };

test('the hero: new version > back to your match > back to the lobby > searching > offline > play, for all 32 combinations', () => {
  const order = ['update', 'rejoin', 'lobby', 'search', 'offline'];
  for (let bits = 0; bits < 32; bits++) {
    const on = (i) => (bits & (1 << i)) !== 0;
    const input = { updateNeeded: on(0), rejoin: on(1) ? REJOIN : null, lobby: on(2) ? LOBBY : null, search: on(3) ? SEARCH : null, offline: on(4), queue: QUEUE };
    const want = order.find((_, i) => on(i)) ?? 'play';
    assert.equal(M.heroState(input).kind, want, `bits ${bits.toString(2).padStart(5, '0')}`);
  }
  const base = { updateNeeded: false, rejoin: null, lobby: null, search: null, offline: false, queue: QUEUE };
  const s = M.heroState({ ...base, search: SEARCH });
  assert.equal(s.search.since, 1234);
  assert.deepEqual(s.search.modes, ['1v1', '3v3']);
  assert.equal(s.search.region, 'EU');
  const l = M.heroState({ ...base, lobby: LOBBY });
  assert.deepEqual(l.lobby, { code: 'ABC234', count: 2, max: 4 });
  assert.deepEqual(M.heroState({ ...base, lobby: { code: 'XYZ999', count: null, max: null } }).lobby, { code: 'XYZ999', count: null, max: null }, 'before the first state message');
  assert.deepEqual(M.heroState(base).queue, QUEUE);
  assert.equal(M.heroState({ ...base, rejoin: REJOIN }).rejoin.leftMs, 192_000);
});

test('heroQueue: Casual 2v2 automatic P2P the first time; Competitive only signed in and not banned', () => {
  const d = P.parsePrefs(null);
  assert.deepEqual(M.heroQueue(d, false, false), { kind: 'casual', modes: ['2v2'], region: null, net: 'p2p' });
  const ranked = { ...d, lastQueue: 'ranked', rankedModes: ['3v3'], region: 'SA' };
  assert.deepEqual(M.heroQueue(ranked, true, false), { kind: 'ranked', modes: ['3v3'], region: 'SA', net: 'server' });
  assert.equal(M.heroQueue(ranked, false, false).kind, 'casual', 'a guest');
  assert.equal(M.heroQueue(ranked, true, true).kind, 'casual', 'banned for abandons');
  const casual = { ...d, casualModes: ['1v1', '3v3'], net: 'server' };
  assert.deepEqual(M.heroQueue(casual, true, false), { kind: 'casual', modes: ['1v1', '3v3'], region: null, net: 'server' });
});

test('parsePrefs: defaults for nothing or junk, lastQueue kept only as ranked, an old v1 object keeps the rest', () => {
  for (const raw of [null, '', '{', '[]', 'null', '42']) {
    const p = P.parsePrefs(raw);
    assert.equal(p.lastQueue, 'casual', String(raw));
    assert.deepEqual(p.casualModes, ['2v2']);
    assert.equal(p.region, null);
    assert.equal(p.net, 'p2p');
  }
  assert.equal(P.parsePrefs(JSON.stringify({ lastQueue: 'x' })).lastQueue, 'casual');
  assert.equal(P.parsePrefs(JSON.stringify({ lastQueue: 'ranked' })).lastQueue, 'ranked');
  const old = P.parsePrefs(JSON.stringify({ region: 'EU', casualModes: ['1v1', '2v2'], rankedModes: ['3v3'], net: 'server', leaderboardPlaylist: '3v3' }));
  assert.deepEqual(old, { region: 'EU', casualModes: ['1v1', '2v2'], rankedModes: ['3v3'], net: 'server', leaderboardPlaylist: '3v3', lastQueue: 'casual' });
  assert.equal(P.PREFS_KEY, 'turbogol.menu.v1', 'the same key: no migration');
  // Each parse is a fresh object: a change to one never reaches the defaults.
  P.parsePrefs(null).casualModes.push('3v3');
  assert.deepEqual(P.parsePrefs(null).casualModes, ['2v2']);
});

test('isOffline: still connecting is not; one failed population poll is not; two are, and so is no Worker', () => {
  assert.equal(M.isOffline(null, 5), false);
  assert.equal(M.isOffline({ online: true }, 0), false);
  assert.equal(M.isOffline({ online: true }, 1), false);
  assert.equal(M.isOffline({ online: true }, 2), true);
  assert.equal(M.isOffline({ online: false }, 0), true);
});

test('queueParts: the kind and the formats, the region apart; the separators', () => {
  const names = { casual: es['play.casualTitle'], ranked: es['play.rankedTitle'] };
  assert.deepEqual(M.queueParts('casual', ['2v2'], 'Sudamérica', names), { queue: 'Casual · 2v2', region: 'Sudamérica' });
  assert.equal(M.queueParts('casual', ['2v2'], null, names).region, null);
  assert.equal(M.queueParts('casual', ['1v1', '2v2'], null, names).queue, 'Casual · 1v1 · 2v2');
  assert.equal(M.queueParts('ranked', ['2v2'], null, names).queue, 'Competitivo · 2v2');
  assert.equal(M.HERO_SEP, ' · ');
  assert.equal(M.HERO_SEP_TV, ' - ');
});

test('subParts: a two-part subtitle at its last separator (the offline hero), one part without one', () => {
  assert.deepEqual(M.subParts(es['modes.vsAiSub']), { queue: 'Partido de 3 min', region: 'sin conexión' });
  assert.deepEqual(M.subParts(en['modes.vsAiSubShort']), { queue: '3 min', region: 'offline' });
  assert.deepEqual(M.subParts('A · B · C'), { queue: 'A · B', region: 'C' });
  assert.deepEqual(M.subParts(es['update.title']), { queue: es['update.title'], region: null });
  for (const msgs of [en, es]) for (const k of ['modes.vsAiSub', 'modes.vsAiSubShort']) assert.notEqual(M.subParts(msgs[k]).region, null, k);
});

test('twoLines: split at the most balanced space; one word stays', () => {
  assert.equal(M.twoLines('JUGAR AHORA'), 'JUGAR\nAHORA');
  assert.equal(M.twoLines('PLAY'), 'PLAY');
  const t = M.twoLines('VOLVER A LA SALA');
  const lines = t.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.length > 0));
  const longest = Math.max(...lines.map((l) => l.length));
  const words = 'VOLVER A LA SALA'.split(' ');
  for (let k = 1; k < words.length; k++) {
    const other = Math.max(words.slice(0, k).join(' ').length, words.slice(k).join(' ').length);
    assert.ok(longest <= other, `split ${k}`);
  }
});

test('plateRank: the best placed rating by MMR, none while placing', () => {
  assert.equal(M.plateRank(null), null);
  assert.equal(M.plateRank({ ratings: [{ playlist: '2v2', mmr: 1500, tier: null }] }), null);
  assert.deepEqual(
    M.plateRank({ ratings: [{ playlist: '1v1', mmr: 900, tier: 'silver' }, { playlist: '2v2', mmr: 1200, tier: 'gold' }, { playlist: '3v3', mmr: 2000, tier: null }] }),
    { tier: 'gold', playlist: '2v2' },
  );
  assert.equal(M.DEFAULT_CAR_NAME, 'Dune');
});

test('howPlayAsk: only a new PC player, by mouse or keyboard; a pad press answers by itself', () => {
  const pc = { tv: false, layout: 'pc', touch: false, input: 'keyboard', answered: false, returning: false };
  assert.equal(HP.howPlayAsk(pc), 'ask');
  assert.equal(HP.howPlayAsk({ ...pc, layout: 'short', input: 'mouse' }), 'ask');
  assert.equal(HP.howPlayAsk({ ...pc, input: 'pad' }), 'pad');
  assert.equal(HP.howPlayAsk({ ...pc, tv: true, layout: 'tv', input: 'remote' }), 'no');
  for (const layout of ['phone', 'portrait', 'tablet', 'tv']) assert.equal(HP.howPlayAsk({ ...pc, layout }), 'no', layout);
  assert.equal(HP.howPlayAsk({ ...pc, touch: true }), 'no');
  assert.equal(HP.howPlayAsk({ ...pc, answered: true }), 'no');
  assert.equal(HP.howPlayAsk({ ...pc, returning: true }), 'no');
  assert.equal(HP.howPlayAsk({ ...pc, returning: true, input: 'pad' }), 'no', 'a returning pad player: nothing stored');
  assert.equal(HP.HOW_PLAY_KEY, 'turbogol.howPlay.v1');
});

test('the bindings that make a returning player, and the mouse player the pointer-lock hint is for', () => {
  assert.equal(B.kbmCustomised(B.DEFAULT_KBM), false);
  assert.equal(B.kbmCustomised(B.KEYBOARD_ONLY_KBM), true);
  assert.equal(B.kbmCustomised({ ...B.DEFAULT_KBM, ballCam: { kind: 'key', code: 'KeyV' } }), true);
  assert.equal(B.kbmCustomised({ ...B.DEFAULT_KBM, jump: { kind: 'mouse', button: 2 } }), false, 'an equal binding, another object');
  assert.equal(B.usesMouseButton(B.DEFAULT_KBM), true);
  assert.equal(B.usesMouseButton(B.KEYBOARD_ONLY_KBM), false, 'its mouse look is an axis, not a button');
});

const NEW_KEYS = [
  'home.playNow', 'home.playNowTv', 'home.alwaysMatch', 'home.searching', 'home.backToLobby', 'home.lobbySub', 'home.rejoin', 'home.rejoinSub',
  'home.guestRank', 'home.unranked', 'home.carLine', 'home.plateProfile', 'home.plateGarage',
  'modes.casual', 'modes.casualSub', 'modes.casualSubShort', 'modes.friends', 'modes.friendsSub', 'modes.friendsSubShort', 'modes.friendsSubTv', 'modes.lobbies',
  'modes.vsAi', 'modes.vsAiSub', 'modes.vsAiSubShort', 'modes.vsAiSlot', 'modes.ranked', 'modes.rankedSub', 'modes.rankedSubShort',
  'modes.signInShort', 'tv.needPad', 'tv.needPadText', 'tv.needPadGo', 'howPlay.title', 'howPlay.kbm', 'howPlay.keyboard', 'howPlay.pad', 'lang.reloadNote', 'lang.heading',
];

test("the owner's copy: JUGAR AHORA / JUGAR, Iniciar sesión, partidas de ubicación, the reload note; no reassurance lines", () => {
  assert.equal(es['home.playNow'], 'JUGAR AHORA');
  assert.equal(es['home.playNowTv'], 'JUGAR');
  assert.equal(es['menu.guestSignIn'], 'Iniciar sesión');
  assert.ok(es['modes.signInShort'].length < es['menu.guestSignIn'].length, 'the lock tag of a narrow tile is shorter');
  assert.equal(es['lang.heading'], es['lang.heading'].toUpperCase(), "PERFIL's headings are in capitals");
  assert.match(es['modes.rankedSub'], /partidas de ubicación/);
  assert.equal(es['lang.reloadNote'], 'El juego se recarga (unos segundos)');
  for (const [lang, msgs] of [['en', en], ['es', es]]) {
    for (const [k, v] of Object.entries(msgs)) {
      if (!/^(?:home|modes|tv|howPlay)\./.test(k)) continue;
      for (const text of typeof v === 'string' ? [v] : Object.values(v)) assert.doesNotMatch(text, /Gratis para todos|bots completan|Free for everyone|bots fill/i, `${lang}:${k}`);
    }
  }
  for (const k of NEW_KEYS) {
    assert.equal(typeof en[k], 'string', 'en ' + k);
    assert.equal(typeof es[k], 'string', 'es ' + k);
  }
  assert.equal(typeof en['nav.modes'], 'string', 'MODOS stays for PR 6');
});

test("a TV's subtitle never goes under the floor: its region steps aside, the formats go under the kind, then ✕ CANCEL's label and room", async () => {
  const tile = await readFile(new URL('../src/ui/components/tile.ts', import.meta.url), 'utf8');
  assert.match(tile, /\{ 'data-fit': '16', 'data-fit-scope': '\.mn-hero' \}/, "the TV's 16, searching too; the hero is its scope");
  assert.match(tile, /h\('span\.mn-hero-split', \{ 'data-fit-give': '1' \}, HERO_SEP\), h\('span\.mn-hero-formats'/);
  assert.match(tile, /const lastGive = o\.oneLine \? \{ 'data-fit-give': '2' \} : null;/);
  assert.match(tile, /icon\('close'\), h\('span', lastGive, t\('lang\.cancel'\)\)/);
  assert.match(tile, /h\('span\.mn-hero-room', lastGive\)/);
  const css = await readFile(new URL('../src/ui/styles/screens/home.css', import.meta.url), 'utf8');
  assert.match(css, /\.mn-hero-split\[data-fit-gone\] \+ \.mn-hero-formats \{\s*display: block;/);
});
