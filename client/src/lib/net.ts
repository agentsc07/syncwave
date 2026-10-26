import { ClockSync } from './clock';
import { AudioEngine } from './engine';
import { startCapture, type CaptureHandle } from './livecapture';
import { LIVE_BUFFER } from './livemath';
import type {
  Channel,
  ClientMessage,
  ConnectionStatus,
  Device,
  LoadStatus,
  RoomState,
  ServerMessage,
} from './types';

const DEVICE_KEY = 'syncwave.deviceId';

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
}

/** Persistent per-browser device id. */
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = uuid();
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return uuid();
  }
}

export interface SessionOptions {
  roomId: string;
  name: string;
  hostToken?: string;
  /** Override ws URL (default: same origin /ws). */
  wsUrl?: string;
  deviceId?: string;
}

export type SessionListener = (state: RoomState | null) => void;

export class Session {
  readonly roomId: string;
  readonly name: string;
  readonly hostToken?: string;
  readonly deviceId: string;
  readonly clock = new ClockSync();
  readonly engine: AudioEngine;

  state: RoomState | null = null;
  isHost = false;
  status: ConnectionStatus = 'connecting';
  /** Preload status of the current playback.trackId. */
  loadStatus: LoadStatus = 'idle';
  loadError: string | null = null;
  lastError: string | null = null;
  wakeLockActive = false;
  /** Last error from starting a live share / announcement (user-facing text). */
  liveError: string | null = null;
  liveStarting = false;

  private capture: CaptureHandle | null = null;
  private liveWanted = false;
  private liveConfirmed = false;
  private ws: WebSocket | null = null;
  private url: string;
  private listeners = new Set<SessionListener>();
  private closed = false;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private reportTimer: ReturnType<typeof setInterval> | null = null;
  private wakeLock: any = null;
  private loadingTrack: string | null = null;
  private readySent: string | null = null;
  private pending: ClientMessage[] = [];

  constructor(opts: SessionOptions) {
    this.roomId = opts.roomId;
    this.name = opts.name;
    this.hostToken = opts.hostToken;
    this.deviceId = opts.deviceId ?? getDeviceId();
    this.isHost = !!opts.hostToken;
    this.url =
      opts.wsUrl ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    this.engine = new AudioEngine(() => this.clock.serverNow());
    this.clock.onUpdate(() => {
      // once clock is calibrated (and on every refinement) re-schedule
      this.applyEngine();
    });
    this.engine.onEnded(() => {
      if (this.isHost) this.send({ type: 'next' });
    });
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisible);
    }
  }

  // ---- lifecycle ----

  connect(): void {
    this.closed = false;
    this.open();
    this.reportTimer ??= setInterval(() => this.sendReport(), 2000);
    this.acquireWakeLock();
  }

  /** Call from a user gesture (join / "tap to start"). Unlocks audio and requests the wake lock. */
  async unlock(): Promise<void> {
    await this.engine.unlock();
    this.acquireWakeLock();
  }

  leave(): void {
    this.send({ type: 'leave' });
    this.close();
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.reportTimer = null;
    this.clock.stop();
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.stopCapture();
    this.engine.dispose();
    this.releaseWakeLock();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible);
    this.status = 'closed';
    this.emit();
  }

  // ---- subscription / sending ----

  /** Called on any change (state, connection status, load status, errors). Returns unsubscribe. */
  subscribe(cb: SessionListener): () => void {
    this.listeners.add(cb);
    cb(this.state);
    return () => this.listeners.delete(cb);
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
    else if (msg.type !== 'ping' && msg.type !== 'leave' && msg.type !== 'report') this.pending.push(msg);
  }

  get self(): Device | null {
    return this.state?.devices.find((d) => d.id === this.deviceId) ?? null;
  }

  // host / device convenience wrappers
  play() { this.send({ type: 'play' }); }
  pause() { this.send({ type: 'pause' }); }
  seek(positionMs: number) { this.send({ type: 'seek', positionMs }); }
  next() { this.send({ type: 'next' }); }
  setVolume(value: number) { this.send({ type: 'volume', value }); }
  setTrim(deviceId: string, ms: number) { this.send({ type: 'setTrim', deviceId, ms }); }
  setTrimSelf(ms: number) { this.send({ type: 'setTrimSelf', ms }); }
  setChannel(deviceId: string, channel: Channel, x?: number, y?: number) {
    this.send({ type: 'setChannel', deviceId, channel, x, y });
  }
  setLights(on: boolean) { this.send({ type: 'lights', on }); }
  kick(deviceId: string) { this.send({ type: 'kick', deviceId }); }
  setTrack(trackId: string) { this.send({ type: 'setTrack', trackId }); }
  queueAdd(trackId: string) { this.send({ type: 'queueAdd', trackId }); }
  queueVote(trackId: string) { this.send({ type: 'queueVote', trackId }); }
  setLocalVolume(v: number) { this.engine.setLocalVolume(v); }

  // ---- live audio (host only) ----

  /** True while this device is capturing and sending live audio. */
  get liveCapturing(): boolean { return !!this.capture; }

  /**
   * Start a live share (tab/system audio, desktop Chrome/Edge) or an announcement (microphone).
   * Must be called from a user gesture. Sets `liveError` and resolves false on failure.
   */
  async startLive(kind: 'share' | 'announce', bufferMs?: number): Promise<boolean> {
    if (this.capture || this.liveStarting) return false;
    this.liveError = null;
    this.liveStarting = true;
    this.emit();
    let stream: MediaStream | null = null;
    try {
      const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
      if (!md || (typeof isSecureContext !== 'undefined' && !isSecureContext)) {
        throw new Error('This needs HTTPS or localhost. Open the app over https:// (see README) to use the microphone or tab audio.');
      }
      await this.engine.unlock();
      const ctx = this.engine.ctx;
      if (!ctx) throw new Error('Web Audio is not available in this browser.');
      if (kind === 'share') {
        if (!md.getDisplayMedia) throw new Error('Tab/system audio sharing is not supported in this browser. Use desktop Chrome or Edge.');
        stream = await md.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: true } as MediaTrackConstraints,
        });
        stream.getVideoTracks().forEach((t) => { t.stop(); stream!.removeTrack(t); });
        if (stream.getAudioTracks().length === 0) {
          stream.getTracks().forEach((t) => t.stop());
          stream = null;
          throw new Error('No audio was shared. Pick a Chrome tab (or Entire screen on Windows/ChromeOS) and tick "Share tab audio" / "Share system audio".');
        }
      } else {
        stream = await md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
      }
      const track = stream.getAudioTracks()[0];
      track.addEventListener('ended', () => { if (this.capture) this.stopLive(); });
      this.liveWanted = true;
      this.liveConfirmed = false;
      this.send({ type: 'liveStart', kind, bufferMs: bufferMs ?? LIVE_BUFFER[kind].def });
      const loopback = kind === 'share'; // announce: no local playout (the mic would feed back)
      this.capture = await startCapture(ctx, stream, {
        channels: kind === 'share' ? 2 : 1,
        serverNow: () => this.clock.serverNow(),
        onFrame: (buf) => {
          if (this.ws && this.ws.readyState === 1) this.ws.send(buf);
          if (loopback) this.engine.pushLiveFrame(buf);
        },
      });
      this.liveStarting = false;
      this.emit();
      return true;
    } catch (e) {
      stream?.getTracks().forEach((t) => t.stop());
      const err = e as DOMException;
      this.liveError = err?.name === 'NotAllowedError' ? 'Permission denied (or the picker was cancelled).' : String(err?.message ?? e);
      this.liveStarting = false;
      this.emit();
      return false;
    }
  }

  stopLive(): void {
    const was = this.capture;
    this.stopCapture();
    if (was) this.send({ type: 'liveStop' });
    this.emit();
  }

  setLiveBuffer(ms: number): void { this.send({ type: 'liveBuffer', ms }); }

  private stopCapture(): void {
    const c = this.capture;
    this.capture = null;
    this.liveWanted = false;
    this.liveConfirmed = false;
    try { c?.stop(); } catch { /* ignore */ }
  }

  /** Upload an audio file to the room; resolves to the new trackId. */
  async uploadTrack(file: Blob, filename?: string): Promise<string> {
    const name = filename ?? (file as File).name ?? 'track';
    const res = await fetch(`/api/rooms/${encodeURIComponent(this.roomId)}/tracks`, {
      method: 'POST',
      headers: {
        'x-filename': encodeURIComponent(name),
        'x-token': this.hostToken ?? this.deviceId,
        'content-type': 'application/octet-stream',
      },
      body: file,
    });
    if (!res.ok) throw new Error(`upload failed (${res.status})`);
    const j = (await res.json()) as { trackId: string };
    return j.trackId;
  }

  // ---- internals ----

  private emit() {
    for (const cb of this.listeners) cb(this.state);
  }

  private open() {
    if (this.closed) return;
    this.status = this.attempt === 0 ? 'connecting' : 'reconnecting';
    this.emit();
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.status = 'open';
      ws.send(
        JSON.stringify({
          type: 'join',
          roomId: this.roomId,
          name: this.name,
          deviceId: this.deviceId,
          hostToken: this.hostToken,
        } satisfies ClientMessage),
      );
      this.clock.start(ws);
      const q = this.pending;
      this.pending = [];
      for (const m of q) this.send(m);
      this.emit();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') { this.engine.pushLiveFrame(ev.data as ArrayBuffer); return; }
      let m: ServerMessage;
      try {
        m = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      this.onMessage(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.clock.stop();
      if (this.closed) return;
      this.status = 'reconnecting';
      this.emit();
      const delay = Math.min(5000, 400 * 2 ** this.attempt++);
      this.retryTimer = setTimeout(() => this.open(), delay);
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private onMessage(m: ServerMessage) {
    switch (m.type) {
      case 'joined':
        this.isHost = m.isHost;
        this.readySent = null; // re-announce readiness after (re)join
        this.emit();
        break;
      case 'state': {
        const { type: _t, ...rest } = m;
        this.state = rest as RoomState;
        if (this.liveWanted) {
          if (this.state.live?.sourceId === this.deviceId) this.liveConfirmed = true;
          else if (this.liveConfirmed) this.stopCapture(); // server ended our live (host left, etc.)
        }
        const me = this.state.devices.find((d) => d.id === this.deviceId);
        if (me) this.isHost = me.isHost || this.state.hostId === this.deviceId;
        this.preload();
        this.applyEngine();
        this.emit();
        break;
      }
      case 'error':
        this.lastError = m.message;
        if (this.liveWanted && !this.liveConfirmed && /^live/.test(m.message)) { this.liveError = m.message; this.stopCapture(); }
        this.emit();
        break;
      default:
        break;
    }
  }

  private applyEngine() {
    if (!this.state || !this.clock.synced) return;
    this.engine.applyState(this.state, this.self);
  }

  private preload() {
    const id = this.state?.playback.trackId ?? null;
    if (!id) {
      this.loadStatus = 'idle';
      this.loadingTrack = null;
      return;
    }
    if (this.engine.has(id)) {
      this.loadStatus = 'ready';
      if (this.readySent !== id) {
        this.readySent = id;
        this.send({ type: 'ready', trackId: id });
      }
      return;
    }
    if (this.loadingTrack === id) return;
    this.loadingTrack = id;
    this.loadStatus = 'loading';
    this.loadError = null;
    this.engine
      .load(`/media/${encodeURIComponent(id)}`, id)
      .then(() => {
        if (this.loadingTrack !== id) return;
        this.loadStatus = 'ready';
        this.readySent = id;
        this.send({ type: 'ready', trackId: id });
        this.applyEngine();
        this.emit();
      })
      .catch((e) => {
        if (this.loadingTrack !== id) return;
        this.loadingTrack = null; // allow retry on next state
        this.loadStatus = 'error';
        this.loadError = String(e?.message ?? e);
        this.emit();
      });
    this.emit();
  }

  private sendReport() {
    if (!this.ws || this.ws.readyState !== 1) return;
    const fresh = this.engine.measureDriftMs();
    this.send({
      type: 'report',
      offsetMs: fresh ?? 0,
      driftMs: this.engine.driftMs,
      rtt: this.clock.rtt,
    });
  }

  private onVisible = () => {
    if (document.visibilityState === 'visible') this.acquireWakeLock();
  };

  private async acquireWakeLock() {
    try {
      const nav: any = navigator;
      if (!nav.wakeLock || this.closed || document.visibilityState !== 'visible') return;
      if (this.wakeLock && !this.wakeLock.released) return;
      this.wakeLock = await nav.wakeLock.request('screen');
      this.wakeLockActive = true;
      this.wakeLock.addEventListener?.('release', () => {
        this.wakeLockActive = false;
        this.emit();
      });
      this.emit();
    } catch {
      this.wakeLockActive = false;
    }
  }

  private releaseWakeLock() {
    try {
      this.wakeLock?.release();
    } catch {
      /* ignore */
    }
    this.wakeLock = null;
    this.wakeLockActive = false;
  }
}
