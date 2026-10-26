// Offline beat / onset analysis of a decoded track. DOM-free (testable in Node).
// Every device runs this on the same decoded file, so the resulting beat list (track-timeline seconds)
// is identical everywhere and lights can be fired in sync from the shared playback position.

export interface BeatMap {
  /** beat times in seconds on the track timeline */
  times: number[];
  /** 0..1 */
  strengths: number[];
  bpm: number | null;
  /** true when the beat is the first of a bar (every 4th beat, aligned to the strongest phase) */
  downbeats?: boolean[];
}

const NOMINAL_HOP_SEC = 0.005;
const MIN_GAP_SEC = 0.23;
const LP_HZ = 150;

type Chans = Float32Array[] | Float32Array;

function asChans(c: Chans): Float32Array[] {
  return Array.isArray(c) ? c : [c];
}

/** Streaming envelope builder: low-band (kick) and broadband-ish (high-passed) log energy per hop. */
class EnvBuilder {
  readonly hop: number;
  readonly hopSec: number;
  readonly nHops: number;
  low: Float32Array;
  high: Float32Array;
  private lp = 0;
  private prev = 0;
  private pos = 0;
  private readonly a: number;
  private readonly chans: Float32Array[];
  private readonly len: number;
  private readonly inv: number;
  constructor(chans: Float32Array[], sampleRate: number) {
    this.chans = chans;
    this.len = chans.reduce((m, c) => Math.min(m, c.length), Infinity);
    if (!isFinite(this.len)) this.len = 0;
    this.hop = Math.max(1, Math.round(sampleRate * NOMINAL_HOP_SEC));
    this.hopSec = this.hop / sampleRate;
    this.nHops = Math.floor(this.len / this.hop);
    this.low = new Float32Array(this.nHops);
    this.high = new Float32Array(this.nHops);
    this.a = 1 - Math.exp((-2 * Math.PI * LP_HZ) / sampleRate);
    this.inv = 1 / chans.length;
  }
  get done(): boolean {
    return this.pos >= this.nHops;
  }
  /** process up to `maxHops` hops */
  step(maxHops: number): void {
    const { hop, chans, a, inv } = this;
    const nc = chans.length;
    const end = Math.min(this.nHops, this.pos + maxHops);
    let lp = this.lp, prev = this.prev;
    for (let h = this.pos; h < end; h++) {
      let el = 0, eh = 0;
      const s0 = h * hop;
      for (let i = s0; i < s0 + hop; i++) {
        let x = 0;
        for (let c = 0; c < nc; c++) x += chans[c][i];
        x *= inv;
        lp += a * (x - lp);
        const d = x - prev;
        prev = x;
        el += lp * lp;
        eh += d * d;
      }
      this.low[h] = Math.log(1 + 80 * Math.sqrt(el / hop));
      this.high[h] = Math.log(1 + 80 * Math.sqrt(eh / hop));
    }
    this.lp = lp; this.prev = prev; this.pos = end;
  }
}

/** Onset strength: positive log-energy flux, low band weighted most. */
function onsetFromEnv(low: Float32Array, high: Float32Array): Float32Array {
  const n = low.length;
  const o = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const fl = low[i] - low[i - 1];
    const fh = high[i] - high[i - 1];
    o[i] = (fl > 0 ? fl : 0) + 0.45 * (fh > 0 ? fh : 0);
  }
  // 3-tap smoothing to merge the two-hop attack into one peak
  const s = new Float32Array(n);
  for (let i = 1; i < n - 1; i++) s[i] = 0.25 * o[i - 1] + 0.5 * o[i] + 0.25 * o[i + 1];
  return s;
}

function percentile(a: ArrayLike<number>, p: number): number {
  const c = Array.from(a as ArrayLike<number>).sort((x, y) => x - y);
  if (!c.length) return 0;
  return c[Math.min(c.length - 1, Math.floor(p * c.length))];
}

interface Peak { i: number; t: number; v: number }

function pickPeaks(on: Float32Array, HOP_SEC: number): Peak[] {
  const n = on.length;
  if (n < 10) return [];
  const w = Math.round(0.4 / HOP_SEC); // half window ~0.4 s -> 0.8 s
  const ps = new Float64Array(n + 1), ps2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) { ps[i + 1] = ps[i] + on[i]; ps2[i + 1] = ps2[i] + on[i] * on[i]; }
  const p98 = percentile(on, 0.995);
  const floor = Math.max(0.12, 0.22 * p98);
  const near = Math.round(0.04 / HOP_SEC);
  const cand: Peak[] = [];
  for (let i = near; i < n - near; i++) {
    const v = on[i];
    if (v < floor) continue;
    let isMax = true;
    for (let k = 1; k <= near && isMax; k++) if (on[i - k] > v || on[i + k] >= v) isMax = false;
    if (!isMax) continue;
    const a = Math.max(0, i - w), b = Math.min(n, i + w + 1);
    const m = (ps[b] - ps[a]) / (b - a);
    const sd = Math.sqrt(Math.max(0, (ps2[b] - ps2[a]) / (b - a) - m * m));
    if (v < m + 1.1 * sd) continue;
    // parabolic sub-hop refinement
    const l = on[i - 1], r = on[i + 1];
    const den = l - 2 * v + r;
    const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (l - r)) / den)) : 0;
    cand.push({ i, t: (i + off) * HOP_SEC, v });
  }
  // enforce minimum gap, keeping the stronger of two close peaks
  const out: Peak[] = [];
  for (const c of cand) {
    const last = out[out.length - 1];
    if (last && c.t - last.t < MIN_GAP_SEC) {
      if (c.v > last.v) out[out.length - 1] = c;
    } else out.push(c);
  }
  return out;
}

/** Tempo (BPM, folded to 60..180) from autocorrelation of the onset envelope; null if unconvincing. */
function estimateTempo(on: Float32Array, HOP_SEC: number): { bpm: number; conf: number } | null {
  const n = on.length;
  const minLag = Math.floor(0.33 / HOP_SEC) - 2, maxLag = Math.ceil(1.0 / HOP_SEC) * 4 + 2;
  if (n < maxLag + 10) return null;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += on[i];
  mean /= n;
  const x = new Float32Array(n);
  let e0 = 0;
  for (let i = 0; i < n; i++) { x[i] = on[i] - mean; e0 += x[i] * x[i]; }
  if (e0 < 1e-9) return null;
  const ac = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += x[i] * x[i - lag];
    ac[lag] = s / (e0 * (n - lag) / n);
  }
  const at = (lag: number) => {
    const i = Math.floor(lag), f = lag - i;
    if (i + 1 > maxLag) return 0;
    return ac[i] * (1 - f) + ac[i + 1] * f;
  };
  let best = 0, bestScore = -1, sum = 0, cnt = 0;
  for (let bpm = 60; bpm <= 180; bpm += 0.25) {
    const lag = 60 / bpm / HOP_SEC;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    const sc = (at(lag) + 0.5 * at(2 * lag) + 0.25 * at(4 * lag)) * prior;
    sum += Math.max(0, sc); cnt++;
    if (sc > bestScore) { bestScore = sc; best = bpm; }
  }
  const conf = bestScore / Math.max(1e-9, sum / cnt);
  if (bestScore <= 0.05) return null;
  return { bpm: best, conf };
}

function finish(on: Float32Array, durationSec: number, HOP_SEC: number): BeatMap {
  let peaks = pickPeaks(on, HOP_SEC);
  if (peaks.length < 3) return { times: [], strengths: [], bpm: null };
  const ref = Math.max(1e-6, 1.15 * percentile(peaks.map((p) => p.v), 0.9));
  const str = (v: number) => Math.max(0.12, Math.min(1, v / ref));

  const tempo = estimateTempo(on, HOP_SEC);
  const bpm = tempo ? Math.round(tempo.bpm * 10) / 10 : null;
  let times = peaks.map((p) => p.t);
  let strengths = peaks.map((p) => str(p.v));

  if (tempo && tempo.conf > 2) {
    const P = 60 / tempo.bpm;
    // grid phase: the one that collects the most onset strength
    let bestPh = 0, bestSc = -1;
    const steps = Math.max(8, Math.round(P / HOP_SEC));
    for (let s = 0; s < steps; s++) {
      const ph = (s / steps) * P;
      let sc = 0;
      for (let k = 0; ; k++) {
        const idx = Math.round((ph + k * P) / HOP_SEC);
        if (idx >= on.length - 1) break;
        sc += on[idx];
      }
      if (sc > bestSc) { bestSc = sc; bestPh = ph; }
    }
    const resid = (t: number) => {
      const q = (t - bestPh) / P;
      return (q - Math.round(q)) * P;
    };
    // drop weak off-grid detections (hats, noise) when the grid is trustworthy
    const kt: number[] = [], ks: number[] = [];
    for (let i = 0; i < times.length; i++) {
      if (strengths[i] < 0.8 && Math.abs(resid(times[i])) > 0.18 * P) continue;
      kt.push(times[i]); ks.push(strengths[i]);
    }
    // fill gaps with an evenly spaced grid between neighbouring detections
    const ft: number[] = [], fs: number[] = [];
    for (let i = 0; i < kt.length; i++) {
      ft.push(kt[i]); fs.push(ks[i]);
      if (i + 1 < kt.length) {
        const g = kt[i + 1] - kt[i];
        const n = Math.round(g / P);
        if (n >= 2 && n <= 8 && Math.abs(g / n - P) < 0.15 * P) {
          for (let k = 1; k < n; k++) {
            const tt = kt[i] + (g * k) / n;
            if (tt < durationSec) { ft.push(tt); fs.push(0.3 * Math.min(ks[i], ks[i + 1]) + 0.1); }
          }
        }
      }
    }
    times = ft; strengths = fs;
    // downbeats: count beats along the list, choose the phase (0..3) with the strongest sum
    const num: number[] = [];
    let c = 0;
    for (let i = 0; i < times.length; i++) {
      if (i > 0) c += Math.max(1, Math.round((times[i] - times[i - 1]) / P));
      num.push(c);
    }
    const acc = [0, 0, 0, 0];
    for (let i = 0; i < times.length; i++) acc[num[i] % 4] += strengths[i];
    let ph = 0;
    for (let k = 1; k < 4; k++) if (acc[k] > acc[ph]) ph = k;
    const downbeats = num.map((nn) => nn % 4 === ph);
    return { times, strengths, bpm, downbeats };
  }
  return { times, strengths, bpm, downbeats: times.map((_, i) => i % 4 === 0) };
}

/** Synchronous analysis (fine for tests; use analyzeBeatsAsync in the UI). */
export function analyzeBeats(channelData: Chans, sampleRate: number): BeatMap {
  const chans = asChans(channelData);
  if (!chans.length || !chans[0].length) return { times: [], strengths: [], bpm: null };
  const eb = new EnvBuilder(chans, sampleRate);
  eb.step(eb.nHops);
  const on = onsetFromEnv(eb.low, eb.high);
  return finish(on, eb.nHops * eb.hopSec, eb.hopSec);
}

/** Same result, but yields to the event loop between chunks so the UI never freezes. */
export async function analyzeBeatsAsync(channelData: Chans, sampleRate: number, yieldFn?: () => Promise<void>): Promise<BeatMap> {
  const chans = asChans(channelData);
  if (!chans.length || !chans[0].length) return { times: [], strengths: [], bpm: null };
  const y = yieldFn ?? (() => new Promise<void>((r) => setTimeout(r, 0)));
  const eb = new EnvBuilder(chans, sampleRate);
  const chunk = Math.max(200, Math.round(5 / NOMINAL_HOP_SEC)); // ~5 s of audio per slice
  while (!eb.done) {
    eb.step(chunk);
    await y();
  }
  const on = onsetFromEnv(eb.low, eb.high);
  return finish(on, eb.nHops * eb.hopSec, eb.hopSec);
}

/** Index of the first beat with time >= t (binary search); times.length if none. */
export function nextBeatIndex(times: number[], t: number): number {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (times[m] < t) lo = m + 1; else hi = m;
  }
  return lo;
}
