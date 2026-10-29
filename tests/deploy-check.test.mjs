// The check after `wrangler deploy` (scripts/deploy-check.mjs, run by scripts/deploy.mjs): one public
// GET per kind of Durable Object; a 403 'forbidden' (an object on the code before the deploy) leads to
// one more deploy of the same build. A fake fetch and a fake sleep; nothing here talks to Cloudflare.
//   node --test tests/deploy-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkAndHeal, postDeployCheck, PROBES } from '../scripts/deploy-check.mjs';

const ORIGIN = 'https://example.test';

/** A fetch answering each path from `answers` (path -> [status, error] or a function of the call count). */
function fakeFetch(answers) {
  const calls = [];
  const fetch = async (url) => {
    const path = url.slice(ORIGIN.length);
    calls.push(path);
    const a = typeof answers === 'function' ? answers(path, calls.length) : answers[path] ?? [200];
    const [status, error] = a;
    return new Response(JSON.stringify(error ? { error, message: error } : { ok: true }), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const quiet = { sleep: async () => {}, log: () => {} };

test('a healthy deploy: every probe answers 200, no second deploy', async () => {
  const { fetch, calls } = fakeFetch({});
  let redeploys = 0;
  const status = await checkAndHeal({ redeploy: () => (redeploys++, 0), origin: ORIGIN, fetch, ...quiet });
  assert.equal(status, 0);
  assert.equal(redeploys, 0);
  assert.deepEqual(calls, PROBES.map((p) => p.path));
});

test('an object on the old code (403 forbidden) gets the same build deployed once more, then passes', async () => {
  let redeployed = false;
  const { fetch } = fakeFetch((path) => (path === '/nodes/status' && !redeployed ? [403, 'forbidden'] : [200]));
  let redeploys = 0;
  const status = await checkAndHeal({ redeploy: () => ((redeployed = true), redeploys++, 0), origin: ORIGIN, fetch, tries: 2, ...quiet });
  assert.equal(status, 0);
  assert.equal(redeploys, 1);
});

test('still stale after the second deploy: exit 1, and never a third deploy', async () => {
  const { fetch } = fakeFetch({ '/nodes/status': [403, 'forbidden'] });
  let redeploys = 0;
  const status = await checkAndHeal({ redeploy: () => (redeploys++, 0), origin: ORIGIN, fetch, tries: 2, ...quiet });
  assert.equal(status, 1);
  assert.equal(redeploys, 1);
});

test('any other failure (a 503, no answer) is reported, never redeployed', async () => {
  const { fetch } = fakeFetch({ '/api/population': [503, 'do_disabled'] });
  let redeploys = 0;
  const lines = [];
  const status = await checkAndHeal({ redeploy: () => (redeploys++, 0), origin: ORIGIN, fetch, tries: 3, sleep: async () => {}, log: (l) => lines.push(l) });
  assert.equal(status, 1);
  assert.equal(redeploys, 0);
  assert.ok(lines.some((l) => l.includes('FAIL /api/population -> 503 do_disabled')), lines.join('\n'));
  const thrown = await postDeployCheck({ origin: ORIGIN, fetch: async () => { throw new TypeError('fetch failed'); }, tries: 1, ...quiet });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.stale, false);
});

test('a slow rollout: a probe that fails once and then answers passes without a second deploy', async () => {
  const seen = new Map();
  const { fetch } = fakeFetch((path) => {
    const n = (seen.get(path) ?? 0) + 1;
    seen.set(path, n);
    return path === '/api/leaderboard?playlist=1v1' && n === 1 ? [500, 'internal'] : [200];
  });
  let redeploys = 0;
  assert.equal(await checkAndHeal({ redeploy: () => (redeploys++, 0), origin: ORIGIN, fetch, tries: 3, ...quiet }), 0);
  assert.equal(redeploys, 0);
});

test('--nodes-off skips the node registry probe', async () => {
  const { fetch, calls } = fakeFetch({ '/nodes/status': [403, 'forbidden'] });
  assert.equal((await postDeployCheck({ origin: ORIGIN, nodes: false, fetch, tries: 1, ...quiet })).ok, true);
  assert.ok(!calls.includes('/nodes/status'));
});

test('deploy.mjs runs the check after a Wrangler run that succeeded, with --no-check to skip it', () => {
  const src = readFileSync(new URL('../scripts/deploy.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{ checkAndHeal \} from '\.\/deploy-check\.mjs'/);
  assert.match(src, /if \(status !== 0 \|\| !deployed \|\| process\.argv\.includes\('--no-check'\)\) process\.exit\(status\);/);
  assert.match(src, /checkAndHeal\(\{ redeploy: wranglerDeploy, origin, nodes: !nodesOff \}\)/);
});
