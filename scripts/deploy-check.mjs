// The check `npm run deploy` runs once Wrangler is done (scripts/deploy.mjs): one public GET per kind
// of Durable Object, so a Durable Object still on the code before the deploy shows at once.
//
// Why: every Worker -> Durable Object call carries the internal header (server/src/auth.ts
// internalSecret), and an object answers 403 'forbidden' when its code derives that header
// differently. A deploy restarts the objects on the new code, but on 2026-10-29 the NodeRegistryDO
// (it keeps the nodes' hibernated control sockets) went on answering with the code before the deploy:
// every /nodes route answered 403 or 503 until a second `wrangler deploy` of the same build restarted
// it. So: a 'forbidden' answer here means a stale object, and deploy.mjs deploys the same build once
// more and checks again. Anything else that fails (a 5xx, a timeout) is reported, never retried.
// Nothing here sends a body, a cookie or a credential.

/** The probes: the route, the Durable Objects it reaches, and the answer a healthy deploy gives. */
export const PROBES = [
  { path: '/api/config', reaches: 'the Worker alone', ok: [200] },
  { path: '/api/population', reaches: 'MatchmakerDO and LobbyDirectoryDO', ok: [200] },
  { path: '/api/leaderboard?playlist=1v1', reaches: 'AccountsDO', ok: [200] },
  { path: '/nodes/status', reaches: 'NodeRegistryDO', ok: [200], nodes: true },
];

/**
 * One round of the probes against `origin` ('https://turbo-gol.com'). Returns { ok, stale, lines }:
 * stale = some object answered 403 'forbidden' (old code), lines = one line per probe for the log.
 * `nodes` false skips the node registry (a deploy with --nodes-off).
 */
export async function probeOnce({ origin, nodes = true, fetch = globalThis.fetch, timeoutMs = 10_000 }) {
  let ok = true;
  let stale = false;
  const lines = [];
  for (const p of PROBES) {
    if (p.nodes && !nodes) continue;
    let status = 0;
    let code = '';
    try {
      const res = await fetch(origin + p.path, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      status = res.status;
      if (!p.ok.includes(status)) code = String((await res.json().catch(() => ({}))).error ?? '');
      else await res.body?.cancel();
    } catch (e) {
      code = e instanceof Error ? e.name : 'error';
    }
    const good = p.ok.includes(status);
    if (!good) ok = false;
    if (status === 403 && code === 'forbidden') stale = true;
    lines.push(`${good ? 'ok  ' : 'FAIL'} ${p.path} -> ${status || 'no answer'}${code ? ' ' + code : ''} (${p.reaches})`);
  }
  return { ok, stale, lines };
}

/**
 * Probes until every route answers as it should, or `tries` rounds `waitMs` apart have passed (a new
 * version takes a few seconds to reach every location). Returns the last round's result.
 */
export async function postDeployCheck({ origin, nodes = true, fetch = globalThis.fetch, tries = 4, waitMs = 5_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let last = await probeOnce({ origin, nodes, fetch });
  for (let i = 1; i < tries && !last.ok; i++) {
    await sleep(waitMs);
    last = await probeOnce({ origin, nodes, fetch });
  }
  return last;
}

/**
 * Run after a successful `wrangler deploy`: check, and when an object answered with old code, call
 * `redeploy()` (the same Wrangler run) once and check again. Returns the exit status for deploy.mjs.
 */
export async function checkAndHeal({ redeploy, origin, nodes = true, fetch, tries, waitMs, sleep, log = console.log }) {
  log(`deploy-check: probing ${origin}`);
  let res = await postDeployCheck({ origin, nodes, fetch, tries, waitMs, sleep });
  for (const l of res.lines) log('deploy-check: ' + l);
  if (res.ok) return 0;
  if (res.stale) {
    log('deploy-check: a Durable Object still runs the code before this deploy (403 forbidden). Deploying the same build once more to restart it.');
    const again = redeploy();
    if (again !== 0) return again;
    res = await postDeployCheck({ origin, nodes, fetch, tries, waitMs, sleep });
    for (const l of res.lines) log('deploy-check: ' + l);
    if (res.ok) return 0;
  }
  log('deploy-check: FAILED. The new version is live; look at the routes above (npx wrangler tail) before deploying again.');
  return 1;
}
