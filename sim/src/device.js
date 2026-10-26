// One simulated device: real WebSocket to the server, with injected one-way
// latency/jitter on both send and receive, a skewed + drifting local clock, and
// the PROTOCOL.md NTP-style estimator (burst of pings, keep lowest-RTT 30%, median).
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

export const realNow = () => performance.timeOrigin + performance.now(); // epoch-ms float
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
export function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
export const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN;
};

export class SimDevice {
  constructor(i, o) {
    this.name = `sim-${i + 1}`;
    this.deviceId = randomUUID();
    this.o = o;
    // network: per-direction base latency (asymmetry makes the estimator's irreducible error)
    const base = rnd(o.latMin, o.latMax);
    const asym = o.asym * base;
    this.upBase = Math.max(0, base + rnd(-asym, asym));
    this.downBase = Math.max(0, base + rnd(-asym, asym));
    this.jitter = rnd(0, o.jitter);
    // clocks (ppm: positive = runs fast)
    this.skewMs = rnd(-o.skew, o.skew);          // local - server at virtual t=0
    this.clockPpm = rnd(-o.drift, o.drift);      // local clock rate error
    this.audioPpm = rnd(-o.drift, o.drift);      // audio hardware clock rate error
    this.V = 0;                                  // virtual elapsed seconds (for drift)
    this.estOffset = 0;                          // estimated (server - local), ms
    this.rtt = 0;
    this.pending = new Map();
  }
  local() { return realNow() + this.skewMs + this.clockPpm * 1e-3 * this.V; } // ppm*1e-6*V s*1000 ms
  trueOffset(V = this.V) { return -(this.skewMs + this.clockPpm * 1e-3 * V); } // server - local
  estErr(V = this.V) { return this.estOffset - this.trueOffset(V); }
  delay(base) { return base + Math.random() * this.jitter; }

  async connect(url) {
    this.ws = new WebSocket(url);
    // receive-side latency injection
    this.ws.on('message', (raw) => {
      const d = this.delay(this.downBase);
      setTimeout(() => this.onMsg(raw), d);
    });
    await new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
  }
  // send-side latency injection
  send(msg) { setTimeout(() => this.ws.readyState === 1 && this.ws.send(JSON.stringify(msg)), this.delay(this.upBase)); }
  onMsg(raw) {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'pong') {
      const t3 = this.local();
      const p = this.pending.get(m.t0);
      if (p) { this.pending.delete(m.t0); p({ t0: m.t0, t1: m.t1, t2: m.t2, t3 }); }
    } else if (m.type === 'joined') this.joined = m;
    else if (m.type === 'state') this.lastState = m;
    else if (m.type === 'error') this.lastError = m.message;
  }
  join(roomId) { this.send({ type: 'join', roomId, name: this.name, deviceId: this.deviceId }); }
  ping() {
    return new Promise((res) => {
      const t0 = this.local() + Math.random() * 1e-3; // unique key
      const to = setTimeout(() => { this.pending.delete(t0); res(null); }, 3000);
      this.pending.set(t0, (s) => { clearTimeout(to); res(s); });
      this.send({ type: 'ping', t0 });
    });
  }
  // PROTOCOL: n pings ~40ms apart, keep lowest-RTT 30%, median offset
  async sync(n) {
    const samples = [];
    for (let i = 0; i < n; i++) {
      this.ping().then((s) => {
        if (!s) return;
        samples.push({
          off: ((s.t1 - s.t0) + (s.t2 - s.t3)) / 2,
          rtt: (s.t3 - s.t0) - (s.t2 - s.t1),
        });
      });
      await sleep(40);
    }
    await sleep(this.upBase + this.downBase + 2 * this.jitter + 50); // let stragglers land
    if (!samples.length) return false;
    samples.sort((a, b) => a.rtt - b.rtt);
    const keep = samples.slice(0, Math.max(1, Math.ceil(samples.length * 0.3)));
    this.estOffset = median(keep.map((s) => s.off));
    this.rtt = keep[0].rtt;
    return true;
  }
  close() { try { this.ws.close(); } catch {} }
}
