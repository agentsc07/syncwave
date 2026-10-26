import express from 'express';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager } from './room.js';
import { now } from './clock.js';
import { STEMS } from './orchestra.js';
import { createSeparator } from './separator.js';
import { listDemos, readDemo } from './demo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const MAX_UPLOAD = 100 * 1024 * 1024;

const MIME = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.webm': 'audio/webm',
};

export function createApp({
  uploadDir = path.join(here, '..', 'uploads'),
  clientDist = path.join(here, '..', '..', 'client', 'dist'),
  clock = now,
  tls = null, // {key, cert} -> serve HTTPS/WSS
  demoDir = process.env.DEMO_DIR || path.join(here, '..', 'demo'),
  // {url, token, pollMs, ...}; defaults to env SEPARATOR_URL / SEPARATOR_TOKEN. Empty url = separation disabled.
  separator: separatorOpts = {},
  // Hosting limits (env-configurable): total uploads on disk, file lifetime, per-IP rate limits, ws keepalive.
  maxUploadTotalMb = Number(process.env.MAX_UPLOAD_MB) || 500,
  uploadTtlSec = process.env.UPLOAD_TTL !== undefined ? Number(process.env.UPLOAD_TTL) : 6 * 3600, // 0 = keep until room ends
  uploadsPerWindow = Number(process.env.UPLOAD_RATE) || 30, // uploads per IP per 10 min
  roomsPerMinute = Number(process.env.ROOM_RATE) || 120, // room creations per IP per minute
  heartbeatMs = 25000,
} = {}) {
  fs.mkdirSync(uploadDir, { recursive: true });
  const files = new Map(); // trackId -> {file, mime, roomId}
  const stemDirs = new Map(); // trackId -> directory holding {vocals,drums,bass,other}.mp3 (separator cache or demo folder)
  const separator = createSeparator({
    url: process.env.SEPARATOR_URL, token: process.env.SEPARATOR_TOKEN,
    ...separatorOpts, cacheDir: path.join(uploadDir, 'stems'),
  });

  const hooks = {
    separationEnabled: separator.enabled,
    separate(room, trackId, hostId) {
      const tr = room.tracks.get(trackId);
      const f = files.get(trackId);
      if (!tr || !f) return room.error(hostId, 'this track has no uploaded audio to separate');
      if (tr.stems?.status === 'separating' || tr.stems?.status === 'ready') return;
      room.setStems(trackId, { status: 'separating', progress: 0, error: undefined, names: [] });
      separator.separate({ file: f.file, name: tr.name, onProgress: (p) => room.setStems(trackId, { progress: Math.round(p * 1000) / 1000 }, { soft: true }) })
        .then(({ dir, names }) => {
          separator.pin(dir);
          stemDirs.set(trackId, dir);
          room.setStems(trackId, { status: 'ready', progress: 1, error: undefined, names });
        })
        .catch((e) => room.setStems(trackId, { status: 'error', error: String(e?.message ?? e).slice(0, 200) }));
    },
    addDemo(room, slug, hostId) {
      const demo = readDemo(demoDir, slug);
      if (!demo) return room.error(hostId, 'unknown demo');
      const trackId = randomUUID();
      stemDirs.set(trackId, demo.dir);
      room.addTrack({
        id: trackId, name: demo.title, sizeBytes: demo.sizeBytes, durationMs: demo.durationSec ? Math.round(demo.durationSec * 1000) : undefined,
        stemsOnly: true, stems: { status: 'ready', progress: 1, names: [...STEMS] },
      });
      const st = room.derivedStatus();
      if (st !== 'playing' && st !== 'scheduled') { room.setCurrentTrack(trackId); room.broadcast(); }
    },
  };

  // Evict oldest uploads when over the disk cap or past the TTL. Stems/demo files are not touched.
  const evictFile = (id) => {
    const f = files.get(id);
    if (!f) return;
    fs.rm(f.file, { force: true }, () => {});
    files.delete(id);
  };
  const enforceUploadLimits = (keepId) => {
    const t = Date.now();
    if (uploadTtlSec > 0) for (const [id, f] of files) if (id !== keepId && t - f.at > uploadTtlSec * 1000) evictFile(id);
    let total = 0;
    for (const f of files.values()) total += f.size;
    for (const [id, f] of files) { // Map iterates in insertion (= upload) order, oldest first
      if (total <= maxUploadTotalMb * 1024 * 1024) break;
      if (id === keepId) continue;
      total -= f.size;
      evictFile(id);
    }
  };
  const ttlTimer = setInterval(() => enforceUploadLimits(), 60000);
  ttlTimer.unref();

  // Tiny fixed-window per-IP limiter (no dependency).
  const hits = new Map();
  const limited = (key, limit, windowMs) => {
    const t = Date.now();
    const h = hits.get(key);
    if (!h || t - h.start > windowMs) { hits.set(key, { start: t, n: 1 }); return false; }
    return ++h.n > limit;
  };
  const hitsTimer = setInterval(() => { const t = Date.now(); for (const [k, h] of hits) if (t - h.start > 600000) hits.delete(k); }, 60000);
  hitsTimer.unref();

  const rooms = new RoomManager({ clock, hooks });
  rooms.onRoomDeleted = (room) => {
    for (const id of room.tracks.keys()) {
      const f = files.get(id);
      if (f) { fs.rm(f.file, { force: true }, () => {}); files.delete(id); }
      stemDirs.delete(id); // cached stems / demo files stay on disk
    }
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render terminates TLS; req.ip / req.protocol come from X-Forwarded-*
  app.get('/healthz', (req, res) => {
    res.set('Cache-Control', 'no-store').json({ ok: true, uptime: Math.round(process.uptime()), rooms: rooms.rooms?.size ?? undefined });
  });
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'x-filename, x-token, content-type');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/api/demo', (req, res) => {
    res.json({ separation: separator.enabled, demos: listDemos(demoDir) });
  });

  app.post('/api/rooms', (req, res) => {
    if (limited('room:' + req.ip, roomsPerMinute, 60000)) return res.status(429).json({ error: 'too many rooms, slow down' });
    const room = rooms.create();
    res.json({ roomId: room.roomId, hostToken: room.hostToken });
  });

  app.get('/api/rooms/:roomId', (req, res) => {
    res.json({ exists: !!rooms.get(req.params.roomId) });
  });

  app.post('/api/rooms/:roomId/tracks', (req, res) => {
    const room = rooms.get(req.params.roomId);
    if (!room) return res.status(404).json({ error: 'room not found' });
    if (!room.canUpload(req.get('x-token'))) return res.status(403).json({ error: 'bad token' });
    if (limited('up:' + req.ip, uploadsPerWindow, 600000)) return res.status(429).json({ error: 'too many uploads, try again later' });
    const declared = Number(req.get('content-length'));
    if (declared > MAX_UPLOAD) return res.status(413).json({ error: 'too large' });

    let name = req.get('x-filename') || 'track';
    try { name = decodeURIComponent(name); } catch {}
    name = path.basename(name).slice(0, 200) || 'track';
    const trackId = randomUUID();
    const ext = path.extname(name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
    const file = path.join(uploadDir, trackId + ext);
    const ct = (req.get('content-type') || '').split(';')[0].trim();
    const mime = ct.startsWith('audio/') || ct.startsWith('video/') ? ct : MIME[ext] || 'application/octet-stream';

    const out = fs.createWriteStream(file);
    let size = 0, failed = false;
    const fail = (code, msg) => {
      if (failed) return;
      failed = true;
      req.unpipe(out);
      out.destroy();
      fs.rm(file, { force: true }, () => {});
      if (!res.headersSent) res.status(code).json({ error: msg });
    };
    req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD) fail(413, 'too large'); });
    req.on('error', () => fail(400, 'upload error'));
    req.on('aborted', () => fail(400, 'aborted'));
    out.on('error', () => fail(500, 'write error'));
    out.on('finish', () => {
      if (failed) return;
      if (size === 0) { fs.rm(file, { force: true }, () => {}); return res.status(400).json({ error: 'empty body' }); }
      if (!rooms.get(room.roomId)) { fs.rm(file, { force: true }, () => {}); return res.status(404).json({ error: 'room gone' }); }
      files.set(trackId, { file, mime, roomId: room.roomId, size, at: Date.now() });
      enforceUploadLimits(trackId);
      room.addTrack({ id: trackId, name, sizeBytes: size });
      res.json({ trackId });
    });
    req.pipe(out);
  });

  app.get('/media/:trackId', (req, res) => {
    const f = files.get(req.params.trackId);
    if (!f) return res.status(404).end();
    res.sendFile(f.file, {
      headers: { 'Content-Type': f.mime, 'Cache-Control': 'public, max-age=31536000, immutable' },
      acceptRanges: true,
    });
  });

  app.get('/media/:trackId/:stem', (req, res) => {
    const stem = req.params.stem.replace(/\.mp3$/, '');
    const dir = stemDirs.get(req.params.trackId);
    if (!dir || !STEMS.includes(stem)) return res.status(404).end();
    res.sendFile(path.resolve(dir, `${stem}.mp3`), {
      headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=31536000, immutable' },
      acceptRanges: true,
    }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });

  // Static client + SPA fallback (checked per request so a later build is picked up).
  const indexHtml = path.join(clientDist, 'index.html');
  const serveStatic = express.static(clientDist, {
    setHeaders(res, file) {
      const base = path.basename(file);
      if (/[\\/]assets[\\/]/.test(file)) res.set('Cache-Control', 'public, max-age=31536000, immutable'); // hashed filenames
      else if (base === 'index.html' || base === 'sw.js' || base === 'service-worker.js' || base === 'registerSW.js') res.set('Cache-Control', 'no-cache');
      else res.set('Cache-Control', 'public, max-age=3600');
      if (base === 'manifest.webmanifest' || base === 'manifest.json') res.type('application/manifest+json');
    },
  });
  const reserved = /^\/(api|media|ws)(\/|$)/;
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (reserved.test(req.path) || !fs.existsSync(indexHtml)) return next();
    serveStatic(req, res, next);
  });
  app.get('*', (req, res, next) => {
    if (reserved.test(req.path) || !fs.existsSync(indexHtml)) return next();
    res.set('Cache-Control', 'no-cache').sendFile(indexHtml);
  });

  const server = tls ? https.createServer(tls, app) : http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  // Keepalive: Render's proxy drops idle sockets, and phones vanish without a close frame.
  // Protocol-level ping every heartbeatMs; any frame back (pong or app message) counts as alive.
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, heartbeatMs);
  beat.unref();

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    let room = null, deviceId = null;
    const conn = {
      send: (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); },
      close: () => ws.close(),
      // drop frames for slow receivers instead of queueing latency
      sendBinary: (buf) => { if (ws.readyState === 1 && ws.bufferedAmount < 512 * 1024) ws.send(buf, { binary: true }); },
    };
    ws.on('message', (data, isBinary) => {
      ws.isAlive = true;
      if (isBinary) { if (room) room.relayLive(deviceId, data); return; }
      const t1 = clock();
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      if (msg.type === 'ping') {
        conn.send({ type: 'pong', t0: msg.t0, t1, t2: clock() });
        if (room && deviceId) { const d = room.devices.get(deviceId); if (d) d.lastSeen = t1; }
        return;
      }
      if (msg.type === 'join') {
        if (room) return;
        const r = rooms.get(msg.roomId);
        if (!r) return conn.send({ type: 'error', message: 'room not found' });
        if (typeof msg.deviceId !== 'string' || !msg.deviceId || msg.deviceId.length > 100) {
          return conn.send({ type: 'error', message: 'bad deviceId' });
        }
        room = r; deviceId = msg.deviceId;
        room.join(msg, conn);
        return;
      }
      if (room) room.handle(deviceId, msg);
    });
    ws.on('close', () => { if (room) room.disconnect(deviceId, conn); });
    ws.on('error', () => {});
  });

  rooms.startSweeper();

  return {
    app, server, rooms, files, stemDirs, separator,
    listen: (port = 3000, host) => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => {
      rooms.stop();
      clearInterval(ttlTimer); clearInterval(hitsTimer); clearInterval(beat);
      separator.close();
      for (const c of wss.clients) c.terminate();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
