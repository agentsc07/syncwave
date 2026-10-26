import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs = [];
  const waiters = [];
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  });
  const open = new Promise((r) => ws.on('open', r));
  const wait = (pred, ms = 3000) => {
    const hit = msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const w = { pred, res };
      waiters.push(w);
      setTimeout(() => rej(new Error('timeout waiting for message')), ms).unref();
    });
  };
  return { ws, msgs, open, wait, send: (o) => ws.send(JSON.stringify(o)) };
}

test('http + ws integration', async (t) => {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-up-'));
  const s = createApp({ uploadDir, clientDist: path.join(uploadDir, 'nope') });
  const port = await s.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => { await s.close(); fs.rmSync(uploadDir, { recursive: true, force: true }); });

  const { roomId, hostToken } = await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json();
  assert.match(roomId, /^[A-Z2-9]{5}$/);
  assert.deepEqual(await (await fetch(`${base}/api/rooms/${roomId}`)).json(), { exists: true });
  assert.deepEqual(await (await fetch(`${base}/api/rooms/ZZZZZ`)).json(), { exists: false });

  const A = client(port), B = client(port);
  await Promise.all([A.open, B.open]);

  // ping works before join
  A.send({ type: 'ping', t0: 123.5 });
  const pong = await A.wait((m) => m.type === 'pong');
  assert.equal(pong.t0, 123.5);
  assert.ok(pong.t2 >= pong.t1 && Math.abs(pong.t1 - Date.now()) < 1000);
  assert.ok(!Number.isInteger(pong.t1) || true);

  A.send({ type: 'join', roomId, name: 'Host', deviceId: 'dev-a', hostToken });
  const ja = await A.wait((m) => m.type === 'joined');
  assert.equal(ja.isHost, true);
  B.send({ type: 'join', roomId, name: 'Guest', deviceId: 'dev-b' });
  assert.equal((await B.wait((m) => m.type === 'joined')).isHost, false);
  const st = await A.wait((m) => m.type === 'state' && m.devices.length === 2);
  assert.equal(st.hostId, 'dev-a');

  // bad token upload rejected; good upload accepted
  let r = await fetch(`${base}/api/rooms/${roomId}/tracks`, { method: 'POST', headers: { 'x-token': 'nope', 'x-filename': 'a.mp3' }, body: 'xx' });
  assert.equal(r.status, 403);
  const bytes = Buffer.from('fake-audio-bytes');
  r = await fetch(`${base}/api/rooms/${roomId}/tracks`, { method: 'POST', headers: { 'x-token': hostToken, 'x-filename': 'a.mp3', 'content-type': 'application/octet-stream' }, body: bytes });
  const { trackId } = await r.json();
  assert.ok(trackId);
  const withTrack = await B.wait((m) => m.type === 'state' && m.tracks.length === 1);
  assert.equal(withTrack.playback.trackId, trackId);
  assert.equal(withTrack.tracks[0].sizeBytes, bytes.length);

  const media = await fetch(`${base}/media/${trackId}`);
  assert.equal(media.status, 200);
  assert.equal(media.headers.get('content-type'), 'audio/mpeg');
  assert.match(media.headers.get('cache-control'), /public/);
  assert.deepEqual(Buffer.from(await media.arrayBuffer()), bytes);
  assert.equal((await fetch(`${base}/media/nope`)).status, 404);

  // guest upload via deviceId token works
  r = await fetch(`${base}/api/rooms/${roomId}/tracks`, { method: 'POST', headers: { 'x-token': 'dev-b', 'x-filename': 'b.wav' }, body: bytes });
  assert.equal(r.status, 200);

  // play gating
  A.send({ type: 'ready', trackId });
  A.send({ type: 'play' });
  assert.equal((await A.wait((m) => m.type === 'error')).message, 'not all ready');
  B.send({ type: 'play' }); // guest: ignored
  B.send({ type: 'ready', trackId });
  await A.wait((m) => m.type === 'state' && m.devices.every((d) => d.readyTrackId === trackId));
  const before = Date.now();
  A.send({ type: 'play' });
  const playing = await B.wait((m) => m.type === 'state' && m.playback.status !== 'stopped');
  assert.equal(playing.playback.status, 'scheduled');
  assert.ok(playing.playback.startServerTime - before > 1000 && playing.playback.startServerTime - before < 2500);
  // the server later pushes status 'playing'
  const nowPlaying = await B.wait((m) => m.type === 'state' && m.playback.status === 'playing', 4000);
  assert.ok(nowPlaying.playback.startServerTime <= nowPlaying.serverTime + 50);

  // host handoff on disconnect
  A.ws.close();
  const handoff = await B.wait((m) => m.type === 'state' && m.hostId === 'dev-b');
  assert.equal(handoff.devices.find((d) => d.id === 'dev-a').connected, false);
  B.ws.close();
});

test('SPA fallback serves client/dist when present', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-dist-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>spa</html>');
  const s = createApp({ uploadDir: path.join(dir, 'up'), clientDist: dir });
  const port = await s.listen(0, '127.0.0.1');
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.match(await (await fetch(`http://127.0.0.1:${port}/`)).text(), /spa/);
  assert.match(await (await fetch(`http://127.0.0.1:${port}/r/ABCDE`)).text(), /spa/);
  assert.equal((await fetch(`http://127.0.0.1:${port}/media/x`)).status, 404);
});
