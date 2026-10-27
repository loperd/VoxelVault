import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { WORLD_PACKS } from './src/config/world-packs.ts';

export default defineConfig({
  plugins: [
    react(),
    {
      // World packs are read file by file at run time (packs/<id>/): served from the repo in development;
      // into the build go only those the app offers, never the rest of packs/ (calibration, research).
      name: 'world-packs',
      apply: 'build',
      writeBundle(options) {
        for (const id of Object.keys(WORLD_PACKS))
          cpSync(resolve(import.meta.dirname, 'packs', id), resolve(options.dir!, 'packs', id), {
            recursive: true,
          });
      },
    },
  ],
  build: {
    // iPhone X remains on iOS 16; keep the minimum explicit as Vite's defaults move.
    target: ['safari16', 'chrome107', 'firefox104'],
    cssTarget: ['safari16', 'chrome107', 'firefox104'],
  },
  server: {
    // Dev over HTTPS through the Cloudflare tunnel (Telegram and passkeys need a real origin).
    allowedHosts: (process.env.VITE_ALLOWED_HOSTS ?? 'vault.loper.me')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
    // The Go API (server/, HTTP_ADDRESS=:8080 by default). Same origin for the browser, so the
    // session cookie and the WebAuthn origin check work in development as in production.
    proxy: {
      '/api':
        process.env.VITE_API_TARGET ??
        'http://voxel-vault-voxel-vault-gateway.voxel-vault.svc.cluster.local:8080',
    },
  },
});
