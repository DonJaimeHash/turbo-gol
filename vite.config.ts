import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// The local Worker's port (`wrangler dev`, 8787 by default): another one for a second checkout's
// own Worker beside the first (TG_API_PORT=8796 npx vite --port 5240).
const API = '127.0.0.1:' + (process.env.TG_API_PORT ?? '8787');

/**
 * Where the dev server listens: only this machine, unless TG_LAN=1 asks for every interface (a
 * phone or a TV on the same Wi-Fi: `TG_LAN=1 npm run dev`, or `npx vite --host`). On the network,
 * anyone on it can load the repo's files and reach the local Worker through the proxy below.
 */
export function devServerHost(env: Record<string, string | undefined> = process.env): string | true {
  return env.TG_LAN === '1' ? true : '127.0.0.1';
}

/** A directory as a literal glob (Vite matches server.fs.deny against absolute paths with picomatch). */
function literalGlob(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/[()[\]{}!*?+@]/g, (c) => `[${c}]`);
}

/**
 * What the dev server never serves, under any URL (encoded ones included: Vite decodes before it
 * checks): Vite's own defaults first, since a list replaces them, then this repo's secrets and
 * local state. The folders are anchored at the root: a checkout may itself sit inside a folder
 * called private or .claude (.claude/worktrees/...), and a bare '**' rule would refuse all of it.
 */
export function devServerDeny(root: string): string[] {
  const r = literalGlob(resolve(root));
  return [
    // Vite 8's defaults.
    '.env',
    '.env.*',
    '*.{crt,pem,key,p12,pfx,cer,der}',
    '.npmrc',
    '.yarnrc.yml',
    '**/.git/**',
    // wrangler dev: its secrets (server/.dev.vars) and local state (the accounts' SQLite).
    '.dev.vars',
    '.dev.vars.*',
    '**/.wrangler/**',
    // The community nodes: keys, a node's identity and traffic counter, its local data (nodes/.gitignore).
    '**/.keys/**',
    'node.json',
    'egress.json',
    `${r}/nodes/data/**`,
    // The maintainer's private folder, and the local assistant and editor configs and worktrees.
    `${r}/private/**`,
    `${r}/.claude/**`,
  ];
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** server.fs.deny for the root Vite actually serves, and a warning whenever the server is on the network. */
function devServerSafety(): Plugin {
  return {
    name: 'turbogol:dev-server-safety',
    apply: 'serve',
    config: (c) => ({ server: { fs: { deny: devServerDeny(c.root ?? process.cwd()) } } }),
    configureServer(server) {
      const host = server.config.server.host;
      if (host === undefined || (typeof host === 'string' && LOOPBACK.has(host))) return;
      server.config.logger.warn(
        '\n  Turbogol: the dev server is on the network (TG_LAN=1 or --host). Every device on this network\n' +
          '  can load the game, the source and the local Worker through it (secrets stay refused). Use it\n' +
          '  only on a network you trust, and stop it when the test on the phone or the TV is done.\n',
      );
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [devServerSafety()],
  server: {
    host: devServerHost(),
    port: 5173,
    headers: {
      // Enable cross-origin isolation so SharedArrayBuffer / high-resolution timers are available
      // (future-proofing for a physics worker; harmless otherwise). WebSockets are not subject to
      // COEP, so the /ws proxy below works with these headers in place.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // Online mode (docs/online/PHASE1.md, PHASE2.md): the Worker runs under `wrangler dev` (API);
    // the browser talks to the same origin and Vite forwards the control plane, the community
    // nodes' routes (/nodes: PERFIL's MI SERVIDOR), the match sockets (/ws, phase 1), the P2P
    // signaling sockets (/room, phase 2) and the lobby sockets (/lobby).
    proxy: {
      '/api': { target: 'http://' + API, changeOrigin: true },
      // Not the modules Vite serves from the nodes/ folder itself (PERFIL reads PROBATION_MATCHES there).
      '^/nodes/(?!.*\\.[cm]?[jt]s(\\?|$))': { target: 'http://' + API, changeOrigin: true },
      '/ws': { target: 'ws://' + API, ws: true, changeOrigin: true },
      '/room': { target: 'ws://' + API, ws: true, changeOrigin: true },
      // Custom-match lobby sockets (LobbyDO).
      '/lobby': { target: 'ws://' + API, ws: true, changeOrigin: true },
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
    rollupOptions: {
      // The game, and the replay viewer (src/replay/main.ts): its own page, reached from PROFILE.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        replay: fileURLToPath(new URL('./replay.html', import.meta.url)),
      },
      output: {
        // Vite 8 (Rolldown) only accepts the function form.
        manualChunks: (id: string): string | undefined => (id.includes('/node_modules/three/') ? 'three' : undefined),
      },
    },
  },
  optimizeDeps: {
    exclude: ['rocketsim'],
  },
  assetsInclude: ['**/*.wasm'],
});
