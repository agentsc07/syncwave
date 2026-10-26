// Client side of acoustic auto-calibration (see PROTOCOL.md "Auto-calibration").
// Every device: plays chirps when the server says so. Host only: records the mic on the AudioContext clock,
// then analyses (calibrate.ts) and uploads per-device delay + score. Needs a browser; DSP lives in calibrate.ts.
import type { AudioEngine } from './engine';
import type { CalibrationState, ClientMessage, RoomState, ServerMessage } from './types';
import { makeChirp, measureDevice } from './calibrate';

type StepMsg = Extract<ServerMessage, { type: 'calibrateStep' }>;

export interface CalibHost {
  deviceId: string;
  engine: AudioEngine;
  send(m: ClientMessage): void;
  changed(): void;
}

const WORKLET_SRC = `class P extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage({t:currentTime,d:c.slice()});return true}}registerProcessor('sw-rec',P);`;

class MicRecorder {
  private blocks: { t: number; d: Float32Array }[] = [];
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  sampleRate = 48000;

  async start(ctx: AudioContext): Promise<void> {
    this.sampleRate = ctx.sampleRate;
    // Raw mic: processing would distort/suppress the chirp and shift timing.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } as MediaTrackConstraints,
    });
    const src = ctx.createMediaStreamSource(this.stream);
    const mute = ctx.createGain();
    mute.gain.value = 0; // keep the graph pulled without feeding the mic to the speakers
    mute.connect(ctx.destination);
    this.nodes = [src, mute];
    let done = false;
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const node = new AudioWorkletNode(ctx, 'sw-rec', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        node.port.onmessage = (e) => this.blocks.push(e.data as { t: number; d: Float32Array });
        src.connect(node).connect(mute);
        this.nodes.push(node);
        done = true;
      } catch { /* fall back */ }
    }
    if (!done) {
      const sp = ctx.createScriptProcessor(2048, 1, 1);
      sp.onaudioprocess = (e) => {
        // playbackTime = ctx time of the start of this block's output; input was captured one buffer earlier
        const d = new Float32Array(e.inputBuffer.getChannelData(0));
        this.blocks.push({ t: e.playbackTime - d.length / ctx.sampleRate, d });
      };
      src.connect(sp).connect(mute);
      this.nodes.push(sp);
    }
  }

  /** Stop and return the recording as one Float32Array whose sample 0 is at ctx time `startCtx`. */
  stop(): { rec: Float32Array; startCtx: number } | null {
    for (const n of this.nodes) { try { n.disconnect(); } catch { /* ignore */ } }
    this.nodes = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    const b = this.blocks;
    this.blocks = [];
    if (!b.length) return null;
    const sr = this.sampleRate, t0 = b[0].t;
    const last = b[b.length - 1];
    const rec = new Float32Array(Math.round((last.t - t0) * sr) + last.d.length);
    for (const x of b) rec.set(x.d, Math.round((x.t - t0) * sr)); // gaps (dropped blocks) stay zero
    return { rec, startCtx: t0 };
  }
}

export class CalibrationClient {
  /** Local, pre-server failure (mic denied, insecure context). Cleared on the next start. */
  localError: string | null = null;
  private runId: string | null = null;
  private recorder: MicRecorder | null = null;
  private steps: { deviceId: string; ctxTimes: number[] }[] = [];
  private analysed = false;
  private chirpCfg = { f0: 2000, f1: 8000, durMs: 100 };

  constructor(private host: CalibHost) {}

  /** Host button. Checks the browser can do it before bothering the room. */
  start(): void {
    this.localError = null;
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getUserMedia !== 'function' || (typeof isSecureContext !== 'undefined' && !isSecureContext)) {
      this.localError = 'insecure-context';
      this.host.changed();
      return;
    }
    this.host.send({ type: 'calibrateStart' });
  }

  cancel(): void { this.host.send({ type: 'calibrateCancel' }); }

  /** Every device: a chirp schedule for one device (the target plays; the host records the plan). */
  onStep(m: StepMsg): void {
    this.chirpCfg = m.chirp;
    const eng = this.host.engine;
    if (m.deviceId === this.host.deviceId && eng.ctx) {
      const chirp = makeChirp(eng.ctx.sampleRate, m.chirp.f0, m.chirp.f1, m.chirp.durMs);
      for (const t of m.times) eng.playChirpAt(t, chirp);
    }
    if (this.recorder && m.runId === this.runId) {
      this.steps.push({ deviceId: m.deviceId, ctxTimes: m.times.map((t) => eng.ctxTimeForServer(t)) });
    }
  }

  /** Call on every state broadcast. */
  onState(state: RoomState, isHost: boolean): void {
    const c: CalibrationState | undefined = state.calibration;
    if (!c || !isHost) { this.abort(); return; }
    if (c.status !== 'running') { this.abort(); return; }
    if (c.runId !== this.runId && c.phase === 'arming') void this.arm(c.runId!);
    else if (c.runId === this.runId && c.phase === 'analysing') this.finish();
  }

  dispose(): void { this.abort(); }

  private async arm(runId: string): Promise<void> {
    this.runId = runId;
    this.steps = [];
    this.analysed = false;
    const ctx = this.host.engine.ctx;
    const rec = new MicRecorder();
    this.recorder = rec;
    try {
      if (!ctx) throw new Error('no audio');
      await ctx.resume();
      await rec.start(ctx);
      if (this.recorder !== rec) { rec.stop(); return; } // cancelled while the permission prompt was open
      this.host.send({ type: 'calibrateReady', runId });
    } catch (e) {
      rec.stop();
      if (this.recorder === rec) this.recorder = null;
      const name = (e as Error)?.name;
      const err = name === 'NotAllowedError' || name === 'SecurityError' ? 'mic-denied' : 'mic-error';
      this.localError = err;
      this.host.send({ type: 'calibrationResult', runId, error: err });
      this.host.changed();
    }
  }

  private finish(): void {
    if (!this.recorder || this.analysed || !this.runId) return;
    this.analysed = true;
    const out = this.recorder.stop();
    const sr = this.recorder.sampleRate;
    this.recorder = null;
    const results: Record<string, { delayMs: number; score: number; error?: string }> = {};
    if (out) {
      const chirp = makeChirp(sr, this.chirpCfg.f0, this.chirpCfg.f1, this.chirpCfg.durMs);
      for (const s of this.steps) {
        const r = measureDevice(out.rec, sr, out.startCtx, chirp, s.ctxTimes);
        results[s.deviceId] = r.error ? { delayMs: 0, score: 0, error: r.error } : { delayMs: r.delayMs, score: r.score };
      }
    }
    this.host.send({ type: 'calibrationResult', runId: this.runId, results });
  }

  private abort(): void {
    if (this.recorder) { this.recorder.stop(); this.recorder = null; }
  }
}
