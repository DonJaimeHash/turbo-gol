// `npm run deploy` (after `npm run build`): deploys the Worker from server/ with Wrangler and adds
// the deployment-specific values that are not committed:
//   VITE_ORIGINS   optional override of the allowed browser origins (comma-separated); without it
//                  the value in server/wrangler.jsonc (https://turbo-gol.com) is used
// Put it in the environment, or in server/.env (git-ignored), which is read here if present.
// Credentials (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID) come from the environment or server/.env
// as Wrangler expects; this script never prints them.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(root, 'server');
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
const r = spawnSync('npx', args, { cwd: server, env, stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
