import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';

function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-host-'));
  const dist = path.join(dir, 'dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>x</title>');
  fs.writeFileSync(path.join(dist, 'sw.js'), '//sw');
  fs.writeFileSync(path.join(dist, 'manifest.webmanifest'), '{"name":"x"}');
  fs.writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
  const s = createApp({ uploadDir: path.join(dir, 'up'), clientDist: dist, ...opts });
  return { dir, s };
}

test('healthz and cache headers', async (t) => {
  const { dir, s } = setup();
  const port = await s.listen(0, '127.0.0.1');
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`);

  const h = await get('/healthz');
  assert.equal(h.status, 200);
  assert.equal((await h.json()).ok, true);

  assert.match((await get('/assets/index-abc123.js')).headers.get('cache-control'), /immutable/);
  assert.equal((await get('/')).headers.get('cache-control'), 'no-cache');
  assert.equal((await get('/index.html')).headers.get('cache-control'), 'no-cache');
  assert.equal((await get('/sw.js')).headers.get('cache-control'), 'no-cache');
  assert.equal((await get('/room/ABCDE')).headers.get('cache-control'), 'no-cache'); // SPA fallback
  assert.match((await get('/manifest.webmanifest')).headers.get('content-type'), /application\/manifest\+json/);
});

test('upload cap evicts oldest, rate limit returns 429', async (t) => {
  const { dir, s } = setup({ maxUploadTotalMb: 1, uploadsPerWindow: 4 });
  const port = await s.listen(0, '127.0.0.1');
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  const { roomId, hostToken } = await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json();
  const up = (n) => fetch(`${base}/api/rooms/${roomId}/tracks`, {
    method: 'POST', headers: { 'x-token': hostToken, 'x-filename': `t${n}.mp3`, 'content-type': 'audio/mpeg' },
    body: Buffer.alloc(600 * 1024, 1),
  });
  const ids = [];
  for (let i = 0; i < 3; i++) { const r = await up(i); assert.equal(r.status, 200); ids.push((await r.json()).trackId); }
  assert.ok(!s.files.has(ids[0]), 'oldest evicted');
  assert.ok(!s.files.has(ids[1]), 'second evicted (600K+600K > 1MB)');
  assert.ok(s.files.has(ids[2]));
  assert.equal((await up(3)).status, 200);
  assert.equal((await up(4)).status, 429);
});

test('server pings sockets and drops dead ones', async (t) => {
  const { dir, s } = setup({ heartbeatMs: 80 });
  const port = await s.listen(0, '127.0.0.1');
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  let pings = 0;
  ws.on('ping', () => { pings++; });
  await new Promise((r) => ws.on('open', r));
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(pings >= 2, 'got heartbeat pings (auto-ponged)');
  assert.equal(ws.readyState, WebSocket.OPEN);

  const dead = new WebSocket(`ws://127.0.0.1:${port}/ws`, { autoPong: false });
  await new Promise((r) => dead.on('open', r));
  const closed = new Promise((r) => dead.on('close', r));
  await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('not dropped')), 1500))]);
  ws.close();
});
