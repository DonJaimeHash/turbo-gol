// The mail caps (src/mailCaps.ts; docs/online/MAIL.md, "Caps, lanes and failures"): every kind's
// lane, the day's cap and each lane's share of it, the per-address / network / account windows
// (an IPv4 address gets 20 times an IPv6 /64: schools, LAN parties, CGNAT), the sign-up pause and
// the email_off kill flag. Pure: no counter, no mail. Run from server/: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AT } from './mailSamples.mjs';

const C = await import('../src/mailCaps.ts');

test('lanes: sign-up mail, account mail and notices, each with its share of the day', () => {
  const lanes = Object.fromEntries(C.MAIL_KINDS.map((k) => [k, C.laneOf(k)]));
  assert.deepEqual(lanes, {
    verify_signup: 'signup',
    signup_exists: 'signup',
    reset: 'account',
    password_changed: 'notice',
    verify_email: 'account',
    email_changed: 'notice',
    email_in_use: 'account',
    provider_linked: 'notice',
    deletion_scheduled: 'notice',
    legacy_reminder: 'account',
    reauth_code: 'account',
    email_moved: 'notice',
  });
  assert.deepEqual(C.MAIL_KINDS.filter(C.isNotice), ['password_changed', 'email_changed', 'provider_linked', 'deletion_scheduled', 'email_moved']);
  const cap = C.dailyCap({});
  assert.equal(cap, 100);
  // At the default cap a flood of sign-ups stops at 60, resets and codes at 90, notices at 100.
  assert.equal(C.laneAllows('signup', 59, cap), true);
  assert.equal(C.laneAllows('signup', 60, cap), false);
  assert.equal(C.laneAllows('account', 60, cap), true);
  assert.equal(C.laneAllows('account', 90, cap), false);
  assert.equal(C.laneAllows('notice', 99, cap), true);
  assert.equal(C.laneAllows('notice', 100, cap), false);
  assert.equal(C.laneLimit('signup', 1000), 600);
  assert.equal(C.mailDay(AT), '2026-10-30');
});

test('dailyCap: EMAIL_DAILY_CAP as a positive integer, 100 otherwise', () => {
  assert.equal(C.dailyCap({ EMAIL_DAILY_CAP: 2400 }), 2400);
  assert.equal(C.dailyCap({ EMAIL_DAILY_CAP: ' 800 ' }), 800);
  for (const v of [undefined, '', 'abc', '0', 0, -5, '-5', 2.5, '2.5', '1e3', 5_000_000, NaN]) assert.equal(C.dailyCap({ EMAIL_DAILY_CAP: v }), C.DEFAULT_DAILY_CAP, String(v));
});

test('takeSlot: fixed hour and day windows; a refusal counts nothing', () => {
  const cap = C.MAIL_CAPS.recipient; // 5 an hour, 10 a day
  const H = 3_600_000;
  let row = null;
  let ok = 0;
  for (let i = 0; i < 7; i++) {
    const t = C.takeSlot(row, cap, AT + i * 1000);
    row = t.row;
    ok += t.ok ? 1 : 0;
  }
  assert.equal(ok, 5, '5 in the hour');
  assert.equal(row.hour_n, 5);
  for (let i = 0; i < 10; i++) {
    const t = C.takeSlot(row, cap, AT + H + i * 1000);
    row = t.row;
    if (t.ok) ok++;
  }
  assert.equal(ok, 10, 'the next hour opens, the day stops at 10');
  assert.equal(C.takeSlot(row, cap, AT + 23 * H).ok, false);
  assert.equal(C.takeSlot(row, cap, AT + 24 * H).ok, true, 'a new day');
  assert.deepEqual(C.MAIL_CAPS.notice, { day: 5 });
  assert.deepEqual(C.MAIL_CAPS.account, { day: 10 });
  assert.deepEqual(C.RESEND, { gapMs: 60_000, max: 3 });
});

test('network caps: an IPv4 address gets 20 times an IPv6 /64, so a classroom behind one address still gets its mail', () => {
  assert.deepEqual(C.networkCap('2001:db8:1:2::/64'), { hour: 10, day: 30 });
  assert.deepEqual(C.networkCap('203.0.113.7'), { hour: 200, day: 600 });
  assert.deepEqual(C.networkCap('local'), { hour: 200, day: 600 }, "wrangler dev's 'local' counts as one IPv4 address");
  let v4 = null;
  let n = 0;
  for (let i = 0; i < 250; i++) {
    const t = C.takeSlot(v4, C.networkCap('203.0.113.7'), AT + i);
    v4 = t.row;
    if (t.ok) n++;
  }
  assert.equal(n, 200);
});

test('failures: only the sign-up lane pauses itself; the others raise an ALERT, at most every 30 minutes', () => {
  assert.equal(C.pauseAfterFailures('signup', 9, AT), 0);
  assert.equal(C.pauseAfterFailures('signup', 10, AT), AT + 30 * 60_000);
  assert.equal(C.pauseAfterFailures('account', 50, AT), 0, 'a burst never stops resets');
  assert.equal(C.pauseAfterFailures('notice', 50, AT), 0);
  assert.equal(C.alertAfterFailures('account', 10, 0, AT), true);
  assert.equal(C.alertAfterFailures('account', 10, AT - 60_000, AT), false);
  assert.equal(C.alertAfterFailures('notice', 9, 0, AT), false);
  assert.equal(C.alertAfterFailures('signup', 99, 0, AT), false, 'the sign-up lane pauses instead');
});

test('the kill flag: KV email_off stops every lane; an unreadable KV counts as not set', async () => {
  assert.equal(C.MAIL_KILL_FLAG, 'email_off');
  const asked = [];
  for (const [v, want] of [['1', true], ['true', true], ['on', true], ['0', false], [null, false]]) {
    assert.equal(await C.mailKilled({ FLAGS: { get: async (k, o) => (asked.push([k, o?.cacheTtl]), v) } }), want, String(v));
  }
  assert.ok(asked.every(([k, ttl]) => k === 'email_off' && ttl === 60), 'one key, edge-cached 60 s');
  assert.equal(await C.mailKilled({ FLAGS: { get: async () => { throw new Error('down'); } } }), false);
});
