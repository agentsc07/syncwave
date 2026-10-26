import type { Channel, Device, RoomState } from './types';
import { DUCK_GAIN, LiveScheduler, decodeFrame, pcmToFloat } from './livemath';
import { STEMS, diffSources, wantedSources, type SourceName, type StemName } from './orchestra';

// ---------------------------------------------------------------------------
// Pure functions (testable in Node)
// ---------------------------------------------------------------------------

export const DRIFT_RESEEK_MS = 40;
export const MAX_RATE_NUDGE = 0.005; // 0.5%
export const DRIFT_DEADBAND_MS = 0.5;
export const DRIFT_INTERVAL_MS = 2000;
export const START_LEAD_S = 0.03; // when starting "now", lead the audio clock a little

export interface PlanInput {
  ctxNow: number; // ctx.currentTime (s)
  serverNow: number; // ms
  S: number; // server time at which position 0 plays (ms)
  outputLatencyMs: number;
  trimMs: number;
  durationSec: number;
  leadSec?: number;
}
export interface StartPlan {
  /** AudioContext time to pass to source.start() */
  when: number;
  /** offset into the buffer in seconds */
  offsetSec: number;
  /** ctx time at which buffer position 0 would have played (anchor for position math) */
  originCtx: number;
}

/**
 * ctxTime = ctxNow + (S - serverNow)/1000 - outputLatency - trim/1000
 * If that is already in the past, start slightly in the future with an offset into the buffer
 * (late join / re-seek). Returns null when the position is past the end of the buffer.
 */
export function planStart(p: PlanInput): StartPlan | null {
  const lead = p.leadSec ?? START_LEAD_S;
  const originCtx = p.ctxNow + (p.S - p.serverNow) / 1000 - p.outputLatencyMs / 1000 - p.trimMs / 1000;
  if (originCtx >= p.ctxNow + lead) return { when: originCtx, offsetSec: 0, originCtx };
  const when = p.ctxNow + lead;
  const offsetSec = when - originCtx;
  if (offsetSec >= p.durationSec) return null;
  return { when, offsetSec, originCtx };
}

/** Ideal track position (ms) that should be coming out of the *render* path at this instant. */
export function expectedPositionMs(serverNow: number, S: number, outputLatencyMs: number, trimMs: number): number {
  return serverNow - S + outputLatencyMs + trimMs;
}

export interface DriftDecision {
  action: 'none' | 'nudge' | 'reseek';
  rate: number; // playbackRate to apply (1 when none/reseek)
}

/** driftMs = actual - expected (positive: we are ahead, so slow down). */
export function decideDrift(driftMs: number, intervalMs = DRIFT_INTERVAL_MS): DriftDecision {
  const a = Math.abs(driftMs);
  if (a >= DRIFT_RESEEK_MS) return { action: 'reseek', rate: 1 };
  if (a < DRIFT_DEADBAND_MS) return { action: 'none', rate: 1 };
  const adj = Math.max(-MAX_RATE_NUDGE, Math.min(MAX_RATE_NUDGE, -driftMs / intervalMs));
  return { action: 'nudge', rate: 1 + adj };
}

/** Position of a source with piecewise-constant rate. */
export function positionFromAnchor(anchorPosMs: number, anchorCtx: number, rate: number, ctxTime: number): number {
  return anchorPosMs + (ctxTime - anchorCtx) * 1000 * rate;
}

/** Mixing matrix [outL<-inL, outL<-inR, outR<-inL, outR<-inR] per channel role. */
export function channelMatrix(ch: Channel): [number, number, number, number] {
  switch (ch) {
    case 'left':
    case 'rear-left':
      return [1, 0, 1, 0];
    case 'right':
    case 'rear-right':
      return [0, 1, 0, 1];
    case 'center':
    case 'sub':
      return [0.5, 0.5, 0.5, 0.5];
    default:
      return [1, 0, 0, 1];
  }
}

export interface BeatOpts {
  windowMs?: number;
  sensitivity?: number; // energy must exceed mean*sensitivity
  minGapMs?: number;
  floor?: number;
}

/** Energy-based beat detector: fires when instantaneous energy exceeds a local average. */
export class BeatDetector {
  private hist: { t: number; e: number }[] = [];
  private last = -1e9;
  private o: Required<BeatOpts>;
  constructor(o: BeatOpts = {}) {
    this.o = { windowMs: 1000, sensitivity: 1.35, minGapMs: 260, floor: 0.08, ...o };
  }
  reset() {
    this.hist = [];
  }
  /** energy in 0..1; t in ms. Returns true on a beat. */
  update(energy: number, t: number): boolean {
    const h = this.hist;
    h.push({ t, e: energy });
    while (h.length && t - h[0].t > this.o.windowMs) h.shift();
    if (h.length < 10) return false;
    let sum = 0;
    for (const x of h) sum += x.e;
    const mean = sum / h.length;
    let v = 0;
    for (const x of h) v += (x.e - mean) ** 2;
    const sd = Math.sqrt(v / h.length);
    const thr = Math.max(mean * this.o.sensitivity, mean + 1.5 * sd);
    if (energy > thr && energy > this.o.floor && t - this.last >= this.o.minGapMs) {
      this.last = t;
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// AudioEngine
// ---------------------------------------------------------------------------

type Ctor = typeof AudioContext;

export class AudioEngine {
  ctx: AudioContext | null = null;
  analyser!: AnalyserNode;
  driftMs = 0;

  private input!: GainNode;
  private fileGain!: GainNode; // file playback bus (ducked during announcements)
  private matrix: GainNode[] = [];
  private lowpass!: BiquadFilterNode;
  private master!: GainNode;

  private serverNow: () => number = () => Date.now();
  private buffers = new Map<string, AudioBuffer>();
  private stemBuffers = new Map<string, AudioBuffer>(); // `${trackId}|${stem}`
  private stemLoading = new Map<string, Promise<void>>();
  private stemGains = new Map<StemName, GainNode>();
  private loading = new Map<string, Promise<void>>();
  /** Download progress (0..100) of the track currently being fetched, for UI only. */
  loadPct = 0;
  private localVolume = 1;
  private roomVolume = 1;
  private channel: Channel = 'stereo';

  private lastState: RoomState | null = null;
  private lastSelf: Device | null = null;
  /** Running sources of the current playback; all share one timeline anchor (anchorPosMs/anchorCtx/rate). */
  private srcs = new Map<SourceName, AudioBufferSourceNode>();
  private group = 0;
  private key = '';
  private trackId: string | null = null;
  private trimApplied = 0;
  private pausedPos = 0;
  private playing = false;
  private anchorPosMs = 0;
  private anchorCtx = 0;
  private rate = 1;
  private startCtx = 0;
  private durationMs = 0;

  private driftTimer: ReturnType<typeof setInterval> | null = null;
  private beatTimer: ReturnType<typeof setInterval> | null = null;
  private reportCbs = new Set<(r: { driftMs: number }) => void>();
  private beatCbs = new Set<(t: number) => void>();
  private endCbs = new Set<(trackId: string) => void>();
  private detector = new BeatDetector();
  private freq: Uint8Array<ArrayBuffer> | null = null;

  // live audio (share / announce)
  readonly liveSched = new LiveScheduler(planStart);
  private liveSources = new Set<AudioBufferSourceNode>();
  private liveKey = '';
  private liveActive = false;

  constructor(serverNow?: () => number) {
    if (serverNow) this.serverNow = serverNow;
    this.init();
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.reapply();
      });
    }
  }

  setServerClock(fn: () => number): void {
    this.serverNow = fn;
  }

  private init() {
    const C: Ctor | undefined =
      typeof AudioContext !== 'undefined' ? AudioContext : (globalThis as any).webkitAudioContext;
    if (!C) return;
    const ctx = new C({ latencyHint: 'interactive' });
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.fileGain = ctx.createGain();
    this.fileGain.connect(this.input);
    for (const s of STEMS) {
      const g = ctx.createGain();
      g.connect(this.fileGain);
      this.stemGains.set(s, g);
    }
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    this.input.connect(splitter);
    // matrix gains: index = outCh*2 + inCh
    for (let out = 0; out < 2; out++) {
      for (let inn = 0; inn < 2; inn++) {
        const g = ctx.createGain();
        splitter.connect(g, inn);
        g.connect(merger, 0, out);
        this.matrix[out * 2 + inn] = g;
      }
    }
    this.lowpass = ctx.createBiquadFilter();
    this.lowpass.type = 'lowpass';
    this.master = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.2;
    merger.connect(this.lowpass);
    this.lowpass.connect(this.master);
    this.master.connect(this.analyser);
    this.analyser.connect(ctx.destination);
    this.freq = new Uint8Array(new ArrayBuffer(this.analyser.frequencyBinCount));
    this.setChannel('stereo');
    this.updateVolume();
    ctx.addEventListener('statechange', () => {
      if (ctx.state === 'running') this.reapply();
    });
    this.driftTimer = setInterval(() => this.driftTick(), DRIFT_INTERVAL_MS);
    this.beatTimer = setInterval(() => this.beatTick(), 16);
  }

  /** Call from a user gesture. */
  async unlock(): Promise<void> {
    try {
      const as = (navigator as any).audioSession;
      if (as) as.type = 'playback'; // iOS: play through the silent switch
    } catch {
      /* ignore */
    }
    if (!this.ctx) return;
    try {
      await this.ctx.resume();
    } catch {
      /* ignore */
    }
    // tiny silent buffer to fully unlock iOS
    try {
      const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      const s = this.ctx.createBufferSource();
      s.buffer = b;
      s.connect(this.ctx.destination);
      s.start(0);
    } catch {
      /* ignore */
    }
    this.reapply();
  }

  get unlocked(): boolean {
    return this.ctx?.state === 'running';
  }

  has(trackId: string): boolean {
    return this.buffers.has(trackId);
  }

  load(trackUrl: string, trackId: string): Promise<void> {
    if (this.buffers.has(trackId)) return Promise.resolve();
    const inflight = this.loading.get(trackId);
    if (inflight) return inflight;
    const p = (async () => {
      if (!this.ctx) throw new Error('Web Audio unavailable');
      const res = await fetch(trackUrl);
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      const data = await readWithProgress(res, (p) => { this.loadPct = p; });
      this.loadPct = 100; // downloaded, now decoding
      let buf: AudioBuffer;
      try {
        buf = await this.ctx.decodeAudioData(data);
      } catch {
        throw new Error('decode failed: this browser cannot read that audio format');
      }
      this.buffers.set(trackId, buf);
      // keep memory bounded: current + newest 2
      if (this.buffers.size > 3) {
        for (const k of this.buffers.keys()) {
          if (k !== this.trackId && k !== trackId && this.buffers.size > 3) this.buffers.delete(k);
        }
      }
    })().finally(() => this.loading.delete(trackId));
    this.loading.set(trackId, p);
    return p.then(() => this.reapply());
  }

  hasStem(trackId: string, stem: string): boolean {
    return this.stemBuffers.has(`${trackId}|${stem}`);
  }

  /** Stems of `trackId` that are decoded and ready to play. */
  loadedStems(trackId: string): StemName[] {
    return STEMS.filter((s) => this.stemBuffers.has(`${trackId}|${s}`));
  }

  /** Fetch + decode one stem of a separated track. Only the current track's stems are kept in memory. */
  loadStem(url: string, trackId: string, stem: StemName): Promise<void> {
    const key = `${trackId}|${stem}`;
    if (this.stemBuffers.has(key)) return Promise.resolve();
    const inflight = this.stemLoading.get(key);
    if (inflight) return inflight;
    const p = (async () => {
      if (!this.ctx) throw new Error('Web Audio unavailable');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${stem} download failed (${res.status})`);
      const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
      for (const k of this.stemBuffers.keys()) if (!k.startsWith(trackId + '|')) this.stemBuffers.delete(k);
      this.stemBuffers.set(key, buf);
    })().finally(() => this.stemLoading.delete(key));
    this.stemLoading.set(key, p);
    return p.then(() => this.reapply());
  }

  private bufferFor(trackId: string, name: SourceName): AudioBuffer | undefined {
    return name === 'mix' ? this.buffers.get(trackId) : this.stemBuffers.get(`${trackId}|${name}`);
  }

  setLocalVolume(v: number): void {
    this.localVolume = Math.max(0, Math.min(1, v));
    this.updateVolume();
  }

  private updateVolume() {
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.roomVolume * this.localVolume, this.ctx.currentTime, 0.01);
  }

  private setChannel(ch: Channel) {
    this.channel = ch;
    if (!this.ctx) return;
    const m = channelMatrix(ch);
    for (let i = 0; i < 4; i++) this.matrix[i].gain.value = m[i];
    this.lowpass.frequency.value = ch === 'sub' ? 120 : this.ctx.sampleRate / 2;
  }

  /** AudioContext time at which server time `S` (ms) should be *heard* (no output latency, no trim). */
  ctxTimeForServer(S: number): number {
    return (this.ctx?.currentTime ?? 0) + (S - this.serverNow()) / 1000;
  }

  /**
   * Calibration: play `chirp` so it is audible at server time S. Same scheduling math as playback
   * (planStart: outputLatency compensated) but NO trim, and it bypasses channel routing/volume.
   * Returns false if S is already too close/past.
   */
  playChirpAt(S: number, chirp: Float32Array): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    const plan = planStart({ ctxNow: ctx.currentTime, serverNow: this.serverNow(), S, outputLatencyMs: this.outputLatencyMs, trimMs: 0, durationSec: 1e9 });
    if (!plan || plan.offsetSec > 0) return false; // late: would be misaligned
    const buf = ctx.createBuffer(1, chirp.length, ctx.sampleRate);
    buf.getChannelData(0).set(chirp);
    const src = ctx.createBufferSource();
    const g = ctx.createGain();
    g.gain.value = 0.7;
    src.buffer = buf;
    src.connect(g).connect(ctx.destination);
    src.start(plan.when);
    return true;
  }

  get outputLatencyMs(): number {
    const c = this.ctx as any;
    if (!c) return 0;
    const l = typeof c.outputLatency === 'number' && c.outputLatency > 0 ? c.outputLatency : c.baseLatency || 0;
    return l * 1000;
  }

  /** Idempotent. Call with every state broadcast (and again when clock/buffers/ctx become ready). */
  applyState(state: RoomState, self: Device | null | undefined): void {
    this.lastState = state;
    this.lastSelf = self ?? null;
    if (!this.ctx) return;
    this.roomVolume = state.volume;
    this.updateVolume();
    this.applyStemVolumes(state);
    const ch = self?.channel ?? 'stereo';
    if (ch !== this.channel) this.setChannel(ch);
    const trim = self?.trimMs ?? 0;
    const pb = state.playback;
    this.trackId = pb.trackId;

    const live = state.live ?? null;
    this.applyLive(live);
    if (live?.kind === 'share') {
      // live share replaces file playback entirely
      this.stopSources();
      this.key = '';
      this.playing = false;
      this.pausedPos = 0;
      this.driftMs = 0;
      return;
    }

    if (pb.status === 'paused' || pb.status === 'stopped' || pb.startServerTime == null || !pb.trackId) {
      this.stopSources();
      this.key = '';
      this.pausedPos = pb.status === 'paused' ? pb.pausedPositionMs : 0;
      this.playing = false;
      this.driftMs = 0;
      return;
    }
    const track = state.tracks.find((t) => t.id === pb.trackId);
    const want = wantedSources(track, state.orchestra, self?.stems);
    if (this.ctx.state !== 'running') {
      this.stopSources();
      this.key = '';
      this.playing = false;
      return;
    }
    const have = want.every((n) => this.bufferFor(pb.trackId!, n));
    const key = `${pb.trackId}|${pb.startServerTime}`;
    if (this.srcs.size > 0 && key === this.key && trim === this.trimApplied) {
      const d = diffSources([...this.srcs.keys()], want);
      if (d.add.length === 0 && d.remove.length === 0) return;
      if (!have) return; // assignment changed: keep the current sources until the new ones are decoded
      if (this.ctx.currentTime >= this.startCtx) this.swapSources(pb.trackId, want);
      else this.startSources(pb.trackId, want, pb.startServerTime, trim, key); // not started yet: just re-plan
      return;
    }
    if (!have) {
      // not ready to produce sound yet; reapply() is triggered on load/unlock
      this.stopSources();
      this.key = '';
      this.playing = false;
      return;
    }
    this.startSources(pb.trackId, want, pb.startServerTime, trim, key);
  }

  private applyStemVolumes(state: RoomState) {
    const ctx = this.ctx;
    const vols = state.orchestra?.stemVolumes;
    if (!ctx) return;
    for (const s of STEMS) {
      const v = vols && typeof vols[s] === 'number' ? Math.max(0, Math.min(1, vols[s])) : 1;
      this.stemGains.get(s)?.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
    }
  }

  private applyLive(live: RoomState['live']) {
    const ctx = this.ctx!;
    const key = live ? `${live.kind}|${live.sourceId}` : '';
    if (key !== this.liveKey) {
      this.liveKey = key;
      this.liveSched.reset();
      this.stopLiveSources();
    }
    this.liveActive = !!live;
    this.fileGain.gain.setTargetAtTime(live?.kind === 'announce' ? DUCK_GAIN : 1, ctx.currentTime, 0.05);
  }

  private stopLiveSources() {
    for (const s of this.liveSources) {
      s.onended = null;
      try { s.stop(); } catch { /* ignore */ }
      try { s.disconnect(); } catch { /* ignore */ }
    }
    this.liveSources.clear();
  }

  /** Feed one binary live frame (from the WebSocket, or the host's own capture) into the playout scheduler. */
  pushLiveFrame(buf: ArrayBuffer): void {
    const ctx = this.ctx;
    const live = this.lastState?.live;
    if (!ctx || !live || ctx.state !== 'running') return;
    const f = decodeFrame(buf);
    if (!f) return;
    const r = this.liveSched.schedule(f, {
      ctxNow: ctx.currentTime,
      serverNow: this.serverNow(),
      outputLatencyMs: this.outputLatencyMs,
      trimMs: this.lastSelf?.trimMs ?? 0,
      bufferMs: live.bufferMs,
    });
    if (r.action !== 'play') return;
    const ab = ctx.createBuffer(f.channels, f.frames, f.sampleRate);
    const chans = pcmToFloat(f);
    for (let c = 0; c < f.channels; c++) ab.copyToChannel(chans[c] as Float32Array<ArrayBuffer>, c);
    const s = ctx.createBufferSource();
    s.buffer = ab;
    s.connect(this.input);
    s.onended = () => { this.liveSources.delete(s); try { s.disconnect(); } catch { /* ignore */ } };
    this.liveSources.add(s);
    s.start(r.when, r.offsetSec);
  }

  private reapply() {
    if (this.lastState) this.applyState(this.lastState, this.lastSelf);
  }

  private connectSource(src: AudioBufferSourceNode, name: SourceName) {
    src.connect(name === 'mix' ? this.fileGain : this.stemGains.get(name)!);
  }

  /** (Re)start all `names` together at the planned instant. They share one anchor so drift/seek treat them as one. */
  private startSources(trackId: string, names: SourceName[], S: number, trim: number, key: string) {
    const ctx = this.ctx!;
    this.stopSources();
    const bufs = names.map((n) => [n, this.bufferFor(trackId, n)!] as const);
    const durationSec = Math.min(...bufs.map(([, b]) => b.duration));
    const plan = planStart({
      ctxNow: ctx.currentTime,
      serverNow: this.serverNow(),
      S,
      outputLatencyMs: this.outputLatencyMs,
      trimMs: trim,
      durationSec,
    });
    this.key = key;
    this.trimApplied = trim;
    this.durationMs = durationSec * 1000;
    if (!plan) {
      this.playing = false; // past the end
      return;
    }
    const group = ++this.group;
    for (const [name, buf] of bufs) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      this.connectSource(src, name);
      src.onended = () => this.onSourceEnded(group, trackId);
      src.start(plan.when, plan.offsetSec);
      this.srcs.set(name, src);
    }
    this.rate = 1;
    this.anchorCtx = plan.when;
    this.anchorPosMs = plan.offsetSec * 1000;
    this.startCtx = plan.when;
    this.playing = true;
    this.driftMs = 0;
  }

  private onSourceEnded(group: number, trackId: string) {
    if (group !== this.group || this.srcs.size === 0) return; // superseded or already stopped
    this.srcs.clear();
    this.playing = false;
    for (const cb of this.endCbs) cb(trackId);
  }

  /**
   * Orchestra: change the running source set without touching the timeline. Kept sources keep playing;
   * new ones start at the instant (now + lead) at the position the shared anchor says is current, with the
   * current nudged playbackRate; removed ones stop at that same instant.
   */
  private swapSources(trackId: string, want: SourceName[]) {
    const ctx = this.ctx!;
    const d = diffSources([...this.srcs.keys()], want);
    const when = ctx.currentTime + START_LEAD_S;
    const posSec = positionFromAnchor(this.anchorPosMs, this.anchorCtx, this.rate, when) / 1000;
    const group = this.group;
    for (const name of d.remove) {
      const src = this.srcs.get(name)!;
      this.srcs.delete(name);
      src.onended = null;
      try { src.stop(when); } catch { /* ignore */ }
      setTimeout(() => { try { src.disconnect(); } catch { /* ignore */ } }, START_LEAD_S * 1000 + 100);
    }
    for (const name of d.add) {
      const buf = this.bufferFor(trackId, name)!;
      if (posSec >= buf.duration) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = this.rate;
      this.connectSource(src, name);
      src.onended = () => this.onSourceEnded(group, trackId);
      src.start(when, posSec);
      this.srcs.set(name, src);
    }
    if (this.srcs.size === 0) this.playing = false;
  }

  private stopSources() {
    this.group++;
    for (const s of this.srcs.values()) {
      s.onended = null;
      try { s.stop(); } catch { /* ignore */ }
      try { s.disconnect(); } catch { /* ignore */ }
    }
    this.srcs.clear();
  }

  /** Current track position in ms (what is being rendered now); paused position when paused. */
  getPositionMs(): number {
    if (!this.ctx) return 0;
    if (this.playing && this.srcs.size > 0) {
      const t = this.ctx.currentTime;
      if (t < this.startCtx) return 0;
      return Math.max(0, positionFromAnchor(this.anchorPosMs, this.anchorCtx, this.rate, t));
    }
    return this.pausedPos;
  }

  /** Signed drift (actual - expected) in ms right now, or null if not currently playing. */
  measureDriftMs(): number | null {
    const ctx = this.ctx;
    const pb = this.lastState?.playback;
    if (!ctx || !this.playing || this.srcs.size === 0 || !pb || pb.startServerTime == null) return null;
    if (ctx.currentTime < this.startCtx + 0.05) return null; // not started yet
    const actual = positionFromAnchor(this.anchorPosMs, this.anchorCtx, this.rate, ctx.currentTime);
    const expected = expectedPositionMs(this.serverNow(), pb.startServerTime, this.outputLatencyMs, this.trimApplied);
    return actual - expected;
  }

  private driftTick() {
    const ctx = this.ctx;
    if (!ctx) return;
    const d = this.measureDriftMs();
    if (d == null) {
      this.driftMs = 0;
      return;
    }
    this.driftMs = d;
    const dec = decideDrift(d);
    if (dec.action === 'reseek') {
      this.key = ''; // force restart at the correct offset
      this.reapply();
    } else if (this.srcs.size > 0) {
      if (Math.abs(dec.rate - this.rate) > 1e-6) {
        const now = ctx.currentTime;
        this.anchorPosMs = positionFromAnchor(this.anchorPosMs, this.anchorCtx, this.rate, now);
        this.anchorCtx = now;
        this.rate = dec.rate;
        for (const src of this.srcs.values()) src.playbackRate.setValueAtTime(dec.rate, now); // all stems together
      }
    }
    for (const cb of this.reportCbs) cb({ driftMs: this.driftMs });
  }

  /** Fires every drift loop tick (2s) with the latest drift. */
  onReport(cb: (r: { driftMs: number }) => void): () => void {
    this.reportCbs.add(cb);
    return () => this.reportCbs.delete(cb);
  }

  /** Fires at (estimated) audio output time. */
  onBeat(cb: (t: number) => void): () => void {
    this.beatCbs.add(cb);
    return () => this.beatCbs.delete(cb);
  }

  /** Fires when a track plays to its natural end. */
  onEnded(cb: (trackId: string) => void): () => void {
    this.endCbs.add(cb);
    return () => this.endCbs.delete(cb);
  }

  private beatTick() {
    if ((!this.playing && !this.liveActive) || !this.analyser || !this.freq || this.beatCbs.size === 0) return;
    if (!this.liveActive && this.ctx && this.ctx.currentTime < this.startCtx) return;
    this.analyser.getByteFrequencyData(this.freq);
    // bass energy: bins up to ~200 Hz
    const binHz = (this.ctx!.sampleRate / 2) / this.freq.length;
    const end = Math.max(2, Math.min(this.freq.length, Math.ceil(200 / binHz)));
    let sum = 0;
    for (let i = 1; i < end; i++) sum += this.freq[i] / 255;
    const energy = sum / (end - 1);
    const now = performance.now();
    if (this.detector.update(energy, now)) {
      // analyser sees audio before it is audible; delay by output latency
      const delay = this.outputLatencyMs;
      const fire = () => {
        const t = this.serverNow();
        for (const cb of this.beatCbs) cb(t);
      };
      if (delay > 2) setTimeout(fire, delay);
      else fire();
    }
  }

  /** Stop everything (leave room). */
  dispose(): void {
    this.stopSources();
    this.stopLiveSources();
    this.playing = false;
    if (this.driftTimer) clearInterval(this.driftTimer);
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.driftTimer = this.beatTimer = null;
    this.ctx?.suspend().catch(() => {});
  }
}

/** Read a response body into an ArrayBuffer, reporting 0..100 when Content-Length is known. */
async function readWithProgress(res: Response, onPct: (pct: number) => void): Promise<ArrayBuffer> {
  const total = Number(res.headers?.get?.('content-length')) || 0;
  if (!res.body?.getReader || !total) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onPct(Math.min(99, Math.round((got / total) * 100)));
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out.buffer;
}
