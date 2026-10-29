// `npm run deploy` (after `npm run build`): deploys the Worker from server/ with Wrangler and adds
// the deployment-specific values that are not committed:
//   VITE_ORIGINS   optional override of the allowed browser origins (comma-separated); without it
//                  the value in server/wrangler.jsonc (https://turbo-gol.com) is used
// Put it in the environment, or in server/.env (git-ignored), which is read here if present.
// Credentials (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID) come from the environment or server/.env
// as Wrangler expects; this script never prints them.
//
// Before `wrangler deploy`, the node-release gate (scripts/node-release-gate.mjs) checks that the
// community nodes will run this build's game code, and moves their release channel when they need a
// new release. It reads R2 with the same credentials. A deployment without a published node release
// (a fork, or before the first one) deploys with `npm run deploy -- --nodes-off`.
//
// After `wrangler deploy`, scripts/deploy-check.mjs sends one public GET per kind of Durable Object to
// the deployed origin (DEPLOY_CHECK_ORIGIN, else the first VITE_ORIGINS entry, else turbo-gol.com).
// An object that answers 403 'forbidden' still runs the code before the deploy, so the same build is
// deployed once more and checked again. `--no-check` skips it (a fork whose origin is not public yet).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wranglerR2 } from '../nodes/scripts/channel.mjs';
import { checkAndHeal } from './deploy-check.mjs';
import { gatedDeploy, gitRunner } from './node-release-gate.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(root, 'server');
const unknown = process.argv.slice(2).filter((a) => a !== '--nodes-off' && a !== '--no-check');
if (unknown.length > 0) {
  console.error(`deploy: unknown option ${unknown.join(' ')} (the options are --nodes-off and --no-check)`);
  process.exit(1);
}
const envFile = join(server, '.env');
const env = { ...process.env };
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const args = ['wrangler', 'deploy'];
if (env.VITE_ORIGINS) {
  // Public configuration, not a secret: say what is being deployed.
  const origins = env.VITE_ORIGINS.replace(/\s+/g, '');
  console.log(`deploy: VITE_ORIGINS override = ${origins}`);
  args.push('--var', `VITE_ORIGINS:${origins}`);
}
const nodesOff = process.argv.includes('--nodes-off');
const wranglerDeploy = () => spawnSync('npx', args, { cwd: server, env, stdio: 'inherit', shell: process.platform === 'win32' }).status ?? 1;
const origin = (env.DEPLOY_CHECK_ORIGIN || (env.VITE_ORIGINS ?? '').split(',')[0] || 'https://turbo-gol.com').trim().replace(/\/+$/, '');
// The gate calls deploy() at most once; the check runs only after a Wrangler run that succeeded.
let deployed = false;
const status = gatedDeploy({
  repo: root,
  nodesOff,
  git: gitRunner(root),
  r2: wranglerR2({ server, env }),
  deploy: () => {
    const s = wranglerDeploy();
    deployed = s === 0;
    return s;
  },
});
if (status !== 0 || !deployed || process.argv.includes('--no-check')) process.exit(status);
process.exit(await checkAndHeal({ redeploy: wranglerDeploy, origin, nodes: !nodesOff }));
