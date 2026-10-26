import fs from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Optional HTTPS (needed for mic / tab capture on phones over LAN): set SSL_KEY and SSL_CERT
// to PEM paths for both the Vite dev server and the SyncWave server (which then serves https/wss).
const { SSL_KEY, SSL_CERT } = process.env;
const tls = SSL_KEY && SSL_CERT ? { key: fs.readFileSync(SSL_KEY), cert: fs.readFileSync(SSL_CERT) } : undefined;
const target = `${tls ? 'https' : 'http'}://localhost:3000`;

export default defineConfig({
  plugins: [react()],
  server: {
    https: tls,
    proxy: {
      '/api': { target, secure: false },
      '/media': { target, secure: false },
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true, secure: false },
    },
  },
});
