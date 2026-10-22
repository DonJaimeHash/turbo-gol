// Shared by scripts/bot-bench.mjs (matches) and scripts/bot-skills.mjs (scenarios): loads the bots
// of this working tree and of any git revision side by side, plus the sim modules.
//
//   loadBots(null)        this tree's src/ai           -> { Bot, BotTeam, TUNING, DIFFICULTY_PARAMS, ... }
//   loadBots('origin/main') that revision's src/ai, copied into a temporary folder: every .ts file
//                           under src/ai (subfolders too), its imports of anything outside src/ai
//                           rewritten to this tree's files (the revision's bots run on this tree's
//                           sim: a bench across a sim API change needs a revision with that API)
//   applyOverrides(mod, 'key=value,...', 'difficulty.key=value,...')  TUNING / DIFFICULTY_PARAMS
//   loadSim()             { RocketSim, buildArenaMesh, C (constants), T (types) }
//
// Importing this module first installs the resolve hook the TypeScript sources need (imports
// without an extension resolve to .ts), like the node tests do.
import { registerHooks } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const local = specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('file:');
      if (local && err && err.code === 'ERR_MODULE_NOT_FOUND') {
        if (!/\.[a-z]+$/i.test(specifier)) return nextResolve(specifier + '.ts', context);
        if (specifier.endsWith('.js')) return nextResolve(specifier.slice(0, -3) + '.ts', context);
      }
      throw err;
    }
  },
});

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `--name=value` (or `--name value`) from the command line, else `def`. */
export function arg(name, def) {
  const argv = process.argv;
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  if (a !== undefined) return a.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
}

/** 'true' / 'false' / a number. */
export function parseValue(v) {
  return v === 'true' ? true : v === 'false' ? false : Number(v);
}

const fileUrl = (rel) => pathToFileURL(join(root, rel)).href;

/** This tree's bots (ref null) or a git revision's. Returns the Bot module plus BotTeam / TEAM_TUNING. */
export async function loadBots(ref) {
  if (ref === null) {
    const bot = await import(fileUrl('src/ai/Bot.ts'));
    const team = await import(fileUrl('src/ai/Team.ts'));
    return { ...bot, ...team, label: 'working tree' };
  }
  const sha = execFileSync('git', ['rev-parse', '--short', ref], { cwd: root, encoding: 'utf8' }).trim();
  const dir = join(tmpdir(), 'turbogol-bot-revisions', sha);
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', sha, 'src/ai'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.ts'));
  for (const f of files) {
    let src = execFileSync('git', ['show', `${sha}:${f}`], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
    src = src.replace(/(from\s+|import\s*\(\s*)'(\.\.?\/[^']+)'/g, (m, head, spec) => {
      const target = posix.normalize(posix.join(posix.dirname(f), spec));
      if (target.startsWith('src/ai/')) return m; // stays inside the copied tree
      return `${head}'${fileUrl(target)}'`;
    });
    const out = join(dir, f);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, src);
  }
  const base = (rel) => pathToFileURL(join(dir, rel)).href;
  const bot = await import(base('src/ai/Bot.ts'));
  const team = await import(base('src/ai/Team.ts'));
  return { ...bot, ...team, label: `${ref} ${sha}` };
}

/** Override TUNING keys ('k=v,k2=v2') and DIFFICULTY_PARAMS entries ('hard.k=v,...') of a bots module. */
export function applyOverrides(mod, tune, params) {
  for (const kv of (tune ?? '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    if (!(k in mod.TUNING)) throw new Error('unknown TUNING key ' + k);
    mod.TUNING[k] = parseValue(v);
  }
  for (const kv of (params ?? '').split(',').filter(Boolean)) {
    const [path, v] = kv.split('=');
    const [d, k] = path.split('.');
    if (!(d in mod.DIFFICULTY_PARAMS) || !(k in mod.DIFFICULTY_PARAMS[d])) throw new Error('unknown param ' + path);
    mod.DIFFICULTY_PARAMS[d][k] = parseValue(v);
  }
}

/** The sim modules and a RocketSim loaded with our arena. */
export async function loadSim() {
  const { RocketSim } = await import(fileUrl('src/sim/RocketSimBridge.ts'));
  const { buildArenaMesh } = await import(fileUrl('src/sim/arenaMesh.ts'));
  const C = await import(fileUrl('src/sim/constants.ts'));
  const T = await import(fileUrl('src/sim/types.ts'));
  const sim = await RocketSim.load();
  sim.initArena(buildArenaMesh().physics);
  return { sim, C, T };
}

/**
 * A's share of the points (win 1, draw 0.5) over n matches with its 95 % Wilson interval and the
 * Elo difference it implies: how much a result means, given the noise of a few dozen matches.
 */
export function scoreSummary(w, d, l) {
  const n = w + d + l;
  if (n === 0) return { score: 0, lo: 0, hi: 0, elo: 0, text: 'no matches' };
  const p = (w + d / 2) / n;
  const z = 1.96;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  const elo = (q) => (q <= 0 ? -Infinity : q >= 1 ? Infinity : -400 * Math.log10(1 / q - 1));
  const lo = Math.max(0, centre - half);
  const hi = Math.min(1, centre + half);
  const fmtElo = (e) => (Number.isFinite(e) ? `${e >= 0 ? '+' : ''}${e.toFixed(0)}` : e > 0 ? '+inf' : '-inf');
  const verdict = lo > 0.5 ? 'A better' : hi < 0.5 ? 'A worse' : 'no clear difference';
  return {
    score: p,
    lo,
    hi,
    elo: elo(p),
    text: `score ${(100 * p).toFixed(0)} % [95 % ${(100 * lo).toFixed(0)}-${(100 * hi).toFixed(0)}], Elo ${fmtElo(elo(p))} [${fmtElo(elo(lo))}, ${fmtElo(elo(hi))}]: ${verdict}`,
  };
}
