// What the game never says, in English or Spanish (the Tablero plan §1.8 "Prohibido"): no shop words
// (cars are never bought, nothing is sold), no emoji in a translated text (icons are the SVG sprite
// of src/ui/components/icons.ts), modes named only by format (1v1, 2v2, 3v3: no "Pairs", "Tríos",
// "Mano a mano", no "N cars"), and no raw error codes in front of a player.
//
// The texts that still break a rule today are listed in KNOWN, each with the PR of the plan that
// rewrites it; that PR deletes its line. The list may only shrink: a listed key that no longer
// breaks the rule fails too (delete it), and a new offender fails at once.
// Run: node --test tests/i18n-copy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const en = (await import('../src/locales/en.ts')).default;
const es = (await import('../src/locales/es.ts')).default;

const RULES = {
  // Shop words: buy / sell / store / price / coins / offer (and "gold" as a currency in Spanish).
  shop: { en: /\b(?:buy|buying|bought|purchase\w*|shop\w*|store|stores|price\w*|coins?|offers?|sale|sell\w*)\b/i, es: /\b(?:compr\w*|tienda\w*|precio\w*|monedas?|ofertas?|rebaja\w*|vend\w*|dorad[oa]s?)\b/i },
  // Pictographic emoji (🔒 🌐 ⚙ ...): a translated text carries words, the icon is drawn.
  emoji: { en: /\p{Extended_Pictographic}/u, es: /\p{Extended_Pictographic}/u },
  // Modes by format only.
  modeNames: { en: /\b(?:one-on-one|pairs|trios)\b|\{count\} cars?\b|\b\d+ cars\b/i, es: /\b(?:mano a mano|parejas|tr[ií]os)\b|\{count\} autos?\b|\b\d+ autos\b/i },
  // Raw codes: an HTTP status or a close code in brackets, 1006 anywhere.
  rawCodes: { en: /\(\d{3,4}\b|\b1006\b/, es: /\(\d{3,4}\b|\b1006\b/ },
};

/** `${lang}:${key}:${rule}` -> the plan PR that rewrites the text. Only ever shrinks. */
const KNOWN = {
  'en:playlist.1v1:modeNames': 'PR 6 (modes by format)',
  'en:playlist.2v2:modeNames': 'PR 6',
  'en:playlist.3v3:modeNames': 'PR 6',
  'es:playlist.1v1:modeNames': 'PR 6',
  'es:playlist.2v2:modeNames': 'PR 6',
  'es:playlist.3v3:modeNames': 'PR 6',
  'en:play.playlistCars:modeNames': 'PR 6',
  'es:play.playlistCars:modeNames': 'PR 6',
  'en:play.accountLocked:emoji': 'PR 6 (the lock is the sprite icon)',
  'es:play.accountLocked:emoji': 'PR 6',
  'es:training.shotBreakaway:modeNames': 'PR 13 (training: the breakaway shot gets a name that is not a mode)',
};

const values = (v) => (typeof v === 'string' ? [v] : Object.values(v));

function offenders() {
  const out = new Set();
  for (const [lang, msgs] of [['en', en], ['es', es]]) {
    for (const [key, v] of Object.entries(msgs)) {
      for (const [rule, re] of Object.entries(RULES)) {
        if (values(v).some((text) => re[lang].test(text))) out.add(`${lang}:${key}:${rule}`);
      }
    }
  }
  return out;
}

test('no shop words, emoji, mode names or raw codes in a new text', () => {
  const found = offenders();
  const fresh = [...found].filter((k) => !(k in KNOWN));
  assert.deepEqual(fresh, [], 'a text breaks a copy rule (en.ts / es.ts)');
});

test('the known offenders are still offenders (delete a line once its PR rewrote the text)', () => {
  const found = offenders();
  const stale = Object.keys(KNOWN).filter((k) => !found.has(k));
  assert.deepEqual(stale, []);
});

test('the rules catch what they are for', () => {
  assert.ok(RULES.shop.es.test('Compra este auto en la tienda'));
  assert.ok(RULES.shop.en.test('Buy coins'));
  assert.ok(!RULES.shop.es.test('Las contraseñas no coinciden'));
  assert.ok(!RULES.shop.en.test('Restored your settings'));
  assert.ok(RULES.emoji.en.test('🔒 Account'));
  assert.ok(!RULES.emoji.en.test('SIGN IN · 1v1 › 2v2'));
  assert.ok(RULES.modeNames.es.test('Parejas 2v2'));
  assert.ok(RULES.modeNames.en.test('{playlist} · {count} cars'));
  assert.ok(!RULES.modeNames.es.test('los autos se sincronizan'));
  assert.ok(RULES.rawCodes.en.test('Connection lost (1006)'));
  assert.ok(!RULES.rawCodes.en.test('Server error ({status})'));
});
