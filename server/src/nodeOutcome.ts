/**
 * What becomes of a finished node match: the calls a MatchDO makes for its own matches
 * (reportRanked, cancelRanked, shutdown), built from the control plane's MatchOutcome. The
 * NodeRegistryDO writes them to its outbox in the transaction that settles the match
 * (MatchStore.finished) and delivers each one until deliverCall says it is done.
 *
 * Delivering a call twice does no harm: AccountsDO records a match id once (/ranked-result,
 * /ranked-cancel and /host-credit skip one they already have; /host-freeze keeps a freeze in force
 * and ignores one from before the last unfreeze), and /release only frees the locks that still
 * point at this match.
 *
 * The hosts' points (Option A of the shop: AccountsDO owns wallets, NodeRegistryDO the scoring): a
 * match a community node earned points for (MatchEntry.ledger) credits its operator's account, and
 * a failed verification (MatchEntry.freeze) freezes it, in the same transaction that settles the
 * match. A project node never earns and never freezes: the control plane sets neither for it.
 */
import type { MatchEntry, MatchOutcome } from '../../nodes/control-plane/controlPlane';
import type { MatchAssignment } from '../../nodes/shared/controlProtocol';
import type { HostCredit } from './accountStore';
import { INTERNAL_HEADER, internalSecret } from './auth';
import { withTimeout } from './env';
import type { Env } from './env';

/** The target of AccountsDO calls (its one object is 'accounts-v1'); a matchmaker's is its object name, 'mm:<region>'. */
export const ACCOUNTS_TARGET = 'accounts';
/** A target that has not answered in this long is tried again later: one stuck object must not hold up the outbox. */
export const DELIVERY_TIMEOUT_MS = 10_000;
/** AccountsDO keeps this much of a cancel's reason. */
const REASON_MAX = 32;

/** One POST of an outcome: an outbox row. */
export interface OutcomeCall {
  matchId: string;
  /** ACCOUNTS_TARGET, or 'mm:<region>' (that region's MatchmakerDO). */
  target: string;
  path: '/ranked-result' | '/ranked-cancel' | '/host-credit' | '/host-freeze' | '/release';
  /** The JSON body, as the outbox stores it and as it is sent. */
  body: string;
}

/**
 * The calls for one settled match, in delivery order. A rated match goes to /ranked-result with
 * MatchDO's body. A ranked void goes to /ranked-cancel, with the playlist and region of the
 * assignment (a void outcome carries neither): its noShows get an abandon, nobody is rated. A
 * casual match, void or not, has nothing to record. `rewards` (the settled MatchEntry's ledger and
 * freeze, and when it settled): its points to /host-credit, its freeze to /host-freeze. Every match
 * then frees its players' locks in the matchmaker of its region, so they can queue again.
 * `playerIds`: the match's humans.
 */
export function outcomeCalls(o: MatchOutcome, assign: MatchAssignment, playerIds: readonly string[], rewards: Partial<Pick<MatchEntry, 'ledger' | 'freeze' | 'doneAt'>> = {}): OutcomeCall[] {
  const matchId = o.matchId;
  const calls: OutcomeCall[] = [];
  if (o.kind === 'rated') {
    const body = { matchId, playlist: o.playlist, region: o.region, winner: o.winner, blue: o.blue, red: o.red, players: o.players };
    calls.push({ matchId, target: ACCOUNTS_TARGET, path: '/ranked-result', body: JSON.stringify(body) });
  } else if (o.kind === 'void' && o.ranked) {
    const body = { matchId, playlist: assign.mode, region: assign.region, players: o.players, noShows: o.noShows, reason: o.reason.slice(0, REASON_MAX) };
    calls.push({ matchId, target: ACCOUNTS_TARGET, path: '/ranked-cancel', body: JSON.stringify(body) });
  }
  const e = rewards.ledger;
  if (e) {
    const body: HostCredit = { matchId, userId: e.operatorId, nodeId: e.nodeId, points: e.points, verified: e.verified, at: e.at };
    calls.push({ matchId, target: ACCOUNTS_TARGET, path: '/host-credit', body: JSON.stringify(body) });
  }
  const f = rewards.freeze;
  if (f) {
    // `at`: when the match settled, so an unfreeze given after it is never undone by a late redelivery.
    const body = { userId: f.operatorId, reason: f.reason, at: rewards.doneAt ?? 0 };
    calls.push({ matchId, target: ACCOUNTS_TARGET, path: '/host-freeze', body: JSON.stringify(body) });
  }
  calls.push({ matchId, target: 'mm:' + assign.region, path: '/release', body: JSON.stringify({ matchId, playerIds }) });
  return calls;
}

/** What to do with a delivered row: 'done' deletes it, 'retry' keeps it for a later attempt. */
export type Delivery = 'done' | 'retry';

/** Text fit for one log line: printable ASCII, at most `max` characters. */
function oneLine(s: string, max: number): string {
  return s.replace(/[^\x20-\x7e]+/g, ' ').slice(0, max);
}

/**
 * POST one call. A 2xx is done. Any other answer below 500 is done as well, with an ALERT: the
 * target refused the call itself (a 400 for a body AccountsDO cannot read, a 403 for an internal
 * header signed with an older JWT_SECRET), so it would refuse every retry too, and a row retried
 * forever would keep the NodeRegistryDO's alarm running for nothing. The line carries the body, so
 * a maintainer can apply the result by hand. A 5xx, a network error or no answer within
 * `timeoutMs` is retried: the target is down, being deployed or stuck.
 */
export async function deliverCall(
  env: Pick<Env, 'ACCOUNTS' | 'MATCHMAKER' | 'JWT_SECRET'>,
  call: OutcomeCall,
  log: (msg: string) => void = (msg) => console.log(msg),
  timeoutMs: number = DELIVERY_TIMEOUT_MS,
): Promise<Delivery> {
  const where = `match ${call.matchId.slice(0, 8)}, ${call.target}`;
  const dropped = (status: string, why: string) => log(`ALERT outbox ${call.path} ${status} (${where}), dropped: ${why}; body ${oneLine(call.body, 600)}`);
  const accounts = call.target === ACCOUNTS_TARGET;
  if (!accounts && !call.target.startsWith('mm:')) {
    dropped('-', 'unknown target');
    return 'done';
  }
  let sent: Promise<Response> | null = null;
  let res: Response;
  try {
    const ns = accounts ? env.ACCOUNTS : env.MATCHMAKER;
    const stub = ns.get(ns.idFromName(accounts ? 'accounts-v1' : call.target));
    const headers = { [INTERNAL_HEADER]: await internalSecret(env.JWT_SECRET), 'content-type': 'application/json' };
    sent = stub.fetch(`https://${accounts ? 'accounts' : 'matchmaker'}${call.path}`, { method: 'POST', headers, body: call.body });
    res = await withTimeout(sent, timeoutMs);
  } catch (e) {
    // An answer that comes after the timeout is not read: its body is let go.
    void sent?.then((late) => late.body?.cancel()).catch(() => undefined);
    log(`outbox ${call.path} failed (${where}), to retry: ${oneLine(String(e), 200)}`);
    return 'retry';
  }
  if (res.ok) {
    await res.body?.cancel();
    return 'done';
  }
  if (res.status < 500) {
    dropped(String(res.status), oneLine(await res.text().catch(() => ''), 200));
    return 'done';
  }
  await res.body?.cancel();
  log(`outbox ${call.path} ${res.status} (${where}), to retry`);
  return 'retry';
}
