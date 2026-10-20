/**
 * turbogol-launcher (bundled alone as launcher.mjs; the only file install.sh puts in /opt).
 *
 *   register --control <url> --token <tgn1_...> --data <dir> [node register options]
 *        fetches + verifies the current release, then runs its `node.mjs register` (exit 3 when
 *        the release could not be had: the token was not used)
 *   run     --control <url> --data <dir> [-- <node run options>]
 *        the supervised loop (systemd ExecStart, the launchd agent, the Windows scheduled task).
 *        SIGTERM / SIGINT or a <data>/stop.request file: the node drains its matches and the
 *        launcher exits 0 (a second request stops at once). See launcher.ts.
 *
 * The release public key comes from --release-key, $TGN_RELEASE_KEY or <data>/release-key.pub
 * (written by install.sh from the key printed in the script itself), never from the network.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ReleaseChannel } from '../shared/controlProtocol';
import { ensureRelease, httpFetcher, launcherLoop } from './launcher';
import type { ReleaseManifest } from './launcher';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf('--' + name);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

/**
 * `register` could not get or verify the release, or it needs a newer Node.js: nothing reached the
 * control plane, so the one-time token is still unused (install.sh tells the operator so).
 */
const EXIT_NO_RELEASE = 3;

function die(msg: string, code = 2): never {
  console.error(`turbogol-launcher: ${msg}`);
  process.exit(code);
}

async function releaseKey(dataDir: string): Promise<string> {
  const k = arg('release-key') ?? process.env.TGN_RELEASE_KEY ?? (await readFile(join(dataDir, 'release-key.pub'), 'utf8').catch(() => ''));
  if (!k.trim()) die('no release key (--release-key, $TGN_RELEASE_KEY or <data>/release-key.pub)');
  return k.trim();
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const control = (arg('control') ?? die('--control <url> is required')).replace(/\/$/, '');
  const dataDir = resolve(arg('data') ?? die('--data <dir> is required'));
  const key = await releaseKey(dataDir);
  if (cmd === 'run') {
    const dash = process.argv.indexOf('--');
    process.exit(await launcherLoop({ control, dataDir, releaseKey: key, runArgs: dash > 0 ? process.argv.slice(dash + 1) : [] }));
  }
  if (cmd === 'register') {
    let m: ReleaseManifest;
    try {
      const channel = await httpFetcher.json<ReleaseChannel>(`${control}/nodes/releases/channel`);
      m = await ensureRelease(control, dataDir, channel.stable, key);
    } catch (e) {
      // Not die(): process.exit() just after a fetch can abort Node.js on Windows (a libuv
      // assertion, exit 0xC0000409) and lose the code. The process ends by itself.
      console.error(`turbogol-launcher: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = EXIT_NO_RELEASE;
      return;
    }
    const entry = join(dataDir, 'releases', m.version, m.entry);
    const pass = process.argv.slice(3);
    const child = spawn(process.execPath, [entry, 'register', ...pass], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 1));
    return;
  }
  die('usage: turbogol-launcher <register|run> --control <url> --data <dir> ...');
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
