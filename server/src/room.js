import { randomInt, randomBytes, randomUUID } from 'node:crypto';
import { now as realNow } from './clock.js';

export const CHANNELS = ['stereo', 'left', 'right', 'center', 'rear-left', 'rear-right', 'sub'];
export const PLAY_LEAD_MS = 1500;
export const SEEK_LEAD_MS = 1000;
export const LIVE_KINDS = ['share', 'announce'];
export const LIVE_BUFFER = { share: { def: 1500, min: 800, max: 3000 }, announce: { def: 250, min: 100, max: 1000 } };
export const LIVE_MAGIC = 1; // first byte of every binary live frame (see PROTOCOL.md)
export const LIVE_HEADER_BYTES = 20;
export const DEVICE_TTL_MS = 60_000;
export const ROOM_EMPTY_TTL_MS = 10 * 60_000;
const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I, L, O, 0, 1
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v) => typeof v === 'number' && Number.isFinite(v);

export function makeRoomId() {
  let s = '';
  for (let i = 0; i < 5; i++) s += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return s;
}

/**
 * Pure room state. Connections are injected: conn = { send(obj), close() }.
 * `clock` is injectable for tests.
 */
export class Room {
  constructor(roomId, { clock = realNow, onChange } = {}) {
    this.roomId = roomId;
    this.clock = clock;
    this.hostToken = randomBytes(12).toString('hex');
    this.devices = new Map(); // id -> Device (insertion order == join order)
    this.joinedAt = new Map(); // id -> seq
    this.conns = new Map(); // id -> conn
    this.tracks = new Map(); // id -> {id,name,sizeBytes,durationMs?}
    this.queue = []; // trackIds in insertion order
    this.voters = new Map(); // trackId -> Set(deviceId)
    this.playback = { status: 'stopped', trackId: null, startServerTime: null, pausedPositionMs: 0 };
    this.volume = 1;
    this.lights = false;
    this.live = null; // {kind, sourceId, bufferMs} | null
    this.hostId = '';
    this.hostEverJoined = false;
    this.emptySince = this.clock();
    this.seq = 0;
    this.timer = null;
    this.reportTimer = null;
    this.onChange = onChange;
  }

  // ---------- snapshot ----------
  derivedStatus(t = this.clock()) {
    const p = this.playback;
    if ((p.status === 'scheduled' || p.status === 'playing') && p.startServerTime != null) {
      return p.startServerTime > t ? 'scheduled' : 'playing';
    }
    return p.status;
  }

  orderedQueue() {
    const votes = (id) => this.voters.get(id)?.size ?? 0;
    return this.queue
      .map((id, i) => ({ id, i }))
      .sort((a, b) => votes(b.id) - votes(a.id) || a.i - b.i)
      .map((x) => x.id);
  }

  snapshot() {
    const t = this.clock();
    return {
      roomId: this.roomId,
      serverTime: t,
      devices: [...this.devices.values()].map((d) => ({ ...d, isHost: d.id === this.hostId })),
      tracks: [...this.tracks.values()].map((tr) => ({ ...tr, votes: this.voters.get(tr.id)?.size ?? 0, voters: [...(this.voters.get(tr.id) ?? [])] })),
      queue: this.orderedQueue(),
      playback: { ...this.playback, status: this.derivedStatus(t) },
      volume: this.volume,
      lights: this.lights,
      live: this.live ? { ...this.live } : null,
      hostId: this.hostId,
    };
  }

  broadcast() {
    this.armStatusTimer();
    const msg = { type: 'state', ...this.snapshot() };
    for (const conn of this.conns.values()) conn.send(msg);
    this.onChange?.(this);
  }

  // Coalesced broadcast for high-frequency, low-importance updates (reports).
  broadcastSoon() {
    if (this.reportTimer) return;
    this.reportTimer = setTimeout(() => { this.reportTimer = null; this.broadcast(); }, 250);
    this.reportTimer.unref?.();
  }

  // When a scheduled start passes, push a state with status 'playing'.
  armStatusTimer() {
    clearTimeout(this.timer);
    this.timer = null;
    const p = this.playback;
    if (p.status === 'scheduled' || p.status === 'playing') {
      const wait = p.startServerTime - this.clock();
      if (wait > 0) {
        this.timer = setTimeout(() => this.broadcast(), wait + 5);
        this.timer.unref?.();
      }
    }
  }

  destroy() {
    clearTimeout(this.timer);
    clearTimeout(this.reportTimer);
    for (const c of this.conns.values()) { try { c.close(); } catch {} }
    this.conns.clear();
  }

  // ---------- membership ----------
  connectedDevices() {
    return [...this.devices.values()].filter((d) => d.connected);
  }

  canUpload(token) {
    if (!token) return false;
    return token === this.hostToken || this.devices.has(token);
  }

  join({ deviceId, name, hostToken }, conn) {
    const t = this.clock();
    const old = this.conns.get(deviceId);
    if (old && old !== conn) { try { old.close(); } catch {} }
    let d = this.devices.get(deviceId);
    if (!d) {
      d = {
        id: deviceId, name: String(name || 'Device').slice(0, 40), isHost: false, trimMs: 0,
        channel: 'stereo', x: 0.5, y: 0.5, readyTrackId: null, offsetMs: null, driftMs: null,
        rtt: null, lastSeen: t, connected: true,
      };
      this.devices.set(deviceId, d);
      this.joinedAt.set(deviceId, ++this.seq);
    } else {
      if (name) d.name = String(name).slice(0, 40);
      d.connected = true;
      d.lastSeen = t;
    }
    this.conns.set(deviceId, conn);
    this.emptySince = null;

    const isHostToken = hostToken && hostToken === this.hostToken;
    if (isHostToken) {
      this.hostId = deviceId;
      this.hostEverJoined = true;
    } else if (this.hostEverJoined && !this.isHostPresent()) {
      this.hostId = this.oldestConnected()?.id ?? this.hostId;
    }
    conn.send({ type: 'joined', deviceId, isHost: this.hostId === deviceId });
    this.broadcast();
    return d;
  }

  isHostPresent() {
    const h = this.devices.get(this.hostId);
    return !!h && h.connected;
  }

  oldestConnected(excludeId) {
    let best = null;
    for (const d of this.devices.values()) {
      if (!d.connected || d.id === excludeId) continue;
      if (!best || this.joinedAt.get(d.id) < this.joinedAt.get(best.id)) best = d;
    }
    return best;
  }

  stopLiveIfSource(deviceId) {
    if (this.live && this.live.sourceId === deviceId) this.live = null; // caller broadcasts
  }

  /** Relay a binary live frame from the live source to every other connected device. Returns #recipients. */
  relayLive(deviceId, data) {
    const l = this.live;
    if (!l || l.sourceId !== deviceId || deviceId !== this.hostId) return 0;
    if (!data || data.length < LIVE_HEADER_BYTES || data[0] !== LIVE_MAGIC) return 0;
    let n = 0;
    for (const [id, conn] of this.conns) {
      if (id === deviceId || !conn.sendBinary) continue;
      conn.sendBinary(data);
      n++;
    }
    return n;
  }

  handoffIfNeeded(leavingId) {
    if (leavingId !== this.hostId) return;
    const next = this.oldestConnected(leavingId);
    if (next) this.hostId = next.id; // else keep hostId; token holder can reclaim
  }

  /** Socket closed: keep the device for DEVICE_TTL_MS so it can rejoin. */
  disconnect(deviceId, conn) {
    if (conn && this.conns.get(deviceId) !== conn) return; // superseded by a newer connection
    const d = this.devices.get(deviceId);
    this.conns.delete(deviceId);
    if (!d) return;
    d.connected = false;
    d.lastSeen = this.clock();
    this.stopLiveIfSource(deviceId);
    this.handoffIfNeeded(deviceId);
    if (this.connectedDevices().length === 0) this.emptySince = this.clock();
    this.broadcast();
  }

  /** Explicit leave / kick: remove entirely. */
  remove(deviceId) {
    const conn = this.conns.get(deviceId);
    this.conns.delete(deviceId);
    const d = this.devices.get(deviceId);
    if (!d) return;
    this.stopLiveIfSource(deviceId);
    this.handoffIfNeeded(deviceId);
    this.devices.delete(deviceId);
    this.joinedAt.delete(deviceId);
    for (const v of this.voters.values()) v.delete(deviceId);
    if (this.connectedDevices().length === 0) this.emptySince = this.clock();
    if (conn) { try { conn.close(); } catch {} }
    this.broadcast();
  }

  /** Periodic maintenance. Returns true if the room should be deleted. */
  sweep() {
    const t = this.clock();
    let changed = false;
    for (const d of [...this.devices.values()]) {
      if (!d.connected && t - d.lastSeen > DEVICE_TTL_MS) {
        this.devices.delete(d.id);
        this.joinedAt.delete(d.id);
        changed = true;
      }
    }
    if (changed) this.broadcast();
    return this.connectedDevices().length === 0 && this.emptySince != null && t - this.emptySince > ROOM_EMPTY_TTL_MS;
  }

  // ---------- tracks ----------
  addTrack({ id = randomUUID(), name, sizeBytes, durationMs }) {
    const tr = { id, name, sizeBytes };
    if (num(durationMs)) tr.durationMs = durationMs;
    this.tracks.set(id, tr);
    if (!this.playback.trackId) this.playback = { ...this.playback, trackId: id };
    this.broadcast();
    return tr;
  }

  setCurrentTrack(trackId) {
    this.queue = this.queue.filter((id) => id !== trackId);
    this.voters.delete(trackId);
    this.playback = { status: 'stopped', trackId, startServerTime: null, pausedPositionMs: 0 };
  }

  // ---------- message handling ----------
  error(deviceId, message) {
    this.conns.get(deviceId)?.send({ type: 'error', message });
  }

  handle(deviceId, msg) {
    const d = this.devices.get(deviceId);
    if (!d || !msg || typeof msg.type !== 'string') return;
    d.lastSeen = this.clock();
    const isHost = deviceId === this.hostId;
    const p = this.playback;

    switch (msg.type) {
      // ----- any device -----
      case 'ready':
        if (typeof msg.trackId === 'string') { d.readyTrackId = msg.trackId; this.broadcast(); }
        return;
      case 'setTrimSelf':
        if (num(msg.ms)) { d.trimMs = clamp(msg.ms, -2000, 2000); this.broadcast(); }
        return;
      case 'report':
        if (num(msg.offsetMs)) d.offsetMs = msg.offsetMs;
        if (num(msg.driftMs)) d.driftMs = msg.driftMs;
        if (num(msg.rtt)) d.rtt = msg.rtt;
        this.broadcastSoon();
        return;
      case 'queueAdd': {
        const id = msg.trackId;
        if (!this.tracks.has(id)) return this.error(deviceId, 'unknown track');
        if (!this.queue.includes(id) && id !== p.trackId) this.queue.push(id);
        if (this.queue.includes(id)) this.addVote(id, deviceId);
        this.broadcast();
        return;
      }
      case 'queueVote': {
        const id = msg.trackId;
        if (!this.tracks.has(id)) return this.error(deviceId, 'unknown track');
        if (!this.queue.includes(id) && id !== p.trackId) this.queue.push(id);
        const set = this.voters.get(id) ?? new Set();
        this.voters.set(id, set);
        if (set.has(deviceId)) set.delete(deviceId); // second tap toggles the vote off
        else set.add(deviceId);
        this.broadcast();
        return;
      }
      case 'leave':
        this.remove(deviceId);
        return;
    }

    if (!isHost) return; // host-only below: silently ignored
    const t = this.clock();

    switch (msg.type) {
      case 'play': {
        if (this.live?.kind === 'share') return this.error(deviceId, 'live share active');
        if (!p.trackId) return this.error(deviceId, 'no track');
        const st = this.derivedStatus(t);
        if (st === 'playing' || st === 'scheduled') return;
        if (!this.connectedDevices().every((x) => x.readyTrackId === p.trackId)) {
          return this.error(deviceId, 'not all ready');
        }
        this.playback = { ...p, status: 'scheduled', startServerTime: t + PLAY_LEAD_MS - p.pausedPositionMs };
        break;
      }
      case 'pause': {
        const st = this.derivedStatus(t);
        if (st !== 'playing' && st !== 'scheduled') return;
        this.playback = { ...p, status: 'paused', pausedPositionMs: Math.max(0, t - p.startServerTime), startServerTime: null };
        break;
      }
      case 'seek': {
        if (!num(msg.positionMs)) return;
        const pos = Math.max(0, msg.positionMs);
        const st = this.derivedStatus(t);
        if (st === 'playing' || st === 'scheduled') {
          this.playback = { ...p, status: 'scheduled', startServerTime: t + SEEK_LEAD_MS - pos };
        } else {
          this.playback = { ...p, pausedPositionMs: pos }; // not playing: just move the cursor
        }
        break;
      }
      case 'next': {
        let nextId = this.orderedQueue()[0];
        if (!nextId) {
          const ids = [...this.tracks.keys()];
          const i = ids.indexOf(p.trackId);
          nextId = ids[i + 1];
        }
        if (!nextId) return this.error(deviceId, 'no next track');
        this.setCurrentTrack(nextId);
        break;
      }
      case 'setTrack':
        if (!this.tracks.has(msg.trackId)) return this.error(deviceId, 'unknown track');
        this.setCurrentTrack(msg.trackId);
        break;
      case 'volume':
        if (!num(msg.value)) return;
        this.volume = clamp(msg.value, 0, 1);
        break;
      case 'lights':
        this.lights = !!msg.on;
        break;
      case 'setTrim': {
        const o = this.devices.get(msg.deviceId);
        if (!o || !num(msg.ms)) return;
        o.trimMs = clamp(msg.ms, -2000, 2000);
        break;
      }
      case 'setChannel': {
        const o = this.devices.get(msg.deviceId);
        if (!o || !CHANNELS.includes(msg.channel)) return;
        o.channel = msg.channel;
        if (num(msg.x)) o.x = clamp(msg.x, 0, 1);
        if (num(msg.y)) o.y = clamp(msg.y, 0, 1);
        break;
      }
      case 'liveStart': {
        if (!LIVE_KINDS.includes(msg.kind)) return this.error(deviceId, 'bad live kind');
        if (this.live) return this.error(deviceId, 'live already active');
        const r = LIVE_BUFFER[msg.kind];
        const bufferMs = num(msg.bufferMs) ? clamp(Math.round(msg.bufferMs), r.min, r.max) : r.def;
        this.live = { kind: msg.kind, sourceId: deviceId, bufferMs };
        if (msg.kind === 'share') {
          // file playback stops (track stays loaded; host presses play afterwards)
          this.playback = { ...p, status: 'stopped', startServerTime: null, pausedPositionMs: 0 };
        }
        break;
      }
      case 'liveStop':
        if (!this.live) return;
        this.live = null;
        break;
      case 'liveBuffer': {
        if (!this.live || !num(msg.ms)) return;
        const r = LIVE_BUFFER[this.live.kind];
        this.live = { ...this.live, bufferMs: clamp(Math.round(msg.ms), r.min, r.max) };
        break;
      }
      case 'kick':
        if (msg.deviceId === deviceId || !this.devices.has(msg.deviceId)) return;
        this.conns.get(msg.deviceId)?.send({ type: 'error', message: 'kicked' });
        this.remove(msg.deviceId);
        return;
      default:
        return;
    }
    this.broadcast();
  }

  addVote(trackId, deviceId) {
    if (!this.voters.has(trackId)) this.voters.set(trackId, new Set());
    this.voters.get(trackId).add(deviceId);
  }
}

export class RoomManager {
  constructor({ clock = realNow } = {}) {
    this.clock = clock;
    this.rooms = new Map();
    this.sweeper = null;
    this.onRoomDeleted = null;
  }
  create() {
    let id;
    do { id = makeRoomId(); } while (this.rooms.has(id));
    const room = new Room(id, { clock: this.clock });
    this.rooms.set(id, room);
    return room;
  }
  get(id) { return this.rooms.get(String(id || '').toUpperCase()); }
  sweep() {
    for (const [id, room] of [...this.rooms]) {
      if (room.sweep()) {
        room.destroy();
        this.rooms.delete(id);
        this.onRoomDeleted?.(room);
      }
    }
  }
  startSweeper(ms = 5000) {
    this.sweeper = setInterval(() => this.sweep(), ms);
    this.sweeper.unref?.();
  }
  stop() {
    clearInterval(this.sweeper);
    for (const r of this.rooms.values()) r.destroy();
    this.rooms.clear();
  }
}
