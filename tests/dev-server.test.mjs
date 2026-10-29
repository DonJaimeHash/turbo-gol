// The Vite dev server (vite.config.ts) stays on this machine unless asked, and never serves the
// repo's secrets: wrangler's .dev.vars and local state, the nodes' keys, private/ and .claude/,
// under any URL (an encoded one like /%6Eodes/.keys/ skips the /nodes proxy and reaches the files).
// A real Vite server on a throwaway root with dummy files, on a port the system picks; nothing it
// is asked for goes through the proxy.
//   node --test tests/dev-server.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = join(ROOT, 'vite.config.ts');
// The proxy's target, should anything reach it: the discard port, where nothing listens.
process.env.TG_API_PORT = '9';
delete process.env.TG_LAN;

const SECRET = 'DUMMY-SECRET-7f3a';

test('the dev server listens on 127.0.0.1 unless TG_LAN=1 asks for the network', async () => {
  const mod = await import(pathToFileURL(CONFIG).href);
  assert.equal(mod.default.server.host, '127.0.0.1');
  assert.equal(mod.devServerHost({}), '127.0.0.1');
  assert.equal(mod.devServerHost({ TG_LAN: '0' }), '127.0.0.1');
  assert.equal(mod.devServerHost({ TG_LAN: '1' }), true);
});

test("the dev server refuses the repo's secrets under every URL, and still serves the game", async (t) => {
  const { createServer } = await import('vite');
  // A checkout inside folders named private and .claude (like .claude/worktrees/<name>): only the
  // root's own private/ and .claude/ are refused, never the whole checkout.
  const base = mkdtempSync(join(realpathSync.native(tmpdir()), 'tg-devsrv-'));
  const root = join(base, 'private', '.claude', 'worktrees', 'x');
  const put = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put('index.html', '<!doctype html><title>OK-INDEX</title><script type="module" src="/src/main.ts"></script>');
  put('src/main.ts', "export const marker: string = 'OK-SRC';\n");
  put('nodes/shared/probation.ts', "export const marker: string = 'OK-NODES';\n");
  for (const rel of [
    'server/.dev.vars',
    'server/.dev.vars.production',
    'server/.env',
    'server/.wrangler/state/v3/do/accounts.sqlite',
    'private/discord/notes.txt',
    '.claude/settings.local.json',
    'nodes/.keys/control.json',
    'nodes/.keys/release.json',
    'nodes/node.json',
    'nodes/egress.json',
    'nodes/data/ledger.json',
    'nodes/tls.key',
  ])
    put(rel, `${SECRET} ${rel}\n`);

  const server = await createServer({
    configFile: CONFIG,
    root,
    logLevel: 'silent',
    cacheDir: join(base, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(async () => {
    await server.close();
    rmSync(base, { recursive: true, force: true });
  });
  await server.listen();
  const { port } = server.httpServer.address();
  const get = async (path) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { host: `192.168.0.23:${port}` } });
    return { status: r.status, body: await r.text() };
  };

  const fsRoot = root.replaceAll('\\', '/');
  const refused = [
    '/server/.dev.vars',
    '/server/%2Edev.vars',
    '/server/.dev.vars?raw',
    '/server/.dev.vars?import&raw',
    '/server/.dev.vars?url',
    // Windows spellings of the same file (case, a trailing dot, a stream, a backslash) and a '..'.
    '/server/.DEV.VARS',
    '/server/.dev.vars.',
    '/server/.dev.vars::$DATA',
    '/server%5C.dev.vars',
    '/src/%2E%2E/server/.dev.vars',
    '/server/.dev.vars.production',
    '/server/.env',
    '/server/.wrangler/state/v3/do/accounts.sqlite',
    '/server/%2Ewrangler/state/v3/do/accounts.sqlite',
    '/private/discord/notes.txt',
    '/%70rivate/discord/notes.txt',
    '/private./discord/notes.txt',
    '/.claude/settings.local.json',
    '/%2Eclaude/settings.local.json',
    '/%6Eodes/.keys/control.json',
    '/%6Eodes/.keys/release.json',
    '/%6Eodes/%2Ekeys/release.json',
    '/%6Eodes/node.json',
    '/%6Eodes/egress.json',
    '/%6Eodes/data/ledger.json',
    '/%6Eodes/tls.key',
    `/@fs/${fsRoot.replace(/^\//, '')}/server/.dev.vars`,
    `/@fs/${fsRoot.replace(/^\//, '')}/private/discord/notes.txt`,
  ];
  const served = [];
  for (const path of refused) {
    const r = await get(path);
    if (r.body.includes(SECRET)) served.push(`${path} -> ${r.status}`);
  }
  assert.deepEqual(served, [], 'secrets the dev server served');

  // The game itself still loads: the page, its modules and the nodes/ modules PERFIL imports.
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.body, /OK-INDEX/);
  const main = await get('/src/main.ts');
  assert.equal(main.status, 200);
  assert.match(main.body, /OK-SRC/);
  const nodes = await get('/nodes/shared/probation.ts');
  assert.equal(nodes.status, 200);
  assert.match(nodes.body, /OK-NODES/);
});

test('the dev server warns when it is on the network, and only then', async (t) => {
  const { createLogger, createServer } = await import('vite');
  const base = mkdtempSync(join(realpathSync.native(tmpdir()), 'tg-devsrv-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(join(base, 'index.html'), '<!doctype html><title>x</title>');
  // middlewareMode: the plugins' configureServer runs, nothing listens on any interface.
  const warnings = async (host) => {
    const said = [];
    const logger = { ...createLogger('silent'), warn: (m) => said.push(String(m)), warnOnce: (m) => said.push(String(m)) };
    const server = await createServer({
      configFile: CONFIG,
      root: base,
      customLogger: logger,
      cacheDir: join(base, 'vite-cache'),
      server: { host, middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    await server.close();
    return said.filter((m) => /on the network/.test(m));
  };
  assert.equal((await warnings(true)).length, 1, 'host true (TG_LAN=1, --host)');
  assert.equal((await warnings('0.0.0.0')).length, 1, 'host 0.0.0.0');
  assert.deepEqual(await warnings('127.0.0.1'), []);
  assert.deepEqual(await warnings('localhost'), []);
});
