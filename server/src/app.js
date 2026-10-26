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
} = {}) {
  fs.mkdirSync(uploadDir, { recursive: true });
  const rooms = new RoomManager({ clock });
  const files = new Map(); // trackId -> {file, mime, roomId}
  rooms.onRoomDeleted = (room) => {
    for (const id of room.tracks.keys()) {
      const f = files.get(id);
      if (f) { fs.rm(f.file, { force: true }, () => {}); files.delete(id); }
    }
  };

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'x-filename, x-token, content-type');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.post('/api/rooms', (req, res) => {
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
      files.set(trackId, { file, mime, roomId: room.roomId });
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

  // Static client + SPA fallback (checked per request so a later build is picked up).
  const indexHtml = path.join(clientDist, 'index.html');
  const serveStatic = express.static(clientDist);
  const reserved = /^\/(api|media|ws)(\/|$)/;
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (reserved.test(req.path) || !fs.existsSync(indexHtml)) return next();
    serveStatic(req, res, next);
  });
  app.get('*', (req, res, next) => {
    if (reserved.test(req.path) || !fs.existsSync(indexHtml)) return next();
    res.sendFile(indexHtml);
  });

  const server = tls ? https.createServer(tls, app) : http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    let room = null, deviceId = null;
    const conn = {
      send: (o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); },
      close: () => ws.close(),
      // drop frames for slow receivers instead of queueing latency
      sendBinary: (buf) => { if (ws.readyState === 1 && ws.bufferedAmount < 512 * 1024) ws.send(buf, { binary: true }); },
    };
    ws.on('message', (data, isBinary) => {
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
    app, server, rooms, files,
    listen: (port = 3000, host) => new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
    close: () => new Promise((resolve) => {
      rooms.stop();
      for (const c of wss.clients) c.terminate();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
