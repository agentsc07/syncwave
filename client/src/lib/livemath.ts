// Pure live-audio helpers (no DOM). Shared by capture, playback and tests.
import type { PlanInput, StartPlan } from './engine';

export const LIVE_VERSION = 1;
export const LIVE_HEADER_BYTES = 20;
export const LIVE_CHUNK_MS = 20;
export const DUCK_GAIN = 0.25;
export const LIVE_BUFFER = {
  share: { def: 1500, min: 800, max: 3000 },
  announce: { def: 250, min: 100, max: 1000 },
} as const;
/** Chunks whose planned start is within this of the previous chunk's end are butted up seamlessly. */
export const SNAP_S = 0.006;

export interface LiveFrame {
  channels: number;
  frames: number;
  seq: number;
  captureServerTime: number; // server ms of the first sample
  sampleRate: number;
  pcm: Int16Array; // interleaved
}

/** Header (little-endian): u8 version, u8 channels, u16 frames, u32 seq, f64 captureServerTime, u32 sampleRate; then Int16 interleaved PCM. */
export function encodeFrame(f: LiveFrame): ArrayBuffer {
  const buf = new ArrayBuffer(LIVE_HEADER_BYTES + f.pcm.length * 2);
  const dv = new DataView(buf);
  dv.setUint8(0, LIVE_VERSION);
  dv.setUint8(1, f.channels);
  dv.setUint16(2, f.frames, true);
  dv.setUint32(4, f.seq >>> 0, true);
  dv.setFloat64(8, f.captureServerTime, true);
  dv.setUint32(16, f.sampleRate, true);
  for (let i = 0; i < f.pcm.length; i++) dv.setInt16(LIVE_HEADER_BYTES + i * 2, f.pcm[i], true);
  return buf;
}

export function decodeFrame(buf: ArrayBuffer): LiveFrame | null {
  if (buf.byteLength < LIVE_HEADER_BYTES) return null;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== LIVE_VERSION) return null;
  const channels = dv.getUint8(1);
  const frames = dv.getUint16(2, true);
  const sampleRate = dv.getUint32(16, true);
  if (channels < 1 || channels > 2 || frames < 1 || sampleRate < 3000 || sampleRate > 384000) return null;
  if (buf.byteLength < LIVE_HEADER_BYTES + frames * channels * 2) return null;
  const pcm = new Int16Array(frames * channels);
  for (let i = 0; i < pcm.length; i++) pcm[i] = dv.getInt16(LIVE_HEADER_BYTES + i * 2, true);
  return { channels, frames, seq: dv.getUint32(4, true), captureServerTime: dv.getFloat64(8, true), sampleRate, pcm };
}

/** Deinterleave Int16 into per-channel Float32. */
export function pcmToFloat(f: LiveFrame): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < f.channels; c++) out.push(new Float32Array(f.frames));
  for (let i = 0; i < f.frames; i++) for (let c = 0; c < f.channels; c++) out[c][i] = f.pcm[i * f.channels + c] / 32768;
  return out;
}

export function clampBuffer(kind: 'share' | 'announce', ms: number): number {
  const r = LIVE_BUFFER[kind];
  return Math.max(r.min, Math.min(r.max, Math.round(ms)));
}

export interface Chunk {
  pcm: Int16Array;
  frames: number;
  ctxStart: number; // AudioContext time of the first sample
}

/** Accumulates float blocks (e.g. 128-frame worklet quanta) into fixed ~20 ms Int16 interleaved chunks. */
export class Chunker {
  readonly chunkFrames: number;
  private buf: Int16Array;
  private fill = 0;
  private start = 0;
  constructor(readonly sampleRate: number, readonly channels: number, chunkMs = LIVE_CHUNK_MS, private emit: (c: Chunk) => void) {
    this.chunkFrames = Math.max(1, Math.round((sampleRate * chunkMs) / 1000));
    this.buf = new Int16Array(this.chunkFrames * channels);
  }
  /** blocks: one Float32Array per channel; t: ctx time of the block's first sample. */
  push(blocks: Float32Array[], t: number): void {
    const n = blocks[0]?.length ?? 0;
    for (let i = 0; i < n; i++) {
      if (this.fill === 0) this.start = t + i / this.sampleRate;
      for (let c = 0; c < this.channels; c++) {
        const x = blocks[Math.min(c, blocks.length - 1)][i];
        const v = x < 0 ? Math.max(-1, x) * 32768 : Math.min(1, x) * 32767;
        this.buf[this.fill * this.channels + c] = v;
      }
      if (++this.fill === this.chunkFrames) {
        this.emit({ pcm: this.buf.slice(), frames: this.chunkFrames, ctxStart: this.start });
        this.fill = 0;
      }
    }
  }
}

export interface SchedEnv {
  ctxNow: number;
  serverNow: number;
  outputLatencyMs: number;
  trimMs: number;
  bufferMs: number;
}
export type SchedResult =
  | { action: 'play'; when: number; offsetSec: number }
  | { action: 'drop'; reason: 'late' | 'dup' };

/**
 * Decides when each received chunk plays on the AudioContext clock.
 * Target: captureServerTime + bufferMs, converted exactly like file playback (planStart:
 * ctx = ctxNow + (S - serverNow)/1000 - outputLatency - trim). Late chunks are dropped
 * (or head-trimmed if only partly late); missing chunks simply leave silence.
 * `plan` is engine.planStart (injected to avoid a module cycle).
 */
export class LiveScheduler {
  lastSeq = -1;
  nextCtx = 0; // ctx time at which the previously scheduled chunk ends
  stats = { played: 0, late: 0, dup: 0, gaps: 0 };
  constructor(private plan: (p: PlanInput) => StartPlan | null) {}

  reset(): void {
    this.lastSeq = -1;
    this.nextCtx = 0;
    this.stats = { played: 0, late: 0, dup: 0, gaps: 0 };
  }

  schedule(f: { seq: number; captureServerTime: number; frames: number; sampleRate: number }, env: SchedEnv): SchedResult {
    if (f.seq <= this.lastSeq) { this.stats.dup++; return { action: 'drop', reason: 'dup' }; }
    if (this.lastSeq >= 0) this.stats.gaps += f.seq - this.lastSeq - 1;
    this.lastSeq = f.seq;
    const dur = f.frames / f.sampleRate;
    const p = this.plan({
      ctxNow: env.ctxNow, serverNow: env.serverNow, S: f.captureServerTime + env.bufferMs,
      outputLatencyMs: env.outputLatencyMs, trimMs: env.trimMs, durationSec: dur,
    });
    if (!p) { this.stats.late++; return { action: 'drop', reason: 'late' }; }
    let { when, offsetSec } = p;
    const origin = p.originCtx;
    if (this.nextCtx > 0 && Math.abs(origin - this.nextCtx) <= SNAP_S) {
      // butt up against the previous chunk to avoid clicks from timestamp jitter
      if (this.nextCtx >= env.ctxNow + 0.005) { when = this.nextCtx; offsetSec = 0; }
      else { when = p.when; offsetSec = Math.max(0, when - this.nextCtx); if (offsetSec >= dur) { this.stats.late++; return { action: 'drop', reason: 'late' }; } }
    }
    this.nextCtx = when - offsetSec + dur;
    this.stats.played++;
    return { action: 'play', when, offsetSec };
  }
}
