// NTP-style clock sync against the server. Pure math is exported separately for Node tests.

export interface ClockSample {
  offset: number; // server - local, ms
  rtt: number; // ms
}

/** t0 client send, t1 server recv, t2 server send, t3 client recv (all ms). */
export function computeSample(t0: number, t1: number, t2: number, t3: number): ClockSample {
  return {
    offset: (t1 - t0 + (t2 - t3)) / 2,
    rtt: t3 - t0 - (t2 - t1),
  };
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
}

/** Keep the lowest-RTT `fraction` of samples (at least 1). */
export function selectLowestRtt(samples: ClockSample[], fraction = 0.3): ClockSample[] {
  if (samples.length === 0) return [];
  const n = Math.max(1, Math.ceil(samples.length * fraction));
  return [...samples].sort((a, b) => a.rtt - b.rtt).slice(0, n);
}

/** Median offset of the lowest-RTT 30% of samples; rtt is the median RTT of that subset. */
export function estimateOffset(samples: ClockSample[], fraction = 0.3): ClockSample | null {
  const best = selectLowestRtt(samples.filter((s) => Number.isFinite(s.offset) && s.rtt >= 0), fraction);
  if (best.length === 0) return null;
  return { offset: median(best.map((s) => s.offset)), rtt: median(best.map((s) => s.rtt)) };
}

/** Local monotonic-ish epoch ms with sub-ms resolution. */
export function localNow(): number {
  return performance.timeOrigin + performance.now();
}

const FIRST_BURST = 20;
const LATER_BURST = 8;
const BURST_GAP_MS = 40;
const REPEAT_MS = 3000;
const POOL_SIZE = 40;
const HISTORY = 10;

export class ClockSync {
  offsetMs = 0;
  rtt = 0;
  stability = 0; // stddev (ms) of the last offset estimates
  synced = false; // true once the first burst produced an estimate

  private ws: WebSocket | null = null;
  private pool: ClockSample[] = [];
  private history: number[] = [];
  private cbs = new Set<() => void>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private burstLeft = 0;
  private bursts = 0;
  private running = false;
  private onMsg = (ev: MessageEvent) => {
    let m: any;
    try {
      m = JSON.parse(ev.data as string);
    } catch {
      return;
    }
    if (m && m.type === 'pong') this.handlePong(m.t0, m.t1, m.t2, localNow());
  };

  /** Start (or restart on a new socket). Keeps the previous estimate across reconnects. */
  start(ws: WebSocket): void {
    this.stop();
    this.ws = ws;
    this.running = true;
    this.bursts = 0;
    ws.addEventListener('message', this.onMsg);
    const go = () => this.burst(FIRST_BURST);
    if (ws.readyState === 1) go();
    else ws.addEventListener('open', go, { once: true });
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.ws?.removeEventListener('message', this.onMsg);
    this.ws = null;
  }

  /** Current server time in ms (epoch-based, sub-ms). */
  serverNow(): number {
    return localNow() + this.offsetMs;
  }

  onUpdate(cb: () => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }

  private later(fn: () => void, ms: number) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private burst(n: number) {
    if (!this.running) return;
    this.burstLeft = n;
    const tick = () => {
      if (!this.running || !this.ws) return;
      if (this.burstLeft <= 0) {
        this.finishBurst();
        return;
      }
      this.burstLeft--;
      if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'ping', t0: localNow() }));
      this.later(tick, BURST_GAP_MS);
    };
    tick();
  }

  private finishBurst() {
    this.bursts++;
    this.later(() => this.burst(LATER_BURST), REPEAT_MS);
  }

  private handlePong(t0: number, t1: number, t2: number, t3: number) {
    if (!Number.isFinite(t0)) return;
    this.pool.push(computeSample(t0, t1, t2, t3));
    if (this.pool.length > POOL_SIZE) this.pool.shift();
    const est = estimateOffset(this.pool);
    if (!est) return;
    this.offsetMs = est.offset;
    this.rtt = est.rtt;
    this.history.push(est.offset);
    if (this.history.length > HISTORY) this.history.shift();
    this.stability = stddev(this.history);
    // consider synced after at least 8 samples in pool
    if (!this.synced && this.pool.length >= 8) this.synced = true;
    for (const cb of this.cbs) cb();
  }
}
