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
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wranglerR2 } from '../nodes/scripts/channel.mjs';
import { gatedDeploy, gitRunner } from './node-release-gate.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(root, 'server');
const unknown = process.argv.slice(2).filter((a) => a !== '--nodes-off');
if (unknown.length > 0) {
  console.error(`deploy: unknown option ${unknown.join(' ')} (the only one is --nodes-off)`);
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
const status = gatedDeploy({
  repo: root,
  nodesOff: process.argv.includes('--nodes-off'),
  git: gitRunner(root),
  r2: wranglerR2({ server, env }),
  deploy: () => spawnSync('npx', args, { cwd: server, env, stdio: 'inherit', shell: process.platform === 'win32' }).status ?? 1,
});
process.exit(status);
