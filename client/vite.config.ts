import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Optional HTTPS (needed for mic / tab capture on phones over LAN): set SSL_KEY and SSL_CERT
// to PEM paths for both the Vite dev server and the SyncWave server (which then serves https/wss).
const { SSL_KEY, SSL_CERT } = process.env;
const tls = SSL_KEY && SSL_CERT ? { key: fs.readFileSync(SSL_KEY), cert: fs.readFileSync(SSL_CERT) } : undefined;
const target = `${tls ? 'https' : 'http'}://localhost:3000`;

// Stamps the service worker with a build id and the list of built, hashed assets to precache.
function swStamp(): Plugin {
  let outDir = 'dist';
  return {
    name: 'syncwave-sw-stamp',
    apply: 'build',
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir); },
    closeBundle() {
      const f = path.join(outDir, 'sw.js');
      if (!fs.existsSync(f)) return;
      const assetsDir = path.join(outDir, 'assets');
      const assets = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).map((n) => '/assets/' + n) : [];
      const list = ['/', '/offline.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', ...assets];
      const id = Date.now().toString(36);
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('__BUILD_ID__', id).replace(/\/\*__PRECACHE__\*\/\s*\[[^\]]*\]/, JSON.stringify(list)));
    },
  };
}

export default defineConfig({
  plugins: [react(), swStamp()],
  server: {
    https: tls,
    proxy: {
      '/api': { target, secure: false },
      '/media': { target, secure: false },
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true, secure: false },
    },
  },
});
