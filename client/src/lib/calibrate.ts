// Acoustic auto-calibration DSP. Pure TypeScript, DOM-free (unit-tested from server/test/calibrate.test.js).
//
// Method: each device plays a known chirp at an intended server instant; the host mic records on the
// AudioContext clock. For every repeat we cut a search window around the intended arrival, compute the
// normalised cross-correlation (matched filter) against the chirp via FFT, interpolate the peak
// (parabolic) for sub-sample resolution, and use peak-to-sidelobe ratio (PSR) as confidence.
// delay = measured acoustic arrival - intended arrival  (positive = device is LATE).

export const CHIRP_F0 = 2000;
export const CHIRP_F1 = 8000;
export const CHIRP_MS = 100;
export const MIN_PSR = 3.5; // below this a repeat is rejected
export const SEARCH_BEFORE_MS = 200; // window starts this long before the intended arrival
export const SEARCH_AFTER_MS = 1000; // ...and ends this long after (covers slow Bluetooth)

/** Log sweep f0->f1 with a Hann window. */
export function makeChirp(sampleRate: number, f0 = CHIRP_F0, f1 = CHIRP_F1, durMs = CHIRP_MS): Float32Array {
  const n = Math.round((sampleRate * durMs) / 1000);
  const T = n / sampleRate;
  const k = Math.log(f1 / f0);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * f0 * (T / k) * (Math.exp((t / T) * k) - 1);
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    out[i] = Math.sin(phase) * w;
  }
  return out;
}

// ---- FFT (iterative radix-2, in place) ----
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

export interface Peak {
  /** fractional sample index (into the analysed signal) where the chirp starts */
  lag: number;
  /** normalised correlation at the peak (0..1) */
  ncc: number;
  /** peak-to-sidelobe ratio (>= 1) */
  psr: number;
}

/** Normalised cross-correlation of `chirp` against every offset of `sig`. Length = sig.length - chirp.length + 1. */
export function normXcorr(sig: Float32Array, chirp: Float32Array): Float32Array {
  const M = chirp.length, L = sig.length - M + 1;
  if (L <= 0) return new Float32Array(0);
  let N = 1;
  while (N < sig.length + M) N <<= 1;
  const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  for (let i = 0; i < sig.length; i++) ar[i] = sig[i];
  for (let i = 0; i < M; i++) br[i] = chirp[i];
  fft(ar, ai, false); fft(br, bi, false);
  for (let i = 0; i < N; i++) { // A * conj(B)
    const r = ar[i] * br[i] + ai[i] * bi[i], im = ai[i] * br[i] - ar[i] * bi[i];
    ar[i] = r; ai[i] = im;
  }
  fft(ar, ai, true);
  let ce = 0;
  for (let i = 0; i < M; i++) ce += chirp[i] * chirp[i];
  const pre = new Float64Array(sig.length + 1);
  for (let i = 0; i < sig.length; i++) pre[i + 1] = pre[i] + sig[i] * sig[i];
  const out = new Float32Array(L);
  for (let k = 0; k < L; k++) {
    const e = pre[k + M] - pre[k];
    out[k] = e > 1e-12 && ce > 0 ? ar[k] / Math.sqrt(e * ce) : 0;
  }
  return out;
}

/**
 * Find the chirp in `sig`. Picks the EARLIEST local maximum that is >= 70% of the global maximum, so a
 * louder room echo (or another device's overlapping reflection) does not beat the direct sound.
 * `sidelobeExclusionMs` (default 30: direct sound + early reflections) is excluded around the peak when computing PSR, so a legit echo does not count as a sidelobe.
 */
export function findChirp(sig: Float32Array, chirp: Float32Array, sampleRate: number, sidelobeExclusionMs = 30): Peak | null {
  const x = normXcorr(sig, chirp);
  if (x.length < 3) return null;
  let gmax = 0;
  for (let i = 0; i < x.length; i++) if (x[i] > gmax) gmax = x[i];
  if (gmax <= 0) return null;
  let p = -1;
  for (let i = 1; i < x.length - 1; i++) {
    if (x[i] >= 0.7 * gmax && x[i] >= x[i - 1] && x[i] > x[i + 1]) { p = i; break; }
  }
  if (p < 0) return null;
  // parabolic interpolation
  const a = x[p - 1], b = x[p], c = x[p + 1];
  const den = a - 2 * b + c;
  const frac = den !== 0 ? (0.5 * (a - c)) / den : 0;
  const lag = p + Math.max(-0.5, Math.min(0.5, frac));
  const ex = Math.max(2, Math.round((sidelobeExclusionMs / 1000) * sampleRate));
  let side = 0;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(i - p) <= ex) continue;
    const v = Math.abs(x[i]);
    if (v > side) side = v;
  }
  return { lag, ncc: b, psr: side > 1e-9 ? b / side : 1e3 };
}

export interface RepeatMeasure { delayMs: number; psr: number; ncc: number }
export interface DeviceMeasure {
  delayMs: number; // median over accepted repeats
  score: number; // 0..100
  psr: number; // median PSR of accepted repeats
  jitterMs: number; // max |repeat - median|
  used: number; // accepted repeats
  error?: 'low-confidence';
}

/** Measure one repeat. `recStartCtx` = AudioContext time of rec[0]; `intendedCtx` = ideal arrival of chirp sample 0. */
export function measureRepeat(
  rec: Float32Array, sampleRate: number, recStartCtx: number, chirp: Float32Array, intendedCtx: number,
): RepeatMeasure | null {
  const lo = Math.max(0, Math.floor((intendedCtx - SEARCH_BEFORE_MS / 1000 - recStartCtx) * sampleRate));
  const hi = Math.min(rec.length, Math.ceil((intendedCtx + SEARCH_AFTER_MS / 1000 - recStartCtx) * sampleRate) + chirp.length);
  if (hi - lo < chirp.length * 2) return null;
  const pk = findChirp(rec.subarray(lo, hi), chirp, sampleRate);
  if (!pk) return null;
  const arrivalCtx = recStartCtx + (lo + pk.lag) / sampleRate;
  return { delayMs: (arrivalCtx - intendedCtx) * 1000, psr: pk.psr, ncc: pk.ncc };
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Combine repeats: reject low-PSR ones, median delay, score from residual jitter + confidence. */
export function aggregateRepeats(reps: (RepeatMeasure | null)[], minUsed = 2): DeviceMeasure {
  const ok = reps.filter((r): r is RepeatMeasure => !!r && r.psr >= MIN_PSR);
  if (ok.length < minUsed) return { delayMs: 0, score: 0, psr: ok.length ? median(ok.map((r) => r.psr)) : 0, jitterMs: 0, used: ok.length, error: 'low-confidence' };
  const d = median(ok.map((r) => r.delayMs));
  const jitter = Math.max(...ok.map((r) => Math.abs(r.delayMs - d)));
  const psr = median(ok.map((r) => r.psr));
  // 0 ms jitter -> 1, >= 5 ms -> 0 ; PSR 3.5 -> 0, >= 12 -> 1 ; missing repeats cost up to 20 %
  const q = 0.6 * (1 - clamp01(jitter / 5)) + 0.4 * clamp01((psr - MIN_PSR) / (12 - MIN_PSR));
  const score = Math.round(100 * q * (0.8 + 0.2 * (ok.length / Math.max(reps.length, 1))));
  return { delayMs: d, score, psr, jitterMs: jitter, used: ok.length };
}

/** Convenience: measure all repeats of one device's step. */
export function measureDevice(
  rec: Float32Array, sampleRate: number, recStartCtx: number, chirp: Float32Array, intendedCtxTimes: number[],
): DeviceMeasure {
  return aggregateRepeats(intendedCtxTimes.map((t) => measureRepeat(rec, sampleRate, recStartCtx, chirp, t)));
}

/** Trim (ms) that aligns a device with delay `delayMs` to a reference delay. Positive trim = play earlier. */
export const trimFor = (delayMs: number, refDelayMs: number) => delayMs - refDelayMs;
