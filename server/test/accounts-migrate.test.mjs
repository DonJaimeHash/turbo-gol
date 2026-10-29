// The sign-in work's shared email and name helpers (src/net/account.ts, the design's sections 1.4
// and 5.2), pinned by vectors: the Worker and the client import the same functions, and changing a
// rule later would split or merge accounts. Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const DO_STUB = 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return { url: DO_STUB, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative && err && err.code === 'ERR_MODULE_NOT_FOUND') {
        if (!/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
        if (specifier.endsWith('.js')) return nextResolve(specifier.slice(0, -3) + '.ts', context);
      }
      throw err;
    }
  },
});

const ACC = await import('../../src/net/account.ts');

// ---- the shared helpers (src/net/account.ts): vectors the Worker and the client must keep -------------

test('normalizeEmail: trimmed and lowercased; one @; an atext local part of 1-64; ASCII labels with a dot; punycode for an IDN; no dead top-level domains; 254 at most', () => {
  const local64 = 'l'.repeat(64);
  const domain189 = 'a'.repeat(63) + '.' + 'b'.repeat(63) + '.' + 'c'.repeat(57) + '.com';
  const ok = [
    [' Ana.Perez+TG@GMail.COM ', 'ana.perez+tg@gmail.com'],
    ['a@b.co', 'a@b.co'],
    ['user@sub.example.com', 'user@sub.example.com'],
    ["O'Brien@x.ie", "o'brien@x.ie"],
    ['\tana@x.com\r\n', 'ana@x.com'],
    ['x@xn--80ak6aa92e.com', 'x@xn--80ak6aa92e.com'],
    ['x@domain.xn--p1ai', 'x@domain.xn--p1ai'],
    ['a-b_c=d?e{f}|~!#$%&*/^`@my-mail.com.ar', 'a-b_c=d?e{f}|~!#$%&*/^`@my-mail.com.ar'],
    [local64 + '@x.com', local64 + '@x.com'],
    [local64 + '@' + domain189, local64 + '@' + domain189],
  ];
  for (const [input, out] of ok) assert.equal(ACC.normalizeEmail(input), out, input);
  assert.equal((local64 + '@' + domain189).length, 254);
  const refused = [
    '', '   ', 'ana', 'ana@', '@gmail.com', 'ana@@gmail.com', 'a@b@c.com', 'ana@gmail', 'ana@gmail.', 'ana@.gmail.com', 'ana@gmail..com',
    'ana perez@gmail.com', '"ana"@gmail.com', 'an\\a@gmail.com', 'ana@gmaíl.com', 'ñandú@gmail.com', 'ana@foo.test', 'ana@foo.invalid',
    'ana@foo.example', 'ana@localhost', 'ana@x.localhost', 'ana@-x.com', 'ana@x-.com', 'ana@1.2.3.4', 'ana@x.c', 'ana@x.c0m',
    '.ana@gmail.com', 'ana.@gmail.com', 'an..a@gmail.com', 'a<b@gmail.com', 'a>b@x.com', 'a,b@gmail.com', 'a(b)@gmail.com', 'a;b@x.com',
    'a:b@x.com', '[a]@x.com', 'ana@x\n.com', 'an\u0000a@x.com', 'ana@x.com\r\nBcc: z@z.com','l'.repeat(65) + '@x.com', local64 + '@' + domain189.replace('c'.repeat(57), 'c'.repeat(58)),
    'ana@' + 'a'.repeat(64) + '.com', 'ana@x_y.com',
  ];
  for (const input of refused) assert.equal(ACC.normalizeEmail(input), null, JSON.stringify(input));
  for (const v of [null, undefined, 5, {}, ['a@b.com']]) assert.equal(ACC.normalizeEmail(v), null, String(v));
});

test('emailCanon: +tag dropped, googlemail.com is gmail.com, a gmail local part without its dots; null for what is not an address', () => {
  const vectors = [
    ['Ana.Perez+tg@GoogleMail.com', 'anaperez@gmail.com'],
    ['a.n.a@gmail.com', 'ana@gmail.com'],
    ['ana+1@gmail.com', 'ana@gmail.com'],
    ['ana+1+2@gmail.com', 'ana@gmail.com'],
    ['a.b@googlemail.com', 'ab@gmail.com'],
    ['ana.perez+x+y@outlook.com', 'ana.perez@outlook.com'],
    ['ANA@Hotmail.com', 'ana@hotmail.com'],
    ['a.b@mail.gmail.com', 'a.b@mail.gmail.com'],
    ['a.b@gmail.com.ar', 'a.b@gmail.com.ar'],
    ['+tag@x.com', '+tag@x.com'],
    [' juan@x.com ', 'juan@x.com'],
  ];
  for (const [input, out] of vectors) assert.equal(ACC.emailCanon(input), out, input);
  for (const v of ['nope', '', 'a@b', null, 7]) assert.equal(ACC.emailCanon(v), null, String(v));
});

test('maskEmail: at most two characters of the local part, never half of it; the domain in full', () => {
  const vectors = [
    ['ana.perez@gmail.com', 'an***@gmail.com'],
    ['Ana@X.com', 'a***@x.com'],
    ['ab@x.com', 'a***@x.com'],
    ['a@x.com', '***@x.com'],
    ['juan+tg@outlook.com', 'ju***@outlook.com'],
    ['nope', ''],
  ];
  for (const [input, out] of vectors) assert.equal(ACC.maskEmail(input), out, input);
});

test('emailTypo: the common domain typos and their fix; null when there is none', () => {
  const vectors = [
    ['ana@gmial.com', 'ana@gmail.com'],
    ['Ana@GMAIL.CON', 'ana@gmail.com'],
    ['x@gmal.com', 'x@gmail.com'],
    ['x@gmail.co', 'x@gmail.com'],
    ['x@hotmial.com', 'x@hotmail.com'],
    ['x@hotmal.com', 'x@hotmail.com'],
    ['x@outlok.com', 'x@outlook.com'],
    ['x@yahoo.con', 'x@yahoo.com'],
    ['ana@gmail.com', null],
    ['x@mygmial.com', null],
    ['nope', null],
  ];
  for (const [input, out] of vectors) assert.equal(ACC.emailTypo(input), out, input);
});

test('nameSkeleton: lowercase, _ . - dropped, the stand-ins, rn→m and vv→w', () => {
  const vectors = [
    ['Adm1n', 'admin'],
    ['B0t', 'bot'],
    ['lnvitado', 'invitado'],
    ['Invitado4821', 'invitadoab2i'],
    ['Soporte_TG', 'soportetg'],
    ['Ana_Admin', 'anaadmin'],
    ['rnoderator', 'moderator'],
    ['vvizard', 'wizard'],
    ['Juan_1', 'juani'],
    ['Juani', 'juani'],
    ['T0rboG0l', 'torbogoi'],
    ['Ana.B-7', 'anabt'],
    ['5teve', 'steve'],
    ['3lla', 'eiia'],
  ];
  for (const [input, out] of vectors) assert.equal(ACC.nameSkeleton(input), out, input);
});
