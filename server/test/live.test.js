import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs = [], bins = [], waiters = [];
  ws.on('message', (d, isBinary) => {
    if (isBinary) { bins.push(Buffer.from(d)); return; }
    const m = JSON.parse(d.toString());
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  });
  const open = new Promise((r) => ws.on('open', r));
  const wait = (pred, ms = 3000) => {
    const hit = msgs.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      waiters.push({ pred, res });
      setTimeout(() => rej(new Error('timeout')), ms).unref();
    });
  };
  const waitLast = (pred, ms = 3000) => { // only messages arriving after now
    const n = msgs.length;
    return wait((m) => msgs.indexOf(m) >= n && pred(m), ms);
  };
  return { ws, msgs, bins, open, wait, waitLast, send: (o) => ws.send(JSON.stringify(o)) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function frame(seq) {
  const b = Buffer.alloc(20 + 8);
  b[0] = 1; b[1] = 1; b.writeUInt16LE(4, 2); b.writeUInt32LE(seq, 4); b.writeDoubleLE(Date.now(), 8); b.writeUInt32LE(48000, 16);
  return b;
}

test('live relay: host frames reach guests only, host-only control, stop on host disconnect', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-live-'));
  const s = createApp({ uploadDir: dir, clientDist: path.join(dir, 'nope') });
  const port = await s.listen(0, '127.0.0.1');
  t.after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const { roomId, hostToken } = await (await fetch(`http://127.0.0.1:${port}/api/rooms`, { method: 'POST' })).json();

  const H = client(port), G1 = client(port), G2 = client(port);
  await Promise.all([H.open, G1.open, G2.open]);
  H.send({ type: 'join', roomId, name: 'H', deviceId: 'h', hostToken });
  G1.send({ type: 'join', roomId, name: 'G1', deviceId: 'g1' });
  G2.send({ type: 'join', roomId, name: 'G2', deviceId: 'g2' });
  await H.wait((m) => m.type === 'state' && m.devices.length === 3);

  // frames before liveStart are dropped
  H.ws.send(frame(0));
  // guest cannot start live
  G1.send({ type: 'liveStart', kind: 'share' });
  await sleep(100);
  assert.equal(G1.bins.length, 0);
  assert.equal(H.msgs.at(-1).live ?? null, null);

  H.send({ type: 'liveStart', kind: 'share', bufferMs: 99999 });
  const st = await G1.wait((m) => m.type === 'state' && m.live);
  assert.deepEqual(st.live, { kind: 'share', sourceId: 'h', bufferMs: 3000 });
  assert.equal(st.playback.status, 'stopped');

  H.ws.send(frame(1)); H.ws.send(frame(2));
  G2.ws.send(frame(99)); // non-source: ignored
  H.ws.send(Buffer.from('junk')); // too short: ignored
  await sleep(200);
  assert.equal(G1.bins.length, 2);
  assert.equal(G2.bins.length, 2);
  assert.equal(H.bins.length, 0); // never echoed to source
  assert.equal(G1.bins[0].readUInt32LE(4), 1);

  // buffer adjust (host only)
  G1.send({ type: 'liveBuffer', ms: 900 });
  H.send({ type: 'liveBuffer', ms: 100 });
  const adj = await G2.wait((m) => m.type === 'state' && m.live?.bufferMs === 800);
  assert.equal(adj.live.kind, 'share');

  // play is refused during a live share
  H.send({ type: 'play' });
  assert.equal((await H.wait((m) => m.type === 'error')).message, 'live share active');

  H.send({ type: 'liveStop' });
  await G1.waitLast((m) => m.type === 'state' && m.live === null);
  H.ws.send(frame(3));
  await sleep(100);
  assert.equal(G1.bins.length, 2);

  // announce: default buffer, then host disconnect stops it
  H.send({ type: 'liveStart', kind: 'announce' });
  const an = await G1.waitLast((m) => m.type === 'state' && m.live);
  assert.equal(an.live.bufferMs, 700);

  // receivers report late chunks -> server raises the delay (rate limited), host's own report is ignored
  G1.send({ type: 'liveRx', played: 5, late: 5 }); // too few samples: no change
  G1.send({ type: 'liveRx', played: 20, late: 30 });
  const bumped = await G2.wait((m) => m.type === 'state' && m.live?.bufferMs === 1000);
  assert.deepEqual(bumped.devices.find((x) => x.id === 'g1').liveRx, { played: 20, late: 30 });
  const mark = G2.msgs.length;
  H.send({ type: 'liveRx', played: 1, late: 100 });
  await sleep(100);
  assert.equal(G2.msgs.slice(mark).filter((m) => m.type === 'state' && m.live?.bufferMs > 1000).length, 0);
  H.ws.close();
  const gone = await G1.waitLast((m) => m.type === 'state' && m.live === null);
  assert.ok(gone);
  G1.ws.close(); G2.ws.close();
});
