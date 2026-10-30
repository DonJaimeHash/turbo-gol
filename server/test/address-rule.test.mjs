// One rule for an address (sign-in PR 3's review): what the account code takes (src/net/account.ts
// normalizeEmail, which the Worker and the client share) the mailer sends to (src/mail.ts
// isOneRecipient), the apostrophe of O'Brien included (RFC 5322 atext), and what could add a second
// recipient or a header neither takes. Otherwise an address could be proved by nobody: accepted at
// sign-up, then never mailed its code. Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// The Worker's imports have no extension (wrangler bundles them): resolve them to .ts here.
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

const ACC = await import('../../src/net/account.ts');
const MAIL = await import('../src/mail.ts');

test('one address rule: every address normalizeEmail takes is one recipient for the mailer (the apostrophe of O\'Brien too); what could add a recipient or a header is refused by both', () => {
  const good = ["O'Brien@x.ie", 'ana.perez+tg@gmail.com', "a!#$%&'*+/=?^_`{|}~-z@sub.example.org", 'x@xn--bcher-kva.ch', 'Ana@Example.COM'];
  for (const v of good) {
    const n = ACC.normalizeEmail(v);
    assert.notEqual(n, null, v);
    assert.equal(MAIL.isOneRecipient(n), true, `${n}: the mailer takes what the account code takes`);
  }
  const bad = ['a,b@x.com', 'a@x.com,b@y.com', '<a@x.com>', 'a@x.com\r\nBcc: b@y.com', '"a"@x.com', 'a b@x.com', 'a;b@x.com', "a@x'.com", 'a@x.com>'];
  for (const v of bad) {
    assert.equal(ACC.normalizeEmail(v), null, v);
    assert.equal(MAIL.isOneRecipient(v), false, v);
  }
});
