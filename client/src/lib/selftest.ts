// Pure-function tests. Run:
//   npx tsc client/src/lib/selftest.ts --outDir $TMP --module esnext --moduleResolution bundler --target es2022 --lib es2022,dom && echo '{"type":"module"}' > $TMP/package.json && node $TMP/selftest.js
import { computeSample, estimateOffset, median, stddev, type ClockSample } from './clock.js';
import { planStart, decideDrift, expectedPositionMs, channelMatrix, BeatDetector } from './engine.js';

let fails = 0;
function eq(name: string, ok: boolean, info?: unknown) {
  if (!ok) { fails++; console.log('FAIL', name, info ?? ''); } else console.log('ok  ', name);
}
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) <= e;

// NTP sample: server is +500ms ahead, 20ms each way, 1ms server processing
{
  const t0 = 1000, t1 = 1000 + 20 + 500, t2 = t1 + 1, t3 = t2 - 500 + 20;
  const s = computeSample(t0, t1, t2, t3);
  eq('offset', near(s.offset, 500), s);
  eq('rtt', near(s.rtt, 40), s);
}
eq('median odd/even', median([3, 1, 2]) === 2 && median([1, 2, 3, 4]) === 2.5);
eq('stddev', near(stddev([2, 4, 4, 4, 5, 5, 7, 9]), 2));
{
  // 20 samples: low-RTT ones have true offset 100, high-RTT ones are skewed by asymmetric jitter
  const xs: ClockSample[] = [];
  for (let i = 0; i < 20; i++) xs.push(i < 6 ? { offset: 100 + (i % 2 ? 0.2 : -0.2), rtt: 10 + i * 0.1 } : { offset: 100 + 30 + i, rtt: 60 + i });
  const e = estimateOffset(xs)!;
  eq('min-rtt filter rejects jitter', Math.abs(e.offset - 100) < 0.5, e);
  eq('empty', estimateOffset([]) === null);
}
{
  // future start
  const p = planStart({ ctxNow: 10, serverNow: 5000, S: 6500, outputLatencyMs: 20, trimMs: 5, durationSec: 100 })!;
  eq('future: when', near(p.when, 10 + 1.5 - 0.02 - 0.005) && p.offsetSec === 0, p);
  // late join: 30 s in
  const q = planStart({ ctxNow: 10, serverNow: 35000, S: 5000, outputLatencyMs: 0, trimMs: 0, durationSec: 100, leadSec: 0.03 })!;
  eq('late join', near(q.when, 10.03) && near(q.offsetSec, 30.03), q);
  eq('past end', planStart({ ctxNow: 0, serverNow: 1e6, S: 0, outputLatencyMs: 0, trimMs: 0, durationSec: 10 }) === null);
}
eq('expected pos', expectedPositionMs(7000, 5000, 20, -5) === 2015);
{
  eq('none', decideDrift(0.1).action === 'none');
  const n = decideDrift(10);
  eq('nudge ahead slows', n.action === 'nudge' && n.rate < 1 && near(n.rate, 0.995), n);
  eq('nudge behind speeds', decideDrift(-3).rate > 1 && decideDrift(-3).rate <= 1.005);
  eq('reseek', decideDrift(-40).action === 'reseek' && decideDrift(55).action === 'reseek');
  eq('clamp', near(decideDrift(39).rate, 1 - 0.005));
}
eq('channels', channelMatrix('left')[1] === 0 && channelMatrix('right')[0] === 0 && channelMatrix('stereo')[3] === 1);
{
  const d = new BeatDetector();
  let beats = 0;
  for (let t = 0; t < 8000; t += 16) {
    const phase = (t % 500) / 500; // 120 bpm kicks
    const e = 0.15 + (phase < 0.1 ? 0.7 : 0);
    if (d.update(e, t)) beats++;
  }
  eq('beat detector ~16 beats', beats >= 12 && beats <= 17, beats);
  const flat = new BeatDetector();
  let fb = 0;
  for (let t = 0; t < 4000; t += 16) if (flat.update(0.3, t)) fb++;
  eq('no beats on flat signal', fb === 0, fb);
}
if (fails) { console.log(fails + ' failed'); process.exit(1); }
console.log('all passed');
