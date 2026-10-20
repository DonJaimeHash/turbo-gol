// The operations side of the community nodes, without workerd: the ALERT webhook
// (server/src/nodeAlerts.ts: the Discord message, its escaping, one post per alert in 10 minutes,
// the burst limit, failures kept out of the logs' ALERT lines) on a fake fetch, and what the
// NodeRegistryDO watches (server/src/nodeWatch.ts: a trusted node offline, traffic near its cap,
// tick lag, a verification or an update waiting too long, and the cron's /healthz probe of a node,
// TLS and network errors included) on plain node records. Run from server/: npm test
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
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

const AL = await import('../src/nodeAlerts.ts');
const W = await import('../src/nodeWatch.ts');
const { generateEd25519, importPrivateKey, sign } = await import('../../nodes/shared/edcrypto.ts');
const { reachMessage } = await import('../../nodes/shared/controlProtocol.ts');

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOOK = 'https://discord.test/api/webhooks/1/secret-token';
const KEYS = await generateEd25519();
const NODE_KEY = await importPrivateKey(KEYS.privateKey);

/** A node record as the Registry keeps it (the fields the watch reads). */
const rec = (over = {}) => ({
  nodeId: '0123456789abcdef',
  name: 'sao-paulo-1',
  operatorId: 'a1b2c3d4e5f60718',
  operatorName: 'Proyecto',
  trusted: true,
  status: 'active',
  online: true,
  lastSeen: NOW,
  roles: ['host', 'verify'],
  transports: ['wss'],
  publicUrl: 'wss://sp1.turbo-gol.test',
  publicKey: KEYS.publicKey,
  bootId: 'boot-1',
  build: { version: '0.2.0', protocol: 1, wasmSha256: 'a'.repeat(64) },
  egressGB: 0,
  egressCapGB: null,
  tickLagP99Ms: 1,
  draining: false,
  ...over,
});

/** A fake fetch: `answer(url, init)` gives the Response (or throws); `calls` records each request. */
function fakeFetch(answer = () => new Response(null, { status: 204 })) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return answer(url, init);
  };
  f.calls = calls;
  return f;
}

/** An AlertHook on a fake fetch and clock; `settle()` waits for the posts it started. */
function hook(over = {}) {
  const waits = [];
  const logs = [];
  const h = { now: NOW, waits, logs, fetch: fakeFetch() };
  h.hook = new AL.AlertHook({ url: HOOK, waitUntil: (p) => waits.push(p), fetch: (u, i) => h.fetch(u, i), now: () => h.now, log: (m) => logs.push(m), ...over });
  h.settle = async () => {
    while (waits.length > 0) await Promise.all(waits.splice(0));
  };
  return h;
}

const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ---- the webhook ---------------------------------------------------------------------------------

test('alertKey: lines that differ only in counts, times or long hex ids are one alert; node names keep their digits', () => {
  const k = AL.alertKey;
  assert.equal(k('ALERT outbox /release for match abcd1234 (mm:SA) undelivered for a day, 3 tries'), k('ALERT outbox /release for match 9f8e7d6c (mm:SA) undelivered for a day, 14 tries'));
  assert.equal(k('ALERT sweep failed: Error: no answer in 0.2 s'), k('ALERT sweep failed: Error: no answer in 10 s'));
  assert.notEqual(k('ALERT trusted node sp1 (0123456789abcdef) offline for 3 min'), k('ALERT trusted node sp2 (0123456789abcdef) offline for 3 min'));
  assert.notEqual(k('ALERT node sao-paulo-1 unreachable at wss://a.test: timeout'), k('ALERT node sao-paulo-2 unreachable at wss://a.test: timeout'));
  assert.equal(k('ALERT node sao-paulo-1 has sent 850.0 GB of its 1000 GB monthly cap (85 %)'), k('ALERT node sao-paulo-1 has sent 912.5 GB of its 1000 GB monthly cap (91 %)'));
  assert.notEqual(k('ALERT node sp1: tick lag'), k('ALERT node sp1: egress'));
});

test('the message: the line in one code span, nothing a node sent read as markdown, a mention or a link; cut to 1900 characters', () => {
  const hostile = 'ALERT node evil`**@everyone** [click](https://evil.example) <@123>\u202e\u200b\nALERT forged line\r\n`';
  const c = AL.alertContent(hostile);
  assert.ok(c.startsWith('**ALERT** `'), c);
  assert.ok(c.endsWith('`'), c);
  assert.equal(c.split('`').length - 1, 2, 'one code span: no backtick of the line is left to close it');
  assert.ok(!/[\n\r\u202e\u200b]/.test(c), 'one line, no bidi override, no zero-width character');
  assert.match(c, /evil'\*\*@everyone\*\* \[click\]\(https:\/\/evil\.example\) <@123> ALERT forged line '/, 'quoted as it is, inside the span');
  const long = AL.alertContent('ALERT ' + 'x'.repeat(5000), '(2 more ALERT lines only in the Worker\'s logs)');
  assert.ok(long.length <= AL.ALERT_MAX_CHARS, String(long.length));
  assert.ok(long.endsWith("…`\n(2 more ALERT lines only in the Worker's logs)"), 'the span is closed after the cut, the note follows it');
  const emoji = AL.alertContent('ALERT ' + '😀'.repeat(2000));
  assert.ok(emoji.length <= AL.ALERT_MAX_CHARS);
  assert.ok(!lone.test(emoji), 'never half a character');
  assert.equal(AL.alertContent('ALERT '), '**ALERT** `-`', 'an empty span would show its backticks');
  assert.equal(AL.codeSafe('a`b', 10), "a'b");
});

test('a post: through waitUntil, no mention and no embed allowed; without a webhook nothing is posted', async () => {
  const h = hook();
  assert.equal(h.hook.post('ALERT trusted node sp1 offline'), true);
  assert.equal(h.fetch.calls.length, 1, 'started at once, its end left to waitUntil');
  assert.equal(h.waits.length, 1);
  await h.settle();
  const [c] = h.fetch.calls;
  assert.equal(c.url, HOOK);
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers['content-type'], 'application/json');
  assert.deepEqual(c.body, { content: '**ALERT** `trusted node sp1 offline`', allowed_mentions: { parse: [] }, flags: 4 });
  assert.deepEqual(h.logs, []);
  const none = hook({ url: undefined });
  assert.equal(none.hook.post('ALERT x'), false);
  assert.equal(none.fetch.calls.length, 0);
  assert.equal(none.waits.length, 0);
});

test('the same alert at most once in 10 minutes, whatever its numbers; an explicit key is its own alert', async () => {
  const h = hook();
  assert.equal(h.hook.post('ALERT outbox /release for match abcd1234 undelivered for a day, 3 tries'), true);
  assert.equal(h.hook.post('ALERT outbox /release for match 9f8e7d6c undelivered for a day, 4 tries'), false, 'the same alert');
  assert.equal(h.hook.post('ALERT node sp1 lag', 'lag:a'), true);
  assert.equal(h.hook.post('ALERT node sp1 lag', 'lag:b'), true, 'another key');
  h.now += AL.ALERT_DEDUPE_MS - 1;
  assert.equal(h.hook.post('ALERT outbox /release for match abcd1234 undelivered for a day, 9 tries'), false);
  h.now += 1;
  assert.equal(h.hook.post('ALERT outbox /release for match abcd1234 undelivered for a day, 9 tries'), true, '10 minutes later');
  await h.settle();
  assert.equal(h.fetch.calls.length, 4);
});

test('at most 5 posts a minute (Discord takes 5 a webhook in 2 s): the rest stay in the logs and the next post counts them', async () => {
  const h = hook();
  assert.equal(AL.ALERT_BURST, 5);
  for (let i = 0; i < AL.ALERT_BURST + 2; i++) h.hook.post(`ALERT node n${i} offline`);
  assert.equal(h.fetch.calls.length, AL.ALERT_BURST);
  h.now += MIN;
  h.hook.post('ALERT node n99 offline');
  await h.settle();
  assert.equal(h.fetch.calls.length, AL.ALERT_BURST + 1);
  assert.equal(h.fetch.calls.at(-1).body.content, "**ALERT** `node n99 offline`\n(2 more ALERT lines only in the Worker's logs)");
  h.hook.post('ALERT node n100 offline');
  await h.settle();
  assert.equal(h.fetch.calls.at(-1).body.content, '**ALERT** `node n100 offline`', 'counted once');
});

test('a webhook that fails or never answers: a plain log line without its URL, never an ALERT, nothing thrown', async () => {
  const h = hook();
  h.fetch = fakeFetch(() => new Response('{"message":"Unknown Webhook"}', { status: 404 }));
  h.hook.post('ALERT one');
  h.fetch = fakeFetch(() => {
    throw new TypeError(`fetch failed for ${HOOK}`);
  });
  h.hook.post('ALERT two');
  await h.settle();
  assert.deepEqual(h.logs.toSorted(), ['alert webhook answered 404', 'alert webhook failed (TypeError)']);
  assert.ok(h.logs.every((l) => !l.includes('secret-token') && !l.startsWith('ALERT')));
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let signal = null;
    h.fetch = fakeFetch((_, init) => {
      signal = init.signal;
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    });
    h.hook.post('ALERT three');
    mock.timers.tick(AL.ALERT_POST_TIMEOUT_MS);
    await h.settle();
    assert.equal(signal.aborted, true, 'given up after 5 s');
    assert.equal(h.logs.at(-1), 'alert webhook failed (AbortError)');
  } finally {
    mock.timers.reset();
  }
});

// ---- the watch -----------------------------------------------------------------------------------

test('offline: a trusted node in service without a heartbeat for 2 minutes, once per outage; one never seen counts from the start', () => {
  const w = new W.NodeWatch();
  const n = rec({ online: false, lastSeen: NOW });
  assert.equal(w.watching([n]), true, 'the alarm keeps running for it');
  assert.deepEqual(w.tick(NOW + W.OFFLINE_ALERT_MS, [n], [], null, NOW - MIN), []);
  const [a] = w.tick(NOW + W.OFFLINE_ALERT_MS + 1, [n], [], null, NOW - MIN);
  assert.equal(a.key, 'offline:0123456789abcdef');
  assert.match(a.line, /^ALERT trusted node sao-paulo-1 \(0123456789abcdef\) offline for 2 min \(last heartbeat \d\d:\d\d:\d\d UTC\): no match goes to it$/);
  assert.deepEqual(w.tick(NOW + 60 * MIN, [n], [], null, NOW - MIN), [], 'once per outage');
  n.online = true;
  assert.deepEqual(w.tick(NOW + 61 * MIN, [n], [], null, NOW - MIN), [{ line: 'trusted node sao-paulo-1 (0123456789abcdef) back online' }]);
  assert.equal(w.watching([n]), false);
  n.online = false;
  n.lastSeen = NOW + 61 * MIN;
  assert.equal(w.tick(NOW + 64 * MIN, [n], [], null, NOW - MIN).length, 1, 'a new outage, a new ALERT');
  // After a restart nothing was seen yet: offline from the start.
  const fresh = new W.NodeWatch();
  const cold = rec({ online: false, lastSeen: 0 });
  assert.deepEqual(fresh.tick(NOW + W.OFFLINE_ALERT_MS, [cold], [], null, NOW), []);
  assert.match(fresh.tick(NOW + W.OFFLINE_ALERT_MS + 1, [cold], [], null, NOW)[0].line, /not seen since the control plane started/);
  // Only a trusted node in service.
  for (const other of [rec({ online: false, trusted: false }), rec({ online: false, status: 'pending' }), rec({ online: false, status: 'suspended' }), rec({ online: false, status: 'banned' })]) {
    assert.equal(w.watching([other]), false);
    assert.deepEqual(new W.NodeWatch().tick(NOW + 60 * MIN, [other], [], null, NOW), []);
  }
});

test('egress: 80 % of the cap is an ALERT, once, again after it went back below; no cap, nothing', () => {
  const w = new W.NodeWatch();
  const n = rec({ egressCapGB: 1000, egressGB: 799.9 });
  assert.deepEqual(w.tick(NOW, [n], [], null, NOW), []);
  n.egressGB = 800;
  const [a] = w.tick(NOW, [n], [], null, NOW);
  assert.deepEqual(a, { line: 'ALERT node sao-paulo-1 (0123456789abcdef) has sent 800.0 GB of its 1000 GB monthly cap (80 %): at the cap it takes no more matches', key: 'egress:0123456789abcdef' });
  n.egressGB = 950;
  assert.deepEqual(w.tick(NOW, [n], [], null, NOW), []);
  n.egressGB = 3; // a new month
  assert.deepEqual(w.tick(NOW, [n], [], null, NOW), []);
  n.egressGB = 900;
  assert.equal(w.tick(NOW, [n], [], null, NOW).length, 1);
  assert.deepEqual(new W.NodeWatch().tick(NOW, [rec({ egressGB: 5000, egressCapGB: null })], [], null, NOW), []);
});

test('tick lag: over 8 ms in 3 heartbeats in a row is an ALERT, once; a good heartbeat ends it', () => {
  const w = new W.NodeWatch();
  const n = rec({ tickLagP99Ms: 9.25 });
  assert.equal(w.beat(n), null);
  assert.equal(w.beat(n), null);
  assert.deepEqual(w.beat(n), { line: 'ALERT node sao-paulo-1 (0123456789abcdef): tick lag p99 9.3 ms in 3 heartbeats in a row (over 8 ms: its matches stutter)', key: 'lag:0123456789abcdef' });
  assert.equal(w.beat(n), null, 'once');
  n.tickLagP99Ms = 8;
  assert.deepEqual(w.beat(n), { line: 'node sao-paulo-1 (0123456789abcdef): tick lag p99 back to 8.0 ms' });
  n.tickLagP99Ms = 12;
  w.beat(n);
  n.tickLagP99Ms = 2;
  assert.equal(w.beat(n), null, 'two bad heartbeats were no episode');
  n.tickLagP99Ms = 12;
  w.beat(n);
  w.beat(n);
  assert.equal(w.beat(n).key, 'lag:0123456789abcdef', 'in a row again');
});

test('verifying: the oldest match waiting more than 30 minutes is one ALERT for the queue', () => {
  const w = new W.NodeWatch();
  const n = rec();
  const m = (id, queuedAt, state = 'verifying') => ({ state, queuedAt, nodeId: n.nodeId, assign: { matchId: id.repeat(32) } });
  const queue = [m('ab', NOW), m('cd', NOW + 5 * MIN), m('ef', NOW - 99 * MIN, 'done')];
  assert.deepEqual(w.tick(NOW + W.VERIFY_ALERT_MS, [n], queue, null, NOW), []);
  assert.deepEqual(w.tick(NOW + W.VERIFY_ALERT_MS + 1, [n], queue, null, NOW), [
    { line: 'ALERT 2 matches waiting for verification, the oldest (abababab on sao-paulo-1) for 30 min: is a verifier on its build online?', key: 'verifying' },
  ]);
  assert.deepEqual(w.tick(NOW + 40 * MIN, [n], queue, null, NOW), [], 'once while it lasts');
  assert.deepEqual(w.tick(NOW + 41 * MIN, [n], [], null, NOW), []);
  assert.equal(w.tick(NOW + 42 * MIN, [n], queue, null, NOW).length, 1, 'again after the queue cleared');
});

test('update: a node online below the minimum for more than 2 hours is an ALERT, once; at the minimum it ends', () => {
  const w = new W.NodeWatch();
  const n = rec({ build: { version: '0.2.0', protocol: 1, wasmSha256: 'a'.repeat(64) } });
  assert.deepEqual(w.tick(NOW, [n], [], '0.3.0', NOW), []);
  assert.deepEqual(w.tick(NOW + W.UPDATE_ALERT_MS, [n], [], '0.3.0', NOW), []);
  assert.deepEqual(w.tick(NOW + W.UPDATE_ALERT_MS + 1, [n], [], '0.3.0', NOW), [
    { line: "ALERT node sao-paulo-1 (0123456789abcdef) still on 0.2.0, below the channel's minimum 0.3.0, for 2 h: its update is deferred or it does not take it", key: 'update:0123456789abcdef' },
  ]);
  assert.deepEqual(w.tick(NOW + 3 * W.UPDATE_ALERT_MS, [n], [], '0.3.0', NOW), [], 'once');
  n.build = { ...n.build, version: '0.3.0' };
  assert.deepEqual(w.tick(NOW + 3 * W.UPDATE_ALERT_MS, [n], [], '0.3.0', NOW), []);
  n.build = { ...n.build, version: '0.2.9' };
  assert.deepEqual(w.tick(NOW + 3 * W.UPDATE_ALERT_MS + 1, [n], [], '0.3.0', NOW), [], 'a new wait starts');
  assert.deepEqual(new W.NodeWatch().tick(NOW + 9 * W.UPDATE_ALERT_MS, [n], [], null, NOW), [], 'no channel known: nobody is below it');
});

// ---- the cron's /healthz probe ---------------------------------------------------------------------

/** A node's /healthz as Caddy serves it: `over` changes the answer; `key` signs the nonce. */
function healthzFetch(over = {}, key = NODE_KEY) {
  return fakeFetch(async (url) => {
    const nonce = new URL(url).searchParams.get('nonce');
    return new Response(JSON.stringify({ ok: true, nodeId: '0123456789abcdef', version: '0.2.0', active: 0, capacity: 4, draining: false, sig: await sign(key, reachMessage('0123456789abcdef', nonce)), ...over }));
  });
}

test('probeHealthz: through the node’s TLS, signed with its key; draining is reported, any other answer is a failure of its kind', async () => {
  const n = rec();
  const f = healthzFetch();
  assert.deepEqual(await W.probeHealthz(n, f), { ok: true, draining: false });
  assert.match(f.calls[0].url, /^https:\/\/sp1\.turbo-gol\.test\/healthz\?nonce=[A-Za-z0-9_-]{24}$/);
  assert.ok(f.calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(await W.probeHealthz(n, healthzFetch({ draining: true })), { ok: true, draining: true });
  const other = await importPrivateKey((await generateEd25519()).privateKey);
  const answer = { ok: false, kind: 'answer' };
  assert.deepEqual(await W.probeHealthz(n, healthzFetch({}, other)), { ...answer, detail: 'an answer not signed by this node' });
  assert.deepEqual(await W.probeHealthz(n, healthzFetch({ nodeId: 'fedcba9876543210' })), { ...answer, detail: 'an answer not signed by this node' });
  assert.deepEqual(await W.probeHealthz(n, healthzFetch({ ok: false })), { ...answer, detail: 'an answer without ok: true' });
  assert.deepEqual(await W.probeHealthz(n, fakeFetch(() => new Response('<html>parked</html>'))), { ...answer, detail: 'an answer that is not JSON' });
  assert.deepEqual(await W.probeHealthz(n, fakeFetch(() => new Response('bad gateway', { status: 502 }))), { ok: false, kind: 'http', detail: 'HTTP 502 (the proxy answers, the node behind it does not)' });
  assert.deepEqual(await W.probeHealthz(n, fakeFetch(() => new Response('', { status: 526 }))), { ok: false, kind: 'tls', detail: 'HTTP 526: the TLS handshake or the certificate was refused' });
  const tls = await W.probeHealthz(
    n,
    fakeFetch(() => {
      throw new TypeError('fetch failed: certificate has expired');
    }),
  );
  assert.deepEqual(tls, { ok: false, kind: 'tls', detail: 'TLS error (an expired or invalid certificate?): TypeError: fetch failed: certificate has expired' });
  const net = await W.probeHealthz(
    n,
    fakeFetch(() => {
      throw new TypeError('fetch failed: connect ECONNREFUSED 203.0.113.1:443\n\u202eforged');
    }),
  );
  assert.equal(net.kind, 'network');
  assert.ok(!/[\n\u202e]/.test(net.detail), 'one printable line');
  let signal = null;
  const hang = fakeFetch((_, init) => {
    signal = init.signal;
    return new Promise(() => {});
  });
  assert.deepEqual(await W.probeHealthz(n, hang, 30), { ok: false, kind: 'timeout', detail: 'no answer in 0.03 s' });
  assert.equal(signal.aborted, true, 'the request is let go');
});

test('the cron probes trusted wss hosts not taken out of service: online, or in service and seen within the hour', () => {
  const t = (over) => W.healthzTargets([rec(over)], NOW).length === 1;
  assert.equal(t({}), true);
  assert.equal(t({ online: false, lastSeen: NOW - 30 * MIN }), true, 'seen half an hour ago');
  assert.equal(t({ online: false, lastSeen: NOW - 2 * 60 * MIN }), false, 'gone for two hours: its offline ALERT went out');
  assert.equal(t({ online: false, lastSeen: 0 }), false, 'not seen since a restart');
  assert.equal(t({ status: 'pending' }), true, 'a new node not proven yet');
  assert.equal(t({ status: 'pending', online: false, lastSeen: NOW - 30 * MIN }), false, 'not in service: nothing keeps the object running between two runs');
  assert.equal(t({ status: 'banned' }), false);
  assert.equal(t({ status: 'suspended' }), false);
  assert.equal(t({ trusted: false }), false);
  assert.equal(t({ roles: ['verify'], transports: [], publicUrl: null }), false);
  assert.equal(t({ transports: ['rtc'], publicUrl: null }), false);
});

test('a /healthz problem is an ALERT when it starts or changes kind, a drain nobody asked for too; a plain line when it answers again', () => {
  const w = new W.NodeWatch();
  const n = rec();
  assert.equal(w.health(n, { ok: true, draining: false }, false), null);
  const tls = { ok: false, kind: 'tls', detail: 'TLS error (an expired or invalid certificate?): x' };
  assert.deepEqual(w.health(n, tls, false), {
    line: 'ALERT node sao-paulo-1 (0123456789abcdef) /healthz at https://sp1.turbo-gol.test: TLS error (an expired or invalid certificate?): x',
    key: 'healthz:0123456789abcdef:tls',
  });
  assert.equal(w.health(n, tls, false), null, 'while it lasts');
  assert.equal(w.health(n, { ok: false, kind: 'timeout', detail: 'no answer in 5 s' }, false).key, 'healthz:0123456789abcdef:timeout', 'another kind');
  assert.deepEqual(w.health(n, { ok: true, draining: false }, false), { line: 'node sao-paulo-1 (0123456789abcdef) /healthz answers again' });
  assert.equal(w.health(n, { ok: true, draining: true }, true), null, 'a drain the control plane asked for');
  assert.match(w.health(n, { ok: true, draining: true }, false).line, /: draining, and the control plane did not ask it to \(no drain, no update\)$/);
});

test('names and versions a node sent are cut before they reach a line', () => {
  const w = new W.NodeWatch();
  const n = rec({ name: 'n'.repeat(300) + '\u202e', build: { version: 'v'.repeat(300), protocol: 1, wasmSha256: 'a'.repeat(64) }, online: false });
  const [line] = w.tick(NOW + W.OFFLINE_ALERT_MS + 1, [n], [], null, NOW).map((x) => x.line);
  assert.ok(line.length < 200, line);
  assert.ok(!line.includes('\u202e'));
  assert.equal(W.clip('abc', 3), 'abc');
  assert.equal(W.clip('abcd', 3), 'ab…');
});
