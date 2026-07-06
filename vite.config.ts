import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Vite build for the open-rc SPA (React + TypeScript + wouter).
 *
 * - root is `ui/`: `ui/index.html` is the entry, `ui/src/**` the source,
 *   `ui/public/**` the verbatim static assets (sw.js, manifest, icons).
 * - `vite build` emits `ui/dist/`, which `orc serve` hosts (see
 *   `src/serve.ts`); the SW there is stamped with a shell-rev fingerprint.
 * - `vite` (dev) serves the SPA with HMR on :5173 and proxies the relay's
 *   WebSocket + API routes to a `orc serve` running on :7322, so the two
 *   halves develop side by side. Run `bun run dev:relay` alongside `bun run dev`.
 */
export default defineConfig({
  root: 'ui',
  publicDir: 'public',
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // A manifest lets tooling map hashed asset names if ever needed;
    // harmless and cheap.
    manifest: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:7322', ws: true },
      '/agent': { target: 'ws://127.0.0.1:7322', ws: true },
      '/api': 'http://127.0.0.1:7322',
      '/health': 'http://127.0.0.1:7322',
    },
  },
});
