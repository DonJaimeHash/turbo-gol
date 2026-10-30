// End-to-end smoke of accounts, ranked and custom lobbies against a running Worker (Node 24, no
// browser). LOCAL DEV ONLY: it registers throwaway accounts (smk_<random>) in the target's AccountsDO.
//   cd server && npm run dev            (wrangler dev on 8787, another terminal)
//   node server/test/smoke-accounts.mjs [--api=http://127.0.0.1:8787]
//
// Flow:
//   config (accounts on, OAuth providers listed) -> register A and B (recovery codes, refresh cookie)
//   -> wrong password 401 -> login -> refresh rotates the cookie (the old one is refused) -> /api/me
//   -> a guest cannot queue ranked (403) -> A and B queue ranked 1v1 together (multi-playlist body)
//   -> both matched into the SAME server match with `ranked: true` -> both sockets Ready -> the match
//   starts -> A quits (POST /api/leave { matchId }) = forfeit -> /api/ranked/result: B 'win', A 'loss'
//   + left + a ban, A's next ranked queue 429 'ranked_ban' -> population endpoint -> A creates a
//   public lobby with a password -> B sees it in the list (locked) -> wrong password 403 -> joins ->
//   both lobby sockets get the state (two members, A host) -> B switches team -> A starts -> both get
//   their P2P room result -> both leave the room locks -> an experimental lobby (a guest cannot create
//   or join it, the casual and ranked queues refuse rules, the list tags it, a server match with the
//   rules is refused, every room welcome carries them, a ready with the stock fingerprint is refused
//   with physics_mismatch, the rules fingerprint on both starts the match, nothing is rated) ->
//   recovery code resets B's password -> logout: the refresh cookie no longer works.
// Exit 0 = pass, 1 = a check failed.
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

const argv = process.argv.slice(2);
const API = (argv.find((a) => a.startsWith('--api='))?.slice(6) ?? process.env.API ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const ACC = await import('../../src/net/account.ts');
const P = await import('../../src/net/protocol.ts');
const P2 = await import('../../src/net/p2p/protocol.ts');
const MUT = await import('../../src/sim/mutators.ts');

let failed = 0;
function check(ok, label, extra) {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra !== undefined ? ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`);
  if (!ok) failed++;
  return ok;
}

/** A tiny cookie jar per player (only the __Host- cookies matter). */
function jar() {
  const map = new Map();
  return {
    header: () => [...map].map(([k, v]) => `${k}=${v}`).join('; '),
    take(res) {
      for (const c of res.headers.getSetCookie?.() ?? []) {
        const [kv, ...attrs] = c.split(';');
        const i = kv.indexOf('=');
        const k = kv.slice(0, i).trim();
        const v = kv.slice(i + 1).trim();
        if (attrs.some((a) => /max-age=0/i.test(a)) || v === '') map.delete(k);
        else map.set(k, v);
      }
    },
    get: (k) => map.get(k),
    set: (k, v) => map.set(k, v),
  };
}

async function api(path, { body, token, cookies, method } = {}) {
  const headers = { 'content-type': 'application/json', Origin: API };
  if (token) headers.authorization = 'Bearer ' + token;
  if (cookies && cookies.header()) headers.cookie = cookies.header();
  const res = await fetch(API + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (cookies) cookies.take(res);
  let json = null;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

const rnd = () => Math.random().toString(36).slice(2, 8);
const userA = 'smk_' + rnd();
const userB = 'smk_' + rnd();
const passA = 'smoke pass ' + rnd();
const passB = 'smoke pass ' + rnd();
const jarA = jar();
const jarB = jar();

// ---- config / register / login / refresh ---------------------------------------------------------
const cfg = await api('/api/config');
check(cfg.status === 200 && cfg.json.accounts === true && Array.isArray(cfg.json.oauth) && Array.isArray(cfg.json.regions), 'config: accounts, oauth list, regions', { oauth: cfg.json?.oauth, autoRegion: cfg.json?.autoRegion });
const region = 'SA';

const keyA = await ACC.clientPasswordKey(userA, passA);
const regA = await api('/api/auth/register', { body: { username: userA, password: keyA }, cookies: jarA });
check(regA.status === 200 && regA.json.kind === 'account' && regA.json.recoveryCodes.length === 8 && jarA.get('__Host-tg_rt'), 'register A (session, 8 recovery codes, refresh cookie)', regA.status);
const keyB = await ACC.clientPasswordKey(userB, passB);
const regB = await api('/api/auth/register', { body: { username: userB, password: keyB }, cookies: jarB });
check(regB.status === 200, 'register B', regB.status);
const dup = await api('/api/auth/register', { body: { username: userA.toUpperCase(), password: keyA } });
check(dup.status === 409 && dup.json.error === 'username_taken', 'same username (other case) -> 409', dup.status);
const bad = await api('/api/auth/login', { body: { username: userA, password: await ACC.clientPasswordKey(userA, 'wrong password') } });
check(bad.status === 401 && bad.json.error === 'bad_credentials', 'wrong password -> 401', bad.status);
const login = await api('/api/auth/login', { body: { username: userA.toUpperCase(), password: keyA }, cookies: jarA });
check(login.status === 200 && login.json.playerId === regA.json.playerId, 'login (case-insensitive username)', login.status);
const oldCookie = jarA.get('__Host-tg_rt');
const ref = await api('/api/auth/refresh', { method: 'POST', cookies: jarA });
check(ref.status === 200 && ref.json.session && jarA.get('__Host-tg_rt') !== oldCookie, 'refresh rotates the cookie', ref.status);
const stale = jar();
stale.set('__Host-tg_rt', oldCookie);
const ref2 = await api('/api/auth/refresh', { method: 'POST', cookies: stale });
check(ref2.status === 401, 'the rotated-out refresh token is refused', ref2.status);
let tokA = ref.json.session;
const tokB = regB.json.session;
const me = await api('/api/me', { token: tokA });
check(me.status === 200 && me.json.name === userA && me.json.ratings.length === 3 && me.json.ratings[0].placementLeft === 5, 'GET /api/me', me.json?.ratings?.[0]);

// ---- training records ----------------------------------------------------------------------------
const tr1 = await api('/api/me/training', { body: { records: { 'shooting-easy': { best: 6, shots: 8, completedAt: 1000 }, 'bad id!': { best: 1, shots: 1 } } }, token: tokA });
check(tr1.status === 200 && tr1.json.records?.['shooting-easy']?.best === 6 && !('bad id!' in (tr1.json.records ?? {})), 'POST /api/me/training stores a record, drops an invalid one', tr1.json);
const tr2 = await api('/api/me/training', { body: { records: { 'shooting-easy': { best: 4, shots: 8, completedAt: 2000 }, 'saving-easy': { best: 3, shots: 8, completedAt: 2000 } } }, token: tokA });
check(tr2.status === 200 && tr2.json.records?.['shooting-easy']?.best === 6 && tr2.json.records?.['saving-easy']?.best === 3, 'a worse run keeps the best, a new pack is added', tr2.json);
const tr3 = await api('/api/me/training', { body: { records: {} }, token: tokB });
check(tr3.status === 200 && Object.keys(tr3.json.records ?? { x: 1 }).length === 0, "another account does not see A's records", tr3.json);

// ---- ranked --------------------------------------------------------------------------------------
const guest = await api('/api/guest', { body: { name: 'SmokeGuest' } });
const gtr = await api('/api/me/training', { body: { records: {} }, token: guest.json.session });
check(gtr.status === 403 && gtr.json.error === 'account_required', 'a guest has no training records on the server', gtr.status);
const gq = await api('/api/queue', { body: { modes: ['1v1'], kind: 'ranked', region }, token: guest.json.session });
check(gq.status === 403 && gq.json.error === 'account_required', 'a guest cannot queue ranked', gq.status);
const qA = api('/api/queue', { body: { modes: ['1v1', '2v2'], kind: 'ranked', region }, token: tokA });
await new Promise((r) => setTimeout(r, 400));
const qB = await api('/api/queue', { body: { modes: ['1v1'], kind: 'ranked', region }, token: tokB });
let rA = await qA;
if (rA.json?.status === 'waiting') rA = await api('/api/queue', { body: { modes: ['1v1', '2v2'], kind: 'ranked', region }, token: tokA });
check(rA.json?.status === 'matched' && qB.json?.status === 'matched' && rA.json.matchId === qB.json.matchId && rA.json.ranked === true, 'both matched into one ranked match', { a: rA.json?.status, b: qB.json?.status });
const matchId = rA.json?.matchId;

function openMatch(result) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(result.wsUrl, [P.WS_SUBPROTOCOL, P.WS_TICKET_PREFIX + result.ticket]);
    ws.binaryType = 'arraybuffer';
    const st = { ws, welcome: null, events: [], closed: null };
    ws.onmessage = (ev) => {
      const buf = new Uint8Array(ev.data);
      if (buf[0] === P.MsgType.Welcome) {
        st.welcome = P.decodeJson(buf);
        ws.send(P.encodeJson(P.MsgType.Ready, {}));
        resolve(st);
      } else if (buf[0] === P.MsgType.Event) st.events.push(P.decodeJson(buf));
    };
    ws.onclose = (ev) => {
      st.closed = { code: ev.code, reason: ev.reason };
      resolve(st);
    };
    ws.onerror = (e) => reject(e);
  });
}
if (matchId) {
  const [sA, sB] = await Promise.all([openMatch(rA.json), openMatch(qB.json)]);
  check(sA.welcome && sB.welcome && sA.welcome.slot !== sB.welcome.slot, 'both ranked sockets welcomed', { a: sA.welcome?.slot, b: sB.welcome?.slot });
  const t0 = Date.now();
  while (!sB.events.some((e) => e.type === 'countdown' || e.type === 'go') && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 100));
  check(sB.events.some((e) => e.type === 'countdown' || e.type === 'go'), 'the ranked match started (both ready)');
  const lv = await api('/api/leave', { body: { matchId, region }, token: tokA });
  check(lv.status === 200 && lv.json.released === true, 'A quits the ranked match', lv.json);
  const t1 = Date.now();
  while (!sB.events.some((e) => e.type === 'ended') && Date.now() - t1 < 5000) await new Promise((r) => setTimeout(r, 100));
  const end = sB.events.find((e) => e.type === 'ended');
  check(end && end.forfeit === true && end.winner === sB.welcome.roster[sB.welcome.slot].team, 'forfeit: B wins at once', end);
  let resA = null;
  let resB = null;
  for (let i = 0; i < 30; i++) {
    resA = await api('/api/ranked/result?matchId=' + matchId, { token: tokA });
    resB = await api('/api/ranked/result?matchId=' + matchId, { token: tokB });
    if (resA.json?.status === 'done' && resB.json?.status === 'done') break;
    await new Promise((r) => setTimeout(r, 300));
  }
  check(resB.json?.status === 'done' && resB.json.outcome === 'win' && resB.json.mmrAfter > resB.json.mmrBefore, 'B rated: win, MMR up', resB.json);
  check(resA.json?.status === 'done' && resA.json.outcome === 'loss' && resA.json.left === true && resA.json.banUntil > Date.now(), 'A rated: loss as leaver + ranked ban', resA.json);
  const banned = await api('/api/queue', { body: { modes: ['1v1'], kind: 'ranked', region }, token: tokA });
  check(banned.status === 429 && banned.json.error === 'ranked_ban' && banned.json.retryAfterMs > 0, "A's next ranked queue: 429 ranked_ban", banned.status);
  const meA = await api('/api/me', { token: tokA });
  check(meA.json?.ratings?.[0]?.games === 1 && meA.json.rankedBanUntil > Date.now() && meA.json.abandons24h === 1, 'A /api/me shows the game and the ban', meA.json?.ratings?.[0]);
  sA.ws.close();
  sB.ws.close();
}

const pop = await api('/api/population?region=' + region);
check(pop.status === 200 && typeof pop.json.casual?.['1v1'] === 'number' && typeof pop.json.playing === 'number', 'population', pop.json);
const board = await api('/api/leaderboard?playlist=1v1', { token: tokB });
check(board.status === 200 && Array.isArray(board.json.entries), 'leaderboard (placement not done: B not listed yet)', { total: board.json?.total, you: board.json?.you });

// ---- lobbies -------------------------------------------------------------------------------------
const cl = await api('/api/lobbies', { body: { name: 'Smoke ' + rnd(), password: 'secret', mode: '1v1', visibility: 'public', net: 'p2p', matchLengthSeconds: 180, region }, token: tokA });
check(cl.status === 200 && /^[A-Z2-9]{6}$/.test(cl.json?.code ?? '') && cl.json.ticket, 'A creates a lobby', cl.json?.code ?? cl.text);
function openLobby(t) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(t.wsUrl, [P.WS_SUBPROTOCOL, P.WS_TICKET_PREFIX + t.ticket]);
    const st = { ws, states: [], matches: [], errors: [], closed: null };
    ws.onopen = () => resolve(st);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.t === 'state') st.states.push(m.lobby);
      else if (m.t === 'match') st.matches.push(m.result);
      else if (m.t === 'error') st.errors.push(m);
    };
    ws.onclose = (ev) => {
      st.closed = { code: ev.code, reason: ev.reason };
      resolve(st);
    };
    ws.onerror = (e) => reject(e);
  });
}
const waitFor = async (pred, ms = 4000) => {
  const t = Date.now();
  while (!pred() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50));
  return pred();
};
if (cl.status === 200) {
  const la = await openLobby(cl.json);
  check(await waitFor(() => la.states.length > 0), 'host lobby socket: state', la.states.at(-1)?.members);
  await new Promise((r) => setTimeout(r, 3500)); // the Worker's list cache (3 s)
  const list = await api('/api/lobbies?region=' + region, { token: tokB });
  const row = list.json?.lobbies?.find((l) => l.code === cl.json.code);
  check(row && row.locked === true && row.players === 1 && row.max === 2, 'B sees the lobby in the public list (locked, 1/2)', row);
  const wrong = await api('/api/lobbies/join', { body: { code: cl.json.code, password: 'nope' }, token: tokB });
  check(wrong.status === 403 && wrong.json.error === 'bad_password', 'wrong lobby password -> 403', wrong.status);
  const jn = await api('/api/lobbies/join', { body: { code: cl.json.code.toLowerCase(), password: 'secret' }, token: tokB });
  check(jn.status === 200 && jn.json.lobbyId === cl.json.lobbyId, 'B joins by code (any case)', jn.status);
  const lb = await openLobby(jn.json);
  check(await waitFor(() => la.states.at(-1)?.members.length === 2 && lb.states.length > 0), 'both see two members', la.states.at(-1)?.members);
  const st = lb.states.at(-1);
  const meB = st.members.find((m) => m.id === st.you);
  const host = st.members.find((m) => m.host);
  check(meB && !meB.host && host && host.name === userA && meB.team !== host.team, 'A is host, B on the other team');
  lb.ws.send(JSON.stringify({ t: 'team', team: host.team }));
  check(await waitFor(() => lb.errors.length > 0), 'switch into the full team refused', lb.errors.at(-1)?.code);
  la.ws.send(JSON.stringify({ t: 'start' }));
  check(await waitFor(() => la.matches.length > 0 && lb.matches.length > 0, 8000), 'start: both get their match result', { a: la.matches[0]?.kind, b: lb.matches[0]?.kind });
  const room = la.matches[0];
  check(room && room.kind === 'p2p' && room.roomId === lb.matches[0]?.roomId && /^wss?:\/\//.test(room.wsUrl), 'a P2P room for both, absolute socket URL', room?.wsUrl);
  check(await waitFor(() => la.states.at(-1)?.status === 'in_game'), 'lobby status in_game');
  await api('/api/leave', { body: { matchId: room?.roomId, region }, token: tokA });
  await api('/api/leave', { body: { matchId: room?.roomId, region }, token: tokB });
  la.ws.send(JSON.stringify({ t: 'back' }));
  lb.ws.send(JSON.stringify({ t: 'back' }));
  check(await waitFor(() => la.states.at(-1)?.status === 'open'), 'everyone back: lobby open again');
  lb.ws.send(JSON.stringify({ t: 'leave' }));
  la.ws.send(JSON.stringify({ t: 'leave' }));
  await waitFor(() => la.closed !== null && lb.closed !== null);
}

// ---- an experimental lobby: accounts only, P2P only, the rules in every welcome, the ready fingerprint ----
// The owner's rule: the casual and ranked queues never take rules, and a match with them counts for
// nothing (no rating, no strike: nothing reports a P2P result anywhere).
const RULES = { v: 1, name: 'Low gravity', values: { gravity: 50, ballDrag: 50 } };
const RULES_FP = MUT.physicsFingerprint(RULES);
const STOCK_FP = MUT.physicsFingerprint(null);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function openRoom(r) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(r.wsUrl, [P.WS_SUBPROTOCOL, P.WS_TICKET_PREFIX + r.ticket]);
    const st = { ws, msgs: [], closed: null, of: (type) => st.msgs.filter((m) => m.type === type) };
    ws.onopen = () => resolve(st);
    ws.onmessage = (ev) => st.msgs.push(JSON.parse(ev.data));
    ws.onclose = (ev) => {
      st.closed = { code: ev.code, reason: ev.reason };
      resolve(st);
    };
    ws.onerror = (e) => reject(e);
  });
}
const guestS = await api('/api/guest', { body: { name: 'Smoke guest' } });
const tokG = guestS.json?.session;
const expBody = { name: 'Smoke exp ' + rnd(), mode: '1v1', visibility: 'public', net: 'p2p', matchLengthSeconds: 180, region, physics: RULES };
const gx = await api('/api/lobbies', { body: expBody, token: tokG });
check(gx.status === 403 && gx.json?.error === 'account_required', 'a guest cannot create a lobby with experimental rules', gx.status);
const qx = await api('/api/queue', { body: { mode: '1v1', kind: 'p2p', p2pProtocol: P2.P2P_PROTOCOL_VERSION, physics: RULES }, token: tokB });
check(qx.status === 400 && qx.json?.error === 'experimental_lobby_only', 'the casual queue refuses rules', qx.status);
const qrx = await api('/api/queue', { body: { modes: ['1v1'], kind: 'ranked', region, physics: RULES }, token: tokB });
check(qrx.status === 400 && qrx.json?.error === 'experimental_lobby_only', 'the ranked queue refuses rules', qrx.status);
const ex = await api('/api/lobbies', { body: expBody, token: tokA });
check(ex.status === 200 && typeof ex.json?.ticket === 'string', 'A (signed in) creates a lobby with experimental rules', ex.status);
if (ex.status === 200) {
  const xa = await openLobby(ex.json);
  check(await waitFor(() => xa.states.length > 0) && same(xa.states.at(-1).settings.physics, RULES), 'the lobby state carries the rules', xa.states.at(-1)?.settings.physics);
  await new Promise((r) => setTimeout(r, 3500)); // the Worker's list cache (3 s)
  const row = (await api('/api/lobbies?region=' + region)).json?.lobbies?.find((l) => l.code === ex.json.code);
  check(row && row.experimental === true && row.physics?.name === RULES.name, 'the public list tags it experimental, with its rules', row && { experimental: row.experimental, rules: row.physics?.name });
  const gj = await api('/api/lobbies/join', { body: { code: ex.json.code }, token: tokG });
  check(gj.status === 403 && gj.json?.error === 'account_required', 'a guest cannot join it', gj.status);
  const bj = await api('/api/lobbies/join', { body: { code: ex.json.code }, token: tokB });
  check(bj.status === 200, 'B (signed in) joins it', bj.status);
  const xb = await openLobby(bj.json);
  check(await waitFor(() => xb.states.at(-1)?.members.length === 2) && same(xb.states.at(-1).settings.physics, RULES), 'B sees the rules before the match');
  xa.ws.send(JSON.stringify({ t: 'settings', settings: { net: 'server' } }));
  check(await waitFor(() => xa.errors.some((e) => e.code === 'experimental_p2p_only')), 'a server match with the rules is refused', xa.errors.at(-1)?.code);
  // Round 1: B's arena runs the standard physics (a modified page): refused at its ready.
  xa.ws.send(JSON.stringify({ t: 'start' }));
  check(await waitFor(() => xa.matches.length > 0 && xb.matches.length > 0, 8000), 'start: both get their P2P room', { a: xa.matches[0]?.kind, b: xb.matches[0]?.kind });
  const r1 = [xa.matches[0], xb.matches[0]];
  if (r1[0]?.kind === 'p2p' && r1[1]?.kind === 'p2p') {
    const [ra, rb] = [await openRoom(r1[0]), await openRoom(r1[1])];
    check(await waitFor(() => ra.of('room').length > 0 && rb.of('room').length > 0), 'both room welcomes');
    check(same(ra.of('room')[0]?.physics, RULES) && same(rb.of('room')[0]?.physics, RULES) && ra.of('room')[0]?.protocol === P2.P2P_PROTOCOL_VERSION, 'every welcome carries the rules (protocol 5)', ra.of('room')[0]?.physics);
    ra.ws.send(JSON.stringify({ type: 'ready', physicsFp: RULES_FP }));
    rb.ws.send(JSON.stringify({ type: 'ready', physicsFp: STOCK_FP }));
    check(await waitFor(() => rb.closed !== null), 'a ready with another fingerprint: physics_mismatch, socket closed', { errors: rb.of('error').map((e) => e.code), closed: rb.closed });
    check(rb.of('error').some((e) => e.code === 'physics_mismatch') && ra.of('start').length === 0, 'B never starts with other physics', rb.of('error'));
    ra.ws.close();
    await api('/api/leave', { body: { matchId: r1[0].roomId, region }, token: tokA });
    await api('/api/leave', { body: { matchId: r1[1].roomId, region }, token: tokB });
    xa.ws.send(JSON.stringify({ t: 'back' }));
    xb.ws.send(JSON.stringify({ t: 'back' }));
    check(await waitFor(() => xa.states.at(-1)?.status === 'open'), 'back in the lobby');
    // Round 2: both arenas run the rules: the room starts. Round 1 began a moment ago (its ready was
    // refused at once), and INICIAR waits START_AGAIN_MS (5 s) after a start that formed a match
    // (rt-m1): the host is told start_cooldown and presses it again once the wait is over. A real
    // match outlasts the wait, so INICIAR after FINAL is never refused (server/test/lobby-limits.test.mjs).
    xa.ws.send(JSON.stringify({ t: 'start' }));
    if ((await waitFor(() => xa.matches.length > 1 || xa.errors.some((e) => e.code === 'start_cooldown'), 4000)) && xa.matches.length < 2) {
      check(true, 'start again within 5 s of the last start: start_cooldown');
      await new Promise((r) => setTimeout(r, 5_500));
      xa.ws.send(JSON.stringify({ t: 'start' }));
    }
    const again = await waitFor(() => xa.matches.length > 1 && xb.matches.length > 1, 8000);
    check(again, 'start again', again ? undefined : xa.errors.at(-1)?.code);
    const r2 = [xa.matches[1], xb.matches[1]];
    const [sa, sb] = [await openRoom(r2[0]), await openRoom(r2[1])];
    check(await waitFor(() => sa.of('room').length > 0 && sb.of('room').length > 0), 'both welcomes again');
    sa.ws.send(JSON.stringify({ type: 'ready', physicsFp: RULES_FP }));
    sb.ws.send(JSON.stringify({ type: 'ready', physicsFp: RULES_FP }));
    check(await waitFor(() => sa.of('start').length > 0 && sb.of('start').length > 0), 'the rules fingerprint on both: the match starts', { a: sa.of('start')[0]?.startAt, b: sb.of('start')[0]?.startAt });
    sa.ws.close();
    sb.ws.close();
    await api('/api/leave', { body: { matchId: r2[0].roomId, region }, token: tokA });
    await api('/api/leave', { body: { matchId: r2[1].roomId, region }, token: tokB });
  }
  const meAfter = await api('/api/me', { token: tokA });
  check(meAfter.json?.ratings?.[0]?.games === 1, 'nothing rated: A still has only the ranked game', meAfter.json?.ratings?.[0]?.games);
  xb.ws.send(JSON.stringify({ t: 'leave' }));
  xa.ws.send(JSON.stringify({ t: 'leave' }));
  await waitFor(() => xa.closed !== null && xb.closed !== null);
}

// ---- recovery / logout -----------------------------------------------------------------------------
const newKeyB = await ACC.clientPasswordKey(userB, 'brand new pass ' + rnd());
const rec = await api('/api/auth/recover', { body: { username: userB, code: regB.json.recoveryCodes[0], password: newKeyB }, cookies: jarB });
check(rec.status === 200 && rec.json.codesLeft === 7, 'recovery code resets B', rec.json?.codesLeft);
const oldLogin = await api('/api/auth/login', { body: { username: userB, password: keyB } });
check(oldLogin.status === 401, 'old password no longer works', oldLogin.status);
// Rename re-keys the password (the client key is salted with the username).
const newPassB = 'brand new pass ' + rnd();
const recKeyB = await ACC.clientPasswordKey(userB, newPassB);
const recB = await api('/api/auth/recover', { body: { username: userB, code: regB.json.recoveryCodes[1], password: recKeyB }, cookies: jarB });
const renamed = userB.replace('smk_', 'smr_');
const rn = await api('/api/me/username', {
  body: { username: renamed, password: recKeyB, newPassword: await ACC.clientPasswordKey(renamed, newPassB) },
  token: recB.json?.session,
  cookies: jarB,
});
check(rn.status === 200 && rn.json.name === renamed, 'rename (password re-keyed)', rn.status);
const loginNew = await api('/api/auth/login', { body: { username: renamed, password: await ACC.clientPasswordKey(renamed, newPassB) } });
check(loginNew.status === 200 && loginNew.json.playerId === regB.json.playerId, 'login with the new name and the same password', loginNew.status);
const loginOld = await api('/api/auth/login', { body: { username: userB, password: recKeyB } });
check(loginOld.status === 401, 'the old name is gone', loginOld.status);
const lo = await api('/api/auth/logout', { method: 'POST', cookies: jarA });
check(lo.status === 200 && !jarA.get('__Host-tg_rt'), 'logout clears the cookie', lo.status);
const after = jar();
after.set('__Host-tg_rt', ref.json ? oldCookie : '');
const ref3 = await api('/api/auth/refresh', { method: 'POST', cookies: after });
check(ref3.status === 401, 'refresh after logout refused', ref3.status);

console.log(failed === 0 ? 'ALL OK' : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
