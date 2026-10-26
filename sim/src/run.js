#!/usr/bin/env node
// SyncWave sim harness. See README.md ("Simulator").
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SimDevice, median, gauss } from './device.js';

const HELP = `Usage: npm run sim -- [options]
  --devices N        simulated devices (default 5)
  --duration S       simulated seconds (default 600)
  --jitter MS        max per-packet jitter, per-device uniform(0,MS) (default 10)
  --latency-min MS   min one-way base latency (default 5)
  --latency-max MS   max one-way base latency (default 40)
  --asym F           up/down asymmetry fraction of base latency (default 0.1)
  --skew MS          max initial clock skew +-MS (default 5000)
  --drift PPM        max clock + audio drift +-PPM (default 50)
  --server-url URL   server base URL (default: spawn ../server on a free port)
  --realtime         wait real time instead of compressing sim time
  --max-median MS (10)  --max-worst MS (20)   pass thresholds
`;
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
if (args.includes('--help') || args.includes('-h')) { console.log(HELP); process.exit(0); }
const cfg = {
  devices: +opt('devices', 5), duration: +opt('duration', 600), jitter: +opt('jitter', 10),
  latMin: +opt('latency-min', 5), latMax: +opt('latency-max', 40), asym: +opt('asym', 0.1),
  skew: +opt('skew', 5000), drift: +opt('drift', 50),
  maxMedian: +opt('max-median', 10), maxWorst: +opt('max-worst', 20),
  realtime: args.includes('--realtime'),
};
let serverUrl = opt('server-url', null);
let child = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function reachable(base) {
  try { const r = await fetch(base + '/api/rooms/PROBE', { signal: AbortSignal.timeout(1000) }); return r.status < 500; }
  catch { return false; }
}
async function waitFor(base, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await reachable(base)) return true; await sleep(250); }
  return false;
}
function cleanup() { if (child) { child.kill(); child = null; } }
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

async function main() {
  if (!serverUrl) {
    const port = 3100 + Math.floor(Math.random() * 800);
    const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server/src/index.js');
    child = spawn(process.execPath, [entry], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'inherit', 'inherit'] });
    serverUrl = `http://localhost:${port}`;
    console.log(`spawned server (pid ${child.pid}) at ${serverUrl}`);
  }
  serverUrl = serverUrl.replace(/\/$/, '');
  if (!(await waitFor(serverUrl))) { console.error(`server not reachable at ${serverUrl}`); return 2; }
  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws';

  const rres = await fetch(serverUrl + '/api/rooms', { method: 'POST' });
  const { roomId } = await rres.json();
  console.log(`room ${roomId}; ${cfg.devices} devices, ${cfg.duration}s sim, latency ${cfg.latMin}-${cfg.latMax}ms, jitter 0-${cfg.jitter}ms, skew +-${cfg.skew}ms, drift +-${cfg.drift}ppm`);

  const devs = Array.from({ length: cfg.devices }, (_, i) => new SimDevice(i, cfg));
  await Promise.all(devs.map((d) => d.connect(wsUrl)));
  devs.forEach((d) => d.join(roomId));

  // initial 20-ping burst
  await Promise.all(devs.map((d) => d.sync(20)));

  // scheduled start: each device starts when its *estimated* server clock hits S, so
  // start error = estimation error + scheduling jitter (audio clock scheduling, ~1ms sd).
  const STEP = 0.1, SAMPLE = 1, CHECK = 2, RESYNC = 3;
  for (const d of devs) { d.err = d.estErr(0) + gauss() * 1; d.adj = 0; d.nextCheck = CHECK; d.errs = []; d.estErrs = []; d.restarts = 0; }
  const samples = []; // per sample: array of per-device err
  let t = 0, nextSample = SAMPLE, nextResync = RESYNC;
  const lastErrs = devs.map(() => 0);
  while (t < cfg.duration - 1e-9) {
    t = Math.round((t + STEP) * 1e6) / 1e6;
    for (const d of devs) {
      d.V = t;
      // audio clock drift (ms per s = ppm/1000) plus rate nudge (adj fraction -> *1000 ms/s)
      d.err += (d.audioPpm / 1000 + d.adj * 1000) * STEP;
      if (t >= d.nextCheck - 1e-9) {
        d.nextCheck += CHECK;
        // device measures expected-vs-actual using its own (imperfect) clock estimate
        // perceived error = audio vs the device's own belief of ideal; the residual
        // clock-estimate error therefore stays in the true error (it cannot be seen).
        const seen = d.err - d.estErr(t) + (Math.random() - 0.5) * 1;
        if (Math.abs(seen) >= 40) {
          d.err = d.estErr(t) + gauss() * 1; d.adj = 0; d.restarts++;
        } else {
          d.adj = Math.max(-0.005, Math.min(0.005, -seen / 2000));
        }
      }
    }
    if (t >= nextSample - 1e-9) {
      nextSample += SAMPLE;
      samples.push(devs.map((d) => d.err));
      devs.forEach((d) => d.estErrs.push(d.estErr(t)));
    }
    if (t >= nextResync - 1e-9) {
      nextResync += RESYNC;
      if (cfg.realtime) await sleep(RESYNC * 1000);
      await Promise.all(devs.map((d) => d.sync(8)));
      devs.forEach((d) => d.send({ type: 'report', offsetMs: d.err, driftMs: d.err, rtt: d.rtt }));
    }
  }
  await sleep(300);

  // ---- results ----
  const abs = samples.flat().map(Math.abs);
  const med = median(abs), worst = Math.max(...abs);
  const spread = samples.map((s) => Math.max(...s) - Math.min(...s));
  const estAbs = devs.flatMap((d) => d.estErrs.map(Math.abs));
  const lastMin = samples.slice(-60).flat().map(Math.abs);
  console.log('\nper device:');
  console.log('  dev      lat(up/down)  jit  skew(ms)  clk/aud ppm   clk-est err med/worst   sync err med/worst  restarts');
  devs.forEach((d, i) => {
    const a = samples.map((s) => Math.abs(s[i]));
    const e = d.estErrs.map(Math.abs);
    console.log(`  ${d.name.padEnd(7)} ${d.upBase.toFixed(0).padStart(4)}/${d.downBase.toFixed(0).padEnd(4)} ${d.jitter.toFixed(0).padStart(5)} ${d.skewMs.toFixed(0).padStart(8)} ${d.clockPpm.toFixed(0).padStart(6)}/${d.audioPpm.toFixed(0).padEnd(6)}  ${median(e).toFixed(2).padStart(8)}/${Math.max(...e).toFixed(2).padEnd(8)}  ${median(a).toFixed(2).padStart(8)}/${Math.max(...a).toFixed(2).padEnd(8)} ${d.restarts}`);
  });
  const st = await fetch(`${serverUrl}/api/rooms/${roomId}`).then((r) => r.json()).catch(() => ({}));
  const seenByServer = devs[0].lastState?.devices?.length;
  console.log(`\nclock estimate error  median ${median(estAbs).toFixed(2)} ms  worst ${Math.max(...estAbs).toFixed(2)} ms`);
  console.log(`inter-device spread   median ${median(spread).toFixed(2)} ms  worst ${Math.max(...spread).toFixed(2)} ms (max-min across devices)`);
  console.log(`last 60s              median ${median(lastMin).toFixed(2)} ms  worst ${Math.max(...lastMin).toFixed(2)} ms`);
  console.log(`server: room exists=${st.exists}, devices in last state=${seenByServer ?? 'n/a'}/${cfg.devices}`);
  const okM = med < cfg.maxMedian, okW = worst < cfg.maxWorst;
  console.log(`\nOFFSET vs ideal       median ${med.toFixed(2)} ms (target <${cfg.maxMedian}) ${okM ? 'PASS' : 'FAIL'}   worst ${worst.toFixed(2)} ms (target <${cfg.maxWorst}) ${okW ? 'PASS' : 'FAIL'}`);
  devs.forEach((d) => d.close());
  return okM && okW ? 0 : 1;
}
main().then((c) => { cleanup(); process.exit(c); }).catch((e) => { console.error(e); cleanup(); process.exit(2); });
