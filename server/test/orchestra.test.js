import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';
import { Room, RoomManager } from '../src/room.js';
import { autoAssign, STEMS } from '../src/orchestra.js';
import { createApp } from '../src/app.js';

// ---------- pure auto-assign ----------
const dv = (...xs) => xs.map((x, i) => ({ id: 'd' + i, x, order: i }));
const asObj = (m) => Object.fromEntries(m);

test('autoAssign: 1, 2, 3, 4, 6 devices', () => {
  assert.deepEqual(asObj(autoAssign([])), {});
  assert.deepEqual(asObj(autoAssign(dv(0.5))), { d0: null });
  // 2 devices: leftmost vocals+other, other drums+bass (x decides, not join order)
  assert.deepEqual(asObj(autoAssign(dv(0.9, 0.1))), { d1: ['vocals', 'other'], d0: ['drums', 'bass'] });
  // 3 devices: nothing is orphaned
  const three = asObj(autoAssign(dv(0.1, 0.5, 0.9)));
  assert.deepEqual(three, { d0: ['vocals', 'other'], d1: ['drums'], d2: ['bass'] });
  // 4: left to right vocals, drums, bass, other
  assert.deepEqual(asObj(autoAssign(dv(0.4, 0.1, 0.3, 0.2))), { d1: ['vocals'], d3: ['drums'], d2: ['bass'], d0: ['other'] });
  // 6: round-robin sharing, every stem covered at least once, ties broken by join order
  const six = autoAssign(dv(0.5, 0.5, 0.5, 0.5, 0.5, 0.5));
  assert.deepEqual(asObj(six), { d0: ['vocals'], d1: ['drums'], d2: ['bass'], d3: ['other'], d4: ['vocals'], d5: ['drums'] });
});

// ---------- Room behaviour ----------
function setup(hooks) {
  let t = 1_000_000;
  const room = new Room('ABCDE', { clock: () => t, hooks });
  const mk = (id, token, x) => {
    const inbox = [];
    room.join({ deviceId: id, name: id, hostToken: token }, { send: (m) => inbox.push(m), close() {} });
    if (x != null) room.handle('host', { type: 'setChannel', deviceId: id, channel: 'stereo', x, y: 0.5 });
    return { inbox, errors: () => inbox.filter((m) => m.type === 'error').map((m) => m.message) };
  };
  return { room, mk, advance: (ms) => { t += ms; } };
}
const stemsOf = (room) => Object.fromEntries([...room.devices.values()].map((d) => [d.id, d.stems]));

test('auto-assign follows join, move, leave and hostPlaysAll', () => {
  const { room, mk } = setup();
  const host = mk('host', room.hostToken);
  room.handle('host', { type: 'orchestraSet', enabled: true });
  assert.equal(room.snapshot().orchestra.enabled, true);
  assert.deepEqual(stemsOf(room), { host: null });
  mk('b', undefined, 0.9);
  room.handle('host', { type: 'setChannel', deviceId: 'host', channel: 'stereo', x: 0.1, y: 0.5 });
  assert.deepEqual(stemsOf(room), { host: ['vocals', 'other'], b: ['drums', 'bass'] });
  // move host to the right: swap
  room.handle('host', { type: 'setChannel', deviceId: 'host', channel: 'stereo', x: 0.95, y: 0.5 });
  assert.deepEqual(stemsOf(room), { host: ['drums', 'bass'], b: ['vocals', 'other'] });
  // host keeps full mix
  room.handle('host', { type: 'orchestraSet', hostPlaysAll: true });
  assert.deepEqual(stemsOf(room), { host: null, b: null });
  mk('c', undefined, 0.2); mk('d', undefined, 0.3);
  assert.deepEqual(stemsOf(room), { host: null, b: ['bass'], c: ['vocals', 'other'], d: ['drums'] });
  // leave -> recompute
  room.handle('d', { type: 'leave' });
  assert.deepEqual(stemsOf(room), { host: null, b: ['drums', 'bass'], c: ['vocals', 'other'] });
  assert.ok(room.snapshot().devices.every((d) => 'stems' in d));
  void host;
});

test('manual assignment, everyone, volumes and host-only enforcement', () => {
  const { room, mk } = setup();
  const host = mk('host', room.hostToken); const b = mk('b'); mk('c');
  room.handle('b', { type: 'orchestraSet', enabled: true }); // not host: ignored
  assert.equal(room.orchestra.enabled, false);
  const before = JSON.stringify(stemsOf(room));
  room.handle('b', { type: 'assignStems', deviceId: 'c', stems: ['vocals'] });
  assert.equal(JSON.stringify(stemsOf(room)), before);
  assert.equal(room.orchestra.mode, 'auto');
  room.handle('host', { type: 'orchestraSet', enabled: true, stemVolumes: { drums: 0.25, bass: 7, other: 'x' } });
  assert.equal(room.orchestra.stemVolumes.drums, 0.25);
  assert.equal(room.orchestra.stemVolumes.bass, 1);
  assert.equal(room.orchestra.stemVolumes.other, 1);
  room.handle('host', { type: 'assignStems', deviceId: 'b', stems: ['other', 'bogus', 'vocals', 'vocals'] });
  assert.equal(room.orchestra.mode, 'manual');
  assert.deepEqual(room.devices.get('b').stems, ['vocals', 'other']);
  // manual survives membership changes
  mk('d', undefined, 0.01);
  assert.deepEqual(room.devices.get('b').stems, ['vocals', 'other']);
  assert.equal(room.devices.get('d').stems, null);
  room.handle('host', { type: 'assignStems', deviceId: 'b', stems: null });
  assert.equal(room.devices.get('b').stems, null);
  room.handle('host', { type: 'orchestraSet', mode: 'auto' });
  assert.ok(room.devices.get('b').stems); // 4 devices -> one stem each
  room.handle('host', { type: 'orchestraSet', everyone: true });
  assert.equal(room.orchestra.mode, 'manual');
  assert.ok([...room.devices.values()].every((d) => d.stems === null));
  void host; void b;
});

test('play is gated on the full mix AND the assigned stems being decoded', () => {
  const { room, mk } = setup();
  const h = mk('host', room.hostToken); mk('b');
  const tr = room.addTrack({ id: 't1', name: 'song', sizeBytes: 10 });
  room.handle('host', { type: 'orchestraSet', enabled: true });
  room.setStems('t1', { status: 'ready', progress: 1, names: [...STEMS] });
  // auto, 2 devices -> host (x .5, first) gets vocals+other, b gets drums+bass
  assert.deepEqual(stemsOf(room), { host: ['vocals', 'other'], b: ['drums', 'bass'] });
  room.handle('host', { type: 'ready', trackId: 't1' });
  room.handle('b', { type: 'ready', trackId: 't1' });
  room.handle('host', { type: 'play' });
  assert.ok(h.errors().includes('not all ready'), 'mix only is not enough while orchestra is active');
  room.handle('host', { type: 'ready', trackId: 't1', stems: ['vocals', 'other'] });
  room.handle('b', { type: 'ready', trackId: 't1', stems: ['drums'] });
  h.inbox.length = 0;
  room.handle('host', { type: 'play' });
  assert.deepEqual(h.errors(), ['not all ready']);
  room.handle('b', { type: 'ready', trackId: 't1', stems: ['drums', 'bass', 'vocals'] });
  h.inbox.length = 0;
  room.handle('host', { type: 'play' });
  assert.deepEqual(h.errors(), []);
  assert.equal(room.playback.status, 'scheduled');
  void tr;
});

test('fallback: disabled orchestra or stems not ready only needs the full mix', () => {
  const { room, mk } = setup();
  const h = mk('host', room.hostToken); mk('b');
  room.addTrack({ id: 't1', name: 'song', sizeBytes: 10 });
  room.handle('host', { type: 'orchestraSet', enabled: true }); // stems idle -> not active
  room.handle('host', { type: 'ready', trackId: 't1' });
  room.handle('b', { type: 'ready', trackId: 't1' });
  room.handle('host', { type: 'play' });
  assert.deepEqual(h.errors(), []);
  assert.equal(room.playback.status, 'scheduled');
  room.handle('host', { type: 'pause' });
  room.setStems('t1', { status: 'ready', names: [...STEMS] });
  room.handle('host', { type: 'orchestraSet', enabled: false });
  room.handle('host', { type: 'play' });
  assert.deepEqual(h.errors(), []);
});

test('demo (stems-only) tracks need every stem when orchestra is off', () => {
  const { room, mk } = setup();
  const h = mk('host', room.hostToken);
  room.addTrack({ id: 'demo', name: 'Demo', sizeBytes: 1, stemsOnly: true, stems: { status: 'ready', progress: 1, names: [...STEMS] } });
  room.handle('host', { type: 'ready', trackId: 'demo', stems: ['vocals'] });
  room.handle('host', { type: 'play' });
  assert.deepEqual(h.errors(), ['not all ready']);
  room.handle('host', { type: 'ready', trackId: 'demo', stems: [...STEMS] });
  room.handle('host', { type: 'play' });
  assert.equal(room.playback.status, 'scheduled');
});

test('RoomManager passes hooks; separate without a configured separator is an error', () => {
  const m = new RoomManager({ hooks: { separationEnabled: false } });
  const room = m.create();
  const inbox = [];
  room.join({ deviceId: 'h', name: 'h', hostToken: room.hostToken }, { send: (x) => inbox.push(x), close() {} });
  room.addTrack({ id: 't', name: 'x', sizeBytes: 1 });
  room.handle('h', { type: 'separate', trackId: 't' });
  assert.ok(inbox.some((x) => x.type === 'error' && /not configured/.test(x.message)));
  assert.equal(room.snapshot().features.separation, false);
  m.stop();
});

// ---------- integration with a fake separator ----------
function fakeSeparator({ token = 'secret', failJob = false, pollsBeforeDone = 2 } = {}) {
  const stat = { posts: 0, polls: 0, stemGets: 0, badAuth: 0 };
  const jobs = new Map();
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { stat.badAuth++; res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"detail":"unauthorized"}'); }
    const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && req.url === '/jobs') {
      stat.posts++;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        assert.ok(body.includes('name="file"'), 'multipart field is `file`');
        const jobId = 'job' + stat.posts;
        jobs.set(jobId, { polls: 0 });
        json(202, { jobId, status: 'queued', progress: 0, stems: null });
      });
      return;
    }
    let m = req.url.match(/^\/jobs\/([^/]+)$/);
    if (m && req.method === 'GET') {
      stat.polls++;
      const j = jobs.get(m[1]);
      if (!j) return json(404, { detail: 'no such job' });
      j.polls++;
      if (failJob) return json(200, { jobId: m[1], status: 'error', progress: 0.3, error: 'demucs failed: out of memory' });
      if (j.polls < pollsBeforeDone) return json(200, { jobId: m[1], status: 'running', progress: j.polls / pollsBeforeDone, stems: null });
      return json(200, { jobId: m[1], status: 'done', progress: 1, stems: Object.fromEntries(STEMS.map((s) => [s, `/jobs/${m[1]}/stems/${s}.mp3`])) });
    }
    m = req.url.match(/^\/jobs\/([^/]+)\/stems\/(\w+)\.mp3$/);
    if (m) { stat.stemGets++; res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(Buffer.from('MP3:' + m[2])); }
    json(404, {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ stat, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections?.(); }) })));
}

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
  const wait = (pred, ms = 5000, from = 0) => {
    const hit = msgs.slice(from).reverse().find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => { waiters.push({ pred, res }); setTimeout(() => rej(new Error('timeout waiting for message')), ms).unref(); });
  };
  return { ws, msgs, open, wait, send: (o) => ws.send(JSON.stringify(o)) };
}

async function boot(t, { separator, demoDir } = {}) {
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-orch-'));
  const s = createApp({ uploadDir, clientDist: path.join(uploadDir, 'nope'), demoDir: demoDir ?? path.join(uploadDir, 'nodemo'), separator });
  const port = await s.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => { await s.close(); fs.rmSync(uploadDir, { recursive: true, force: true }); });
  async function room(bytes = 'AUDIO-BYTES-1') {
    const { roomId, hostToken } = await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json();
    const host = client(port);
    await host.open;
    host.send({ type: 'join', roomId, name: 'H', deviceId: 'host', hostToken });
    await host.wait((m) => m.type === 'joined');
    const r = await fetch(`${base}/api/rooms/${roomId}/tracks`, { method: 'POST', headers: { 'x-filename': 'song.mp3', 'x-token': hostToken, 'content-type': 'audio/mpeg' }, body: bytes });
    const { trackId } = await r.json();
    return { host, roomId, hostToken, trackId };
  }
  const trackState = (host, trackId, pred, from = 0) => host.wait((m) => m.type === 'state' && pred(m.tracks.find((x) => x.id === trackId)?.stems), 5000, from);
  return { s, base, room, trackState, uploadDir };
}

test('separation: success, served stems, then cache hit for identical audio', async (t) => {
  const fake = await fakeSeparator();
  t.after(() => fake.close());
  const { s, base, room, trackState } = await boot(t, { separator: { url: fake.url, token: 'secret', pollMs: 10 } });
  const a = await room('SAME-AUDIO');
  const st0 = await trackState(a.host, a.trackId, (x) => x?.status === 'idle');
  assert.equal(st0.tracks.find((x) => x.id === a.trackId).stems.names.length, 0);
  assert.equal(st0.features.separation, true);
  a.host.send({ type: 'separate', trackId: a.trackId });
  await trackState(a.host, a.trackId, (x) => x?.status === 'separating');
  const done = await trackState(a.host, a.trackId, (x) => x?.status === 'ready');
  assert.deepEqual(done.tracks.find((x) => x.id === a.trackId).stems.names, STEMS);
  assert.equal(fake.stat.posts, 1);
  assert.equal(fake.stat.stemGets, 4);
  assert.equal(fake.stat.badAuth, 0);
  for (const stem of STEMS) {
    const r = await fetch(`${base}/media/${a.trackId}/${stem}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'audio/mpeg');
    assert.equal(await r.text(), 'MP3:' + stem);
  }
  assert.equal((await fetch(`${base}/media/${a.trackId}/bogus`)).status, 404);
  assert.equal((await fetch(`${base}/media/nope/vocals`)).status, 404);
  // the whole mix is still served as before
  assert.equal(await (await fetch(`${base}/media/${a.trackId}`)).text(), 'SAME-AUDIO');

  // second room, same bytes -> served from the sha256 cache without touching the separator
  const b = await room('SAME-AUDIO');
  const t0 = Date.now();
  b.host.send({ type: 'separate', trackId: b.trackId });
  await trackState(b.host, b.trackId, (x) => x?.status === 'ready');
  assert.equal(fake.stat.posts, 1, 'no second upload');
  assert.equal(fake.stat.stemGets, 4);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(await (await fetch(`${base}/media/${b.trackId}/drums`)).text(), 'MP3:drums');
  // a non-host cannot trigger separation
  void s;
});

test('separation: separator reports an error, wrong token, and unreachable', async (t) => {
  const failing = await fakeSeparator({ failJob: true });
  t.after(() => failing.close());
  const { room, trackState } = await boot(t, { separator: { url: failing.url, token: 'secret', pollMs: 10 } });
  const a = await room('X1');
  a.host.send({ type: 'separate', trackId: a.trackId });
  const err = await trackState(a.host, a.trackId, (x) => x?.status === 'error');
  assert.match(err.tracks.find((x) => x.id === a.trackId).stems.error, /out of memory/);
  // retry is allowed after an error
  const mark = a.host.msgs.length;
  a.host.send({ type: 'separate', trackId: a.trackId });
  await trackState(a.host, a.trackId, (x) => x?.status === 'separating', mark);
  await trackState(a.host, a.trackId, (x) => x?.status === 'error', mark);
  assert.equal(failing.stat.posts, 2);

  // wrong token
  const ok = await fakeSeparator();
  t.after(() => ok.close());
  const b = await boot(t, { separator: { url: ok.url, token: 'WRONG', pollMs: 10 } });
  const r = await b.room('X2');
  r.host.send({ type: 'separate', trackId: r.trackId });
  const e2 = await b.trackState(r.host, r.trackId, (x) => x?.status === 'error');
  assert.match(e2.tracks.find((x) => x.id === r.trackId).stems.error, /rejected the token/);
  assert.ok(!JSON.stringify(e2).includes('WRONG'));

  // unreachable
  const c = await boot(t, { separator: { url: 'http://127.0.0.1:1', token: 'secret', pollMs: 10 } });
  const q = await c.room('X3');
  q.host.send({ type: 'separate', trackId: q.trackId });
  const e3 = await c.trackState(q.host, q.trackId, (x) => x?.status === 'error');
  assert.match(e3.tracks.find((x) => x.id === q.trackId).stems.error, /unreachable/);
});

test('separation disabled: clear error, everything else keeps working', async (t) => {
  const { base, room } = await boot(t, { separator: { url: '' } });
  const a = await room('Y1');
  const st = await a.host.wait((m) => m.type === 'state');
  assert.equal(st.features.separation, false);
  assert.equal((await (await fetch(`${base}/api/demo`)).json()).separation, false);
  a.host.send({ type: 'separate', trackId: a.trackId });
  const err = await a.host.wait((m) => m.type === 'error');
  assert.match(err.message, /not configured/);
  // plain playback still works
  a.host.send({ type: 'ready', trackId: a.trackId });
  await new Promise((r) => setTimeout(r, 50));
  a.host.send({ type: 'play' });
  const playing = await a.host.wait((m) => m.type === 'state' && m.playback.status === 'scheduled');
  assert.equal(playing.playback.trackId, a.trackId);
});

test('demo library: listing, addDemo gives a ready stems-only track, unknown slug errors', async (t) => {
  const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-demo-'));
  t.after(() => fs.rmSync(demoDir, { recursive: true, force: true }));
  const mkDemo = (slug, complete = true) => {
    const d = path.join(demoDir, slug);
    fs.mkdirSync(d);
    for (const s of STEMS.slice(0, complete ? 4 : 3)) fs.writeFileSync(path.join(d, `${s}.mp3`), 'MP3:' + s);
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ slug, title: 'Song ' + slug, durationSec: 12.5 }));
  };
  mkDemo('good-one'); mkDemo('partial', false);
  fs.mkdirSync(path.join(demoDir, 'empty'));
  const { base, room } = await boot(t, { demoDir, separator: { url: '' } });
  const list = await (await fetch(`${base}/api/demo`)).json();
  assert.deepEqual(list.demos.map((d) => d.slug), ['good-one']);
  assert.equal(list.demos[0].title, 'Song good-one');
  assert.equal(list.demos[0].durationSec, 12.5);
  assert.ok(!('dir' in list.demos[0]));

  const a = await room('Z1');
  a.host.send({ type: 'addDemo', slug: '../etc' });
  assert.match((await a.host.wait((m) => m.type === 'error')).message, /unknown demo/);
  a.host.send({ type: 'addDemo', slug: 'good-one' });
  const st = await a.host.wait((m) => m.type === 'state' && m.tracks.some((x) => x.stemsOnly && x.id === m.playback.trackId));
  const tr = st.tracks.find((x) => x.stemsOnly);
  assert.equal(tr.stems.status, 'ready');
  assert.equal(tr.durationMs, 12500);
  assert.equal(st.playback.trackId, tr.id, 'demo becomes the current track when idle');
  assert.equal(await (await fetch(`${base}/media/${tr.id}/bass.mp3`)).text(), 'MP3:bass');
  // gating: needs all four stems decoded
  a.host.send({ type: 'ready', trackId: tr.id, stems: ['vocals'] });
  a.host.send({ type: 'play' });
  assert.match((await a.host.wait((m) => m.type === 'error' && m.message === 'not all ready')).message, /ready/);
  a.host.send({ type: 'ready', trackId: tr.id, stems: STEMS });
  a.host.send({ type: 'play' });
  await a.host.wait((m) => m.type === 'state' && m.playback.status === 'scheduled');
});
