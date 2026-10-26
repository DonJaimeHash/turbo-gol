import { defineConfig } from 'vite';

/**
 * The local Worker's port (`wrangler dev`): 8787, or TG_API_PORT to run a second checkout beside it.
 * Pair it with `npx wrangler dev --port <n> --host 127.0.0.1:<n>`: without --host the Worker hands
 * out ws:// URLs on 8787 (wrangler.jsonc dev.host), so the match, room and lobby sockets would go to
 * the other checkout (server/README.md "Run locally").
 */
const API_PORT = Number(process.env.TG_API_PORT) || 8787;

export default defineConfig({
  base: './',
  server: {
    host: true,
    port: 5173,
    headers: {
      // Enable cross-origin isolation so SharedArrayBuffer / high-resolution timers are available
      // (future-proofing for a physics worker; harmless otherwise). WebSockets are not subject to
      // COEP, so the /ws proxy below works with these headers in place.
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    // Online mode (docs/online/PHASE1.md, PHASE2.md): the Worker runs under `wrangler dev` on 8787
    // (API_PORT); the browser talks to the same origin and Vite forwards the control plane, the match
    // sockets (/ws, phase 1), the P2P signaling sockets (/room, phase 2) and the lobby sockets (/lobby).
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true },
      '/ws': { target: `ws://127.0.0.1:${API_PORT}`, ws: true, changeOrigin: true },
      '/room': { target: `ws://127.0.0.1:${API_PORT}`, ws: true, changeOrigin: true },
      // Custom-match lobby sockets (LobbyDO).
      '/lobby': { target: `ws://127.0.0.1:${API_PORT}`, ws: true, changeOrigin: true },
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
