import fs from 'node:fs';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const { SSL_KEY, SSL_CERT } = process.env;
const tls = SSL_KEY && SSL_CERT ? { key: fs.readFileSync(SSL_KEY), cert: fs.readFileSync(SSL_CERT) } : null;
const s = createApp({ tls });
const p = await s.listen(port);
console.log(`SyncWave server listening on ${tls ? 'https' : 'http'}://0.0.0.0:${p}`);
